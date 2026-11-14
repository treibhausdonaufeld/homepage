/**
 * Buchungslogik: Anfragen, Verifizierung, Freigabe, Storno, Haltefrist, Löschung.
 * Kennt weder Astro noch Matrix – Benachrichtigungen laufen über das Notifier-Interface.
 */
import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { config } from '../config';
import type { DB } from '../db';
import {
  auditLog,
  blocks,
  bookings,
  rooms,
  series,
  slots,
  trustedContacts,
  verifications,
  type Booking,
  type BookingKind,
  type Room,
} from '../db/schema';
import { bookingIcs } from '../ical';
import { externalEventsBetween, roomsForLocation } from '../calendars';
import { createHash } from 'node:crypto';
import { log } from '../log';
import { DAY, HOUR, MINUTE, addDays, dayStart, overlaps, parseLocal } from '../time';
import {
  codeHash,
  contactHash,
  manageToken,
  manageTokenHash,
  normalizeContact,
  publicId as newPublicId,
  randomCode,
  randomToken,
  tokenHash,
} from '../verify/tokens';
import { hit } from '../verify/ratelimit';
import { expandAll, expandRule, type Interval } from './recurrence';
import {
  BLOCKING_STATUSES,
  BookingError,
  ConflictError,
  KIND_LABEL,
  type AdminMessage,
  type BookingView,
  type CandidateSlot,
  type Conflict,
  type Notifier,
  type PublicEvent,
  type Segment,
} from './types';

type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];
type Q = DB | Tx;

// ---------------------------------------------------------------- Cache

let version = 0;
const cache = new Map<string, { v: number; at: number; value: unknown }>();
/** Ergebnisse höchstens 60 s und nur bis zur nächsten Änderung zwischenspeichern. */
function cached<T>(key: string, fn: () => T, ttlMs = 60_000): T {
  const hitv = cache.get(key);
  if (hitv && hitv.v === version && Date.now() - hitv.at < ttlMs) return hitv.value as T;
  const value = fn();
  cache.set(key, { v: version, at: Date.now(), value });
  if (cache.size > 500) cache.clear();
  return value;
}
export function invalidate() {
  version++;
}

// ---------------------------------------------------------------- Räume

export function listRooms(db: Q, onlyBookable = false): Room[] {
  const all = db.select().from(rooms).orderBy(asc(rooms.sortOrder)).all();
  return onlyBookable ? all.filter((r) => r.bookable) : all;
}

export function getRoom(db: Q, slug: string): Room | undefined {
  return db.select().from(rooms).where(eq(rooms.slug, slug)).get();
}

/** Physische Räume, die ein (ggf. kombinierter) Raum belegt. */
export function physicalRooms(db: Q, room: Room): Room[] {
  if (!room.combines?.length) return [room];
  return room.combines.map((s) => getRoom(db, s)).filter((r): r is Room => !!r);
}

// ---------------------------------------------------------------- Slots & Konflikte

export function buildCandidates(db: Q, room: Room, occurrences: Interval[]): CandidateSlot[] {
  const phys = physicalRooms(db, room);
  const out: CandidateSlot[] = [];
  occurrences.forEach((o, i) => {
    for (const p of phys) {
      out.push({
        roomSlug: p.slug,
        start: o.start,
        end: o.end,
        endWithBuffer: new Date(o.end.getTime() + p.bufferMinutes * MINUTE),
        occurrence: i,
      });
    }
  });
  return out;
}

export interface BlockInterval {
  /** Sperrzeit-ID; bei Kalenderterminen negativ (−ID des Vorkommens). */
  blockId: number;
  roomSlug: string | null;
  start: Date;
  end: Date;
  /** Ende inkl. Pufferzeit des Raums (nur bei Kalenderterminen länger als end). */
  bufferEnd: Date;
  /** Für Gäste sichtbarer Grund. */
  reason: string;
  /** Für die Raum-AG (bei Kalenderterminen mit Titel und Kalender). */
  detail: string;
  kind: 'block' | 'event';
}

/**
 * Sperrzeiten (aufgelöst) für einen Raum im Zeitraum – inklusive Terminen aus abonnierten
 * Kalendern, deren Ort zu diesem Raum passt.
 */
export function blockIntervals(db: Q, roomSlug: string | null, from: Date, to: Date): BlockInterval[] {
  const rows = db
    .select()
    .from(blocks)
    .where(
      and(
        roomSlug ? or(isNull(blocks.roomSlug), eq(blocks.roomSlug, roomSlug)) : sql`1=1`,
        lt(blocks.start, to),
        or(isNull(blocks.rule), isNull(blocks.until), gt(blocks.until, from)),
      ),
    )
    .all();
  const out: BlockInterval[] = [];
  for (const b of rows) {
    if (!b.rule && !(b.end > from)) continue;
    for (const iv of expandRule({ start: b.start, end: b.end }, b.rule, from, to, b.until)) {
      out.push({ blockId: b.id, roomSlug: b.roomSlug, start: iv.start, end: iv.end, bufferEnd: iv.end, reason: b.reason, detail: b.reason, kind: 'block' });
    }
  }
  const room = roomSlug ? getRoom(db, roomSlug) : undefined;
  if (room && !room.combines?.length) {
    const buffer = room.bufferMinutes * MINUTE;
    for (const e of externalEventsBetween(db, new Date(from.getTime() - buffer), to, { blockRooms: true })) {
      if (!roomsForLocation(e.location, [room]).length) continue;
      out.push({
        blockId: -e.id,
        roomSlug: room.slug,
        start: e.start,
        end: e.end,
        bufferEnd: new Date(e.end.getTime() + buffer),
        // Titel nur bei öffentlichen Kalendern zeigen
        reason: e.showPublic ? `Termin: ${e.title}` : 'Termin im Haus',
        detail: `${e.title} (Kalender: ${e.label})`,
        kind: 'event',
      });
    }
  }
  return out;
}

/** Prüft Kandidaten gegen vorläufige/bestätigte Slots und Sperrzeiten. */
export function findConflicts(
  db: Q,
  candidates: CandidateSlot[],
  opts: { excludeBookingId?: number; ignoreBlocks?: boolean } = {},
): Conflict[] {
  if (!candidates.length) return [];
  const conflicts: Conflict[] = [];
  const minStart = new Date(Math.min(...candidates.map((c) => c.start.getTime())) - DAY);
  const maxEnd = new Date(Math.max(...candidates.map((c) => c.endWithBuffer.getTime())) + DAY);
  const roomSlugs = [...new Set(candidates.map((c) => c.roomSlug))];

  const existing = db
    .select({
      bookingId: slots.bookingId,
      roomSlug: slots.roomSlug,
      start: slots.start,
      end: slots.end,
      endWithBuffer: slots.endWithBuffer,
      status: bookings.status,
    })
    .from(slots)
    .innerJoin(bookings, eq(bookings.id, slots.bookingId))
    .where(
      and(
        inArray(slots.roomSlug, roomSlugs),
        inArray(bookings.status, BLOCKING_STATUSES),
        eq(slots.skipped, false),
        lt(slots.start, maxEnd),
        gt(slots.endWithBuffer, minStart),
      ),
    )
    .all();

  const blockMap = new Map<string, ReturnType<typeof blockIntervals>>();
  if (!opts.ignoreBlocks) {
    for (const r of roomSlugs) blockMap.set(r, blockIntervals(db, r, minStart, maxEnd));
  }

  for (const c of candidates) {
    for (const e of existing) {
      if (e.bookingId === opts.excludeBookingId) continue;
      if (e.roomSlug !== c.roomSlug) continue;
      if (overlaps(c.start.getTime(), c.endWithBuffer.getTime(), e.start.getTime(), e.endWithBuffer.getTime())) {
        conflicts.push({
          occurrence: c.occurrence,
          roomSlug: c.roomSlug,
          start: e.start,
          end: e.end,
          type: 'booking',
          bookingId: e.bookingId,
          status: e.status,
        });
      }
    }
    for (const b of blockMap.get(c.roomSlug) ?? []) {
      // Sperrzeiten betreffen die eigentliche Nutzung, nicht die Reinigung danach.
      // Kalendertermine zählen wie Buchungen: mit Pufferzeit auf beiden Seiten.
      const hit =
        b.kind === 'event'
          ? overlaps(c.start.getTime(), c.endWithBuffer.getTime(), b.start.getTime(), b.bufferEnd.getTime())
          : overlaps(c.start.getTime(), c.end.getTime(), b.start.getTime(), b.end.getTime());
      if (hit) {
        conflicts.push({
          occurrence: c.occurrence,
          roomSlug: c.roomSlug,
          start: b.start,
          end: b.end,
          type: 'block',
          reason: b.reason,
        });
      }
    }
  }
  return conflicts;
}

// ---------------------------------------------------------------- Verfügbarkeit (öffentlich)

const STATE_RANK = { frei: 0, angefragt: 1, belegt: 2, gesperrt: 3 } as const;

/**
 * Belegte Zeiten eines Raums (inkl. kombinierter Räume) als anonyme Segmente.
 * Die Reinigungszeit danach zählt als „belegt“, damit niemand in sie hineinbucht.
 */
export function occupancy(db: Q, room: Room, from: Date, to: Date): Segment[] {
  const phys = physicalRooms(db, room).map((r) => r.slug);
  const rows = db
    .select({ start: slots.start, endWithBuffer: slots.endWithBuffer, status: bookings.status })
    .from(slots)
    .innerJoin(bookings, eq(bookings.id, slots.bookingId))
    .where(
      and(
        inArray(slots.roomSlug, phys),
        inArray(bookings.status, BLOCKING_STATUSES),
        eq(slots.skipped, false),
        lt(slots.start, to),
        gt(slots.endWithBuffer, from),
      ),
    )
    .all();
  const segs: Segment[] = rows.map((r) => ({
    start: r.start,
    end: r.endWithBuffer,
    state: r.status === 'bestaetigt' ? 'belegt' : 'angefragt',
  }));
  for (const p of phys) {
    for (const b of blockIntervals(db, p, from, to)) {
      // Kalendertermine erscheinen wie Buchungen als „belegt“ (inkl. Reinigung danach).
      segs.push(b.kind === 'event' ? { start: b.start, end: b.bufferEnd, state: 'belegt' } : { start: b.start, end: b.end, state: 'gesperrt' });
    }
  }
  return segs;
}

/** Tageszeitleiste von dayStartHour bis dayEndHour mit frei/angefragt/belegt/gesperrt. */
export function dayTimeline(db: Q, room: Room, date: string): Segment[] {
  const from = parseLocal(date, `${String(config.booking.dayStartHour).padStart(2, '0')}:00`)!;
  const to = parseLocal(date, `${String(config.booking.dayEndHour).padStart(2, '0')}:00`)!;
  return timeline(occupancy(db, room, from, to), from, to);
}

/** Überlappende Segmente zu einer lückenlosen Zeitleiste zusammenführen (stärkster Zustand gewinnt). */
export function timeline(segs: Segment[], from: Date, to: Date): Segment[] {
  const cuts = new Set<number>([from.getTime(), to.getTime()]);
  for (const s of segs) {
    if (s.start > from && s.start < to) cuts.add(s.start.getTime());
    if (s.end > from && s.end < to) cuts.add(s.end.getTime());
  }
  const points = [...cuts].sort((a, b) => a - b);
  const out: Segment[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    let state: Segment['state'] = 'frei';
    for (const s of segs) {
      if (overlaps(a, b, s.start.getTime(), s.end.getTime()) && STATE_RANK[s.state] > STATE_RANK[state]) state = s.state;
    }
    const last = out[out.length - 1];
    if (last && last.state === state) last.end = new Date(b);
    else out.push({ start: new Date(a), end: new Date(b), state });
  }
  return out;
}

/** Freie Zeiten an einem Tag (für „Freie Zeiten am selben Tag“). */
export function freeRanges(db: Q, room: Room, date: string, minMinutes = 60): Segment[] {
  return dayTimeline(db, room, date).filter(
    (s) => s.state === 'frei' && s.end.getTime() - s.start.getTime() >= minMinutes * MINUTE,
  );
}

// ---------------------------------------------------------------- Lesen

export function bookingView(db: Q, booking: Booking): BookingView {
  const room = getRoom(db, booking.roomSlug)!;
  const s = db.select().from(slots).where(eq(slots.bookingId, booking.id)).orderBy(asc(slots.start)).all();
  const ser = db.select().from(series).where(eq(series.bookingId, booking.id)).get();
  const seen = new Map<number, { start: Date; end: Date; skipped: boolean }>();
  for (const sl of s) {
    const k = sl.start.getTime();
    const prev = seen.get(k);
    if (!prev) seen.set(k, { start: sl.start, end: sl.end, skipped: sl.skipped });
    else prev.skipped = prev.skipped || sl.skipped;
  }
  const all = [...seen.values()].sort((a, b) => a.start.getTime() - b.start.getTime());
  return {
    booking,
    room,
    slots: s,
    occurrences: all.filter((o) => !o.skipped).map(({ start, end }) => ({ start, end })),
    skipped: all.filter((o) => o.skipped).map(({ start, end }) => ({ start, end })),
    seriesRule: ser?.rule ?? null,
    seriesUntil: ser?.until ?? null,
  };
}

export function getBooking(db: Q, id: number): Booking | undefined {
  return db.select().from(bookings).where(eq(bookings.id, id)).get();
}
export function getBookingByPublicId(db: Q, pid: string): Booking | undefined {
  return db.select().from(bookings).where(eq(bookings.publicId, pid)).get();
}
export function getBookingByManageToken(db: Q, token: string): Booking | undefined {
  if (!token || token.length > 100) return undefined;
  return db.select().from(bookings).where(eq(bookings.manageTokenHash, manageTokenHash(token))).get();
}

export function manageUrl(b: Booking): string {
  return `${config.publicUrl}/b/${manageToken(b.publicId)}`;
}

/** Öffentliche Termine: bestätigte Buchungen mit „Offen für alle“. */
export function publicEvents(db: Q, from: Date, to: Date, limit = 500): PublicEvent[] {
  return cached(`events:${from.getTime()}:${to.getTime()}:${limit}`, () => {
    const rows = db
      .select({
        bookingId: bookings.id,
        publicId: bookings.publicId,
        purpose: bookings.purpose,
        category: bookings.category,
        offer: bookings.offer,
        roomSlug: bookings.roomSlug,
        roomName: rooms.name,
        start: slots.start,
        end: slots.end,
      })
      .from(slots)
      .innerJoin(bookings, eq(bookings.id, slots.bookingId))
      .innerJoin(rooms, eq(rooms.slug, bookings.roomSlug))
      .where(
        and(
          eq(bookings.status, 'bestaetigt'),
          eq(bookings.isPublic, true),
          eq(slots.skipped, false),
          lt(slots.start, to),
          gt(slots.end, from),
        ),
      )
      .orderBy(asc(slots.start))
      .all();
    const seen = new Set<string>();
    const out: PublicEvent[] = [];
    // Termine aus öffentlichen Kalender-Abos
    const physRooms = db.select().from(rooms).all();
    for (const e of externalEventsBetween(db, from, to, { showPublic: true })) {
      const matched = roomsForLocation(e.location, physRooms);
      const uidHash = createHash('sha1').update(`${e.subscriptionId}:${e.uid}`).digest('hex').slice(0, 12);
      out.push({
        key: `k${uidHash}-${e.start.getTime()}`,
        bookingId: null,
        title: e.title,
        roomSlug: matched[0]?.slug ?? '',
        roomName: matched.length ? matched.map((r) => r.name).join(' + ') : (e.location ?? ''),
        start: e.start,
        end: e.end,
        category: null,
        offer: null,
        allDay: e.allDay,
      });
    }
    for (const r of rows) {
      const key = `${r.publicId}-${r.start.getTime()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        key,
        bookingId: r.bookingId,
        title: r.purpose ?? 'Veranstaltung',
        roomSlug: r.roomSlug,
        roomName: r.roomName,
        start: r.start,
        end: r.end,
        category: r.category,
        offer: r.offer,
      });
    }
    out.sort((a, b) => a.start.getTime() - b.start.getTime());
    return out.slice(0, limit);
  });
}

export function upcomingEvents(db: Q, limit = 5): PublicEvent[] {
  const now = new Date();
  return publicEvents(db, new Date(Math.floor(now.getTime() / MINUTE) * MINUTE), new Date(now.getTime() + 120 * DAY), limit);
}

// ---------------------------------------------------------------- Audit

export function audit(db: Q, actor: string, action: string, bookingId: number | null, details?: string) {
  db.insert(auditLog).values({ actor, action, bookingId, details: details ?? null }).run();
}

// ---------------------------------------------------------------- Anfrage

export interface RequestInput {
  roomSlug: string;
  start: Date;
  end: Date;
  /** RRULE (z. B. FREQ=WEEKLY) für Serien */
  seriesRule?: string | null;
  seriesUntil?: Date | null;
  name: string;
  purpose: string;
  persons: number;
  kind: Exclude<BookingKind, 'intern'>;
  isPublic: boolean;
  channel: 'email' | 'matrix';
  address: string;
}

/** Fachliche Prüfung einer Zeitwahl. Gibt Fehlermeldungen pro Feld zurück. */
export function checkTime(room: Room | undefined, start: Date | null, end: Date | null): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!room || !room.bookable) errors.raum = 'Bitte wähl einen Raum.';
  if (!start || !end) {
    errors.zeit = 'Bitte wähl Datum, Beginn und Ende.';
    return errors;
  }
  const now = Date.now();
  if (end <= start) errors.zeit = 'Das Ende muss nach dem Beginn liegen.';
  else if (start.getTime() < now) errors.zeit = 'Dieser Zeitpunkt liegt in der Vergangenheit.';
  else if (start.getTime() > now + config.booking.maxAdvanceDays * DAY)
    errors.zeit = `Du kannst höchstens ${config.booking.maxAdvanceDays} Tage im Voraus anfragen.`;
  else if (end.getTime() - start.getTime() > 16 * HOUR) errors.zeit = 'Eine Buchung dauert höchstens 16 Stunden.';
  return errors;
}

export function seriesOccurrences(start: Date, end: Date, rule?: string | null, until?: Date | null): Interval[] {
  if (!rule || !until) return [{ start, end }];
  const maxUntil = new Date(start.getTime() + config.booking.seriesMaxWeeks * 7 * DAY);
  const u = until > maxUntil ? maxUntil : until;
  return expandAll({ start, end }, rule, u);
}

/**
 * Legt eine Anfrage an (Status „unbestätigt“, blockiert noch nichts).
 * Prüft trotzdem schon auf Konflikte, damit niemand umsonst einen Code anfordert.
 */
export function createRequest(db: DB, input: RequestInput, ctx: { ip?: string } = {}): Booking {
  const room = getRoom(db, input.roomSlug);
  const errs = checkTime(room, input.start, input.end);
  if (Object.keys(errs).length) throw new BookingError('invalid', Object.values(errs)[0], { errors: errs });
  if (input.persons > room!.capacity)
    throw new BookingError('capacity', `Der Raum hat Platz für ca. ${room!.capacity} Personen.`);

  const address = normalizeContact(input.channel, input.address);
  const cHash = contactHash(input.channel, address);
  if (ctx.ip && !hit(db, `ip:${ctx.ip}`, config.rateLimit.requestsPerIpPerHour, 3600))
    throw new BookingError('rate-limit', 'Zu viele Anfragen. Bitte versuch es später noch einmal.');
  if (!hit(db, `contact:${cHash}`, config.rateLimit.requestsPerContactPerDay, 86400))
    throw new BookingError('rate-limit', 'Zu viele Anfragen für diese Adresse. Bitte versuch es morgen noch einmal.');

  const occurrences = seriesOccurrences(input.start, input.end, input.seriesRule, input.seriesUntil);
  const candidates = buildCandidates(db, room!, occurrences);

  const booking = db.transaction(
    (tx) => {
      const conflicts = findConflicts(tx, candidates);
      const firstConflicts = conflicts.filter((c) => c.occurrence === 0);
      if (firstConflicts.length) throw new ConflictError(firstConflicts);
      const skippedOcc = new Set(conflicts.map((c) => c.occurrence));

      const b = tx
        .insert(bookings)
        .values({
          publicId: newPublicId(),
          status: 'unbestaetigt',
          roomSlug: room!.slug,
          purpose: input.purpose,
          kind: input.kind,
          persons: input.persons,
          isPublic: input.isPublic,
          name: input.name,
          contactChannel: input.channel,
          contactAddress: address,
          contactHash: cHash,
          rulesAcceptedAt: new Date(),
        })
        .returning()
        .get();
      insertSlots(tx, b.id, candidates, skippedOcc);
      if (input.seriesRule && input.seriesUntil && occurrences.length > 1) {
        tx.insert(series)
          .values({ bookingId: b.id, rule: input.seriesRule, until: occurrences[occurrences.length - 1].start })
          .run();
      }
      audit(tx, 'System', 'angefragt', b.id, `${occurrences.length} Termin(e)`);
      return b;
    },
    { behavior: 'immediate' },
  );
  return booking;
}

function insertSlots(tx: Q, bookingId: number, candidates: CandidateSlot[], skipped: Set<number>) {
  if (!candidates.length) return;
  tx.insert(slots)
    .values(
      candidates.map((c) => ({
        bookingId,
        roomSlug: c.roomSlug,
        start: c.start,
        end: c.end,
        endWithBuffer: c.endWithBuffer,
        skipped: skipped.has(c.occurrence),
      })),
    )
    .run();
}

// ---------------------------------------------------------------- Verifizierung

export async function sendVerification(db: DB, notifier: Notifier, booking: Booking): Promise<void> {
  if (booking.status !== 'unbestaetigt') throw new BookingError('state', 'Diese Anfrage ist schon bestätigt.');
  if (booking.contactChannel === 'intern') throw new BookingError('state', 'Interne Buchung');
  if (!hit(db, `send:${booking.id}`, config.rateLimit.codeSendsPerBooking, 86400))
    throw new BookingError('rate-limit', 'Wir haben schon mehrere Codes geschickt. Bitte warte etwas oder schreib uns.');

  const code = randomCode();
  const token = randomToken();
  const key = `${booking.publicId}:${token.slice(0, 8)}`;
  // Frühere Codes ungültig machen
  db.update(verifications)
    .set({ expiresAt: new Date() })
    .where(and(eq(verifications.bookingId, booking.id), isNull(verifications.confirmedAt)))
    .run();
  const v = db
    .insert(verifications)
    .values({
      bookingId: booking.id,
      channel: booking.contactChannel as 'email' | 'matrix',
      // Schlüssel|Hash – der Klartext-Code wird nie gespeichert
      codeHash: `${key}|${codeHash(key, code)}`,
      tokenHash: tokenHash(token),
      expiresAt: new Date(Date.now() + config.booking.codeTtlMinutes * MINUTE),
    })
    .returning()
    .get();

  const link = `${config.publicUrl}/buchen/bestaetigen?t=${encodeURIComponent(token)}`;
  try {
    await notifier.sendCode(bookingView(db, booking), code, link);
    audit(db, 'System', 'code-gesendet', booking.id, booking.contactChannel);
  } catch (err) {
    db.delete(verifications).where(eq(verifications.id, v.id)).run();
    if (err instanceof BookingError) throw err;
    log.error('Code konnte nicht gesendet werden', { err, bookingId: booking.id });
    throw new BookingError('send-failed', 'Die Nachricht konnte gerade nicht verschickt werden. Bitte versuch es noch einmal.');
  }
}

export type VerifyResult =
  | { result: 'ok'; booking: Booking; autoApproved: boolean }
  | { result: 'wrong'; remaining: number }
  | { result: 'expired' }
  | { result: 'locked' }
  | { result: 'none' }
  | { result: 'already'; booking: Booking }
  | { result: 'conflict'; booking: Booking };

function latestVerification(db: Q, bookingId: number) {
  return db
    .select()
    .from(verifications)
    .where(eq(verifications.bookingId, bookingId))
    .orderBy(desc(verifications.id))
    .get();
}

export async function verifyCode(db: DB, notifier: Notifier, booking: Booking, code: string): Promise<VerifyResult> {
  if (booking.status !== 'unbestaetigt') return { result: 'already', booking };
  const v = latestVerification(db, booking.id);
  if (!v) return { result: 'none' };
  if (v.attempts >= config.booking.codeMaxAttempts) return { result: 'locked' };
  if (v.expiresAt.getTime() < Date.now()) return { result: 'expired' };
  const [key, hash] = v.codeHash.split('|');
  const clean = code.replace(/\D/g, '');
  if (codeHash(key, clean) !== hash) {
    const attempts = v.attempts + 1;
    db.update(verifications).set({ attempts }).where(eq(verifications.id, v.id)).run();
    const remaining = config.booking.codeMaxAttempts - attempts;
    return remaining > 0 ? { result: 'wrong', remaining } : { result: 'locked' };
  }
  return confirmContact(db, notifier, booking, v.id);
}

export async function verifyToken(db: DB, notifier: Notifier, token: string): Promise<VerifyResult> {
  if (!token || token.length > 100) return { result: 'none' };
  const v = db.select().from(verifications).where(eq(verifications.tokenHash, tokenHash(token))).get();
  if (!v) return { result: 'none' };
  const booking = getBooking(db, v.bookingId)!;
  if (booking.status !== 'unbestaetigt') return { result: 'already', booking };
  if (v.expiresAt.getTime() < Date.now()) return { result: 'expired' };
  return confirmContact(db, notifier, booking, v.id);
}

/** Antwort mit Code direkt in der Matrix-Direktnachricht. */
export async function verifyFromMatrix(db: DB, notifier: Notifier, matrixUserId: string, code: string) {
  const hash = contactHash('matrix', matrixUserId);
  const candidates = db
    .select()
    .from(bookings)
    .where(and(eq(bookings.contactHash, hash), eq(bookings.status, 'unbestaetigt')))
    .orderBy(desc(bookings.id))
    .all();
  for (const b of candidates) {
    const r = await verifyCode(db, notifier, b, code);
    if (r.result !== 'wrong' && r.result !== 'none') return r;
  }
  return { result: 'none' } as VerifyResult;
}

function retentionDate(lastEnd: Date): Date {
  const d = new Date(lastEnd);
  d.setUTCMonth(d.getUTCMonth() + config.booking.retentionMonths);
  return d;
}

/** Kontakt bestätigt: Anfrage wird vorläufig (oder automatisch freigegeben). */
async function confirmContact(db: DB, notifier: Notifier, booking: Booking, verificationId: number): Promise<VerifyResult> {
  const outcome = db.transaction(
    (tx) => {
      const b = getBooking(tx, booking.id)!;
      if (b.status !== 'unbestaetigt') return { result: 'already' as const, booking: b };
      tx.update(verifications).set({ confirmedAt: new Date() }).where(eq(verifications.id, verificationId)).run();

      const view = bookingView(tx, b);
      const activeSlots = view.slots.filter((s) => !s.skipped);
      const occStarts = [...new Set(activeSlots.map((s) => s.start.getTime()))].sort((a, z) => a - z);
      const candidates: CandidateSlot[] = activeSlots.map((s) => ({
        roomSlug: s.roomSlug,
        start: s.start,
        end: s.end,
        endWithBuffer: s.endWithBuffer,
        occurrence: occStarts.indexOf(s.start.getTime()),
      }));
      const conflicts = findConflicts(tx, candidates, { excludeBookingId: b.id });
      if (conflicts.some((c) => c.occurrence === 0) || occStarts.length === 0) {
        tx.update(bookings)
          .set({ status: 'abgelaufen', verifiedAt: new Date(), deleteAfter: retentionDate(new Date()) })
          .where(eq(bookings.id, b.id))
          .run();
        audit(tx, 'System', 'konflikt-bei-bestaetigung', b.id);
        return { result: 'conflict' as const, booking: getBooking(tx, b.id)! };
      }
      const skipOcc = new Set(conflicts.map((c) => c.occurrence));
      for (const s of activeSlots) {
        if (skipOcc.has(occStarts.indexOf(s.start.getTime())))
          tx.update(slots).set({ skipped: true }).where(eq(slots.id, s.id)).run();
      }
      const lastEnd = view.slots.reduce((m, s) => (s.end > m ? s.end : m), new Date(0));
      const token = manageToken(b.publicId);
      tx.update(bookings)
        .set({
          status: 'vorlaeufig',
          verifiedAt: new Date(),
          holdUntil: new Date(Date.now() + config.booking.holdHours * HOUR),
          manageTokenHash: manageTokenHash(token),
          deleteAfter: retentionDate(lastEnd),
        })
        .where(eq(bookings.id, b.id))
        .run();
      audit(tx, 'System', 'kontakt-bestaetigt', b.id, b.contactChannel);

      // Auto-Freigabe: nie für Serien
      const room = getRoom(tx, b.roomSlug)!;
      const isSeries = !!view.seriesRule;
      const trusted = b.contactHash
        ? tx.select().from(trustedContacts).where(eq(trustedContacts.contactHash, b.contactHash)).get()?.trusted
        : false;
      if (!isSeries && (room.autoApprove || trusted)) {
        tx.update(bookings)
          .set({ status: 'bestaetigt', decidedBy: 'System (Auto-Freigabe)', decidedAt: new Date(), holdUntil: null })
          .where(eq(bookings.id, b.id))
          .run();
        audit(tx, 'System', 'auto-freigegeben', b.id, room.autoApprove ? 'Raum' : 'vertrauter Kontakt');
        return { result: 'ok' as const, booking: getBooking(tx, b.id)!, autoApproved: true };
      }
      return { result: 'ok' as const, booking: getBooking(tx, b.id)!, autoApproved: false };
    },
    { behavior: 'immediate' },
  );
  invalidate();

  if (outcome.result === 'conflict') {
    void safe(() => notifier.expired(bookingView(db, outcome.booking), 'conflict'));
  } else if (outcome.result === 'ok') {
    const view = bookingView(db, outcome.booking);
    const url = manageUrl(outcome.booking);
    if (outcome.autoApproved) {
      void safe(() => notifier.confirmed(view, url, bookingIcs(view, url)));
      void safe(() => notifier.admin('auto', adminMessage('Automatisch freigegeben', view)));
    } else {
      void safe(() => notifier.received(view, url));
      void safe(() => notifier.admin('anfrage', adminMessage('Neue Anfrage', view)));
    }
  }
  return outcome;
}

/** Meldung an die Raum-AG zu einer Buchung (ohne Kontaktdaten – die stehen im Admin-Bereich). */
export function adminMessage(title: string, view: BookingView): AdminMessage {
  const b = view.booking;
  const when = view.occurrences[0] ?? view.skipped[0];
  const extra = view.occurrences.length > 1 ? ` (+${view.occurrences.length - 1} weitere Termine)` : '';
  return {
    title: `${title}: ${view.room.name}${when ? `, ${describeOccurrence(when)}` : ''}`,
    text: `${b.purpose ?? '–'}${extra}\n${b.persons} Personen · ${KIND_LABEL[b.kind]}${b.isPublic ? ' · öffentlich' : ''}${view.seriesRule ? ' · Serie' : ''}`,
    url: `${config.publicUrl}/admin/buchung/${b.id}`,
  };
}

/** Formular abgeschickt, Kontakt noch nicht bestätigt (Ereignis „abgeschickt“). */
export async function announceRequest(db: DB, notifier: Notifier, booking: Booking) {
  await safe(() => notifier.admin('abgeschickt', adminMessage('Formular ausgefüllt, Code noch offen', bookingView(db, booking))));
}

export function describeOccurrence(o: { start: Date; end: Date }): string {
  const d = new Intl.DateTimeFormat('de-AT', { timeZone: 'Europe/Vienna', weekday: 'short', day: 'numeric', month: 'short' })
    .format(o.start)
    .replace(/\./g, '')
    .replace(',', '');
  const t = (x: Date) =>
    new Intl.DateTimeFormat('de-AT', { timeZone: 'Europe/Vienna', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(x);
  return `${d}, ${t(o.start)}–${t(o.end)}`;
}


async function safe(fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    log.error('Benachrichtigung fehlgeschlagen', { err });
  }
}

// ---------------------------------------------------------------- Entscheidungen der Raum-AG

export async function approve(db: DB, notifier: Notifier, id: number, actor: string, note?: string | null) {
  const b = db.transaction(
    (tx) => {
      const b = getBooking(tx, id);
      if (!b) throw new BookingError('not-found', 'Buchung nicht gefunden');
      if (b.status !== 'vorlaeufig') throw new BookingError('state', `Buchung ist ${b.status}`);
      tx.update(bookings)
        .set({ status: 'bestaetigt', decidedBy: actor, decidedAt: new Date(), decisionNote: note || null, holdUntil: null })
        .where(eq(bookings.id, id))
        .run();
      if (b.contactHash) {
        const threshold = config.booking.trustAfterApprovals;
        tx.insert(trustedContacts)
          .values({ contactHash: b.contactHash, approvedCount: 1, trusted: threshold === 1 })
          .onConflictDoUpdate({
            target: trustedContacts.contactHash,
            set: {
              approvedCount: sql`${trustedContacts.approvedCount} + 1`,
              trusted: threshold > 0 ? sql`${trustedContacts.trusted} OR (${trustedContacts.approvedCount} + 1 >= ${threshold})` : sql`${trustedContacts.trusted}`,
              updatedAt: new Date(),
            },
          })
          .run();
      }
      audit(tx, actor, 'freigegeben', id, note || undefined);
      return getBooking(tx, id)!;
    },
    { behavior: 'immediate' },
  );
  invalidate();
  const view = bookingView(db, b);
  const url = manageUrl(b);
  void safe(() => notifier.confirmed(view, url, bookingIcs(view, url)));
  return b;
}

export async function reject(db: DB, notifier: Notifier, id: number, actor: string, note?: string | null) {
  const b = getBooking(db, id);
  if (!b) throw new BookingError('not-found', 'Buchung nicht gefunden');
  if (!['vorlaeufig', 'unbestaetigt'].includes(b.status)) throw new BookingError('state', `Buchung ist ${b.status}`);
  db.update(bookings)
    .set({ status: 'abgelehnt', decidedBy: actor, decidedAt: new Date(), decisionNote: note || null, holdUntil: null })
    .where(eq(bookings.id, id))
    .run();
  audit(db, actor, 'abgelehnt', id, note || undefined);
  invalidate();
  const nb = getBooking(db, id)!;
  if (b.status === 'vorlaeufig') void safe(() => notifier.rejected(bookingView(db, nb), note || null));
  return nb;
}

export async function cancelByGuest(db: DB, notifier: Notifier, booking: Booking, reason?: string | null) {
  if (!['vorlaeufig', 'bestaetigt', 'unbestaetigt'].includes(booking.status))
    throw new BookingError('state', 'Diese Buchung ist nicht mehr aktiv.');
  db.update(bookings)
    .set({ status: 'storniert', cancelReason: reason?.slice(0, 500) || null, holdUntil: null })
    .where(eq(bookings.id, booking.id))
    .run();
  audit(db, 'Buchende:r', 'storniert', booking.id);
  invalidate();
  const nb = getBooking(db, booking.id)!;
  const view = bookingView(db, nb);
  void safe(() => notifier.cancelled(view, false, null));
  void safe(() => notifier.admin('storno', adminMessage('Storniert von der buchenden Person', view)));
  return nb;
}

export async function cancelByHouse(db: DB, notifier: Notifier, id: number, actor: string, note: string) {
  const b = getBooking(db, id);
  if (!b) throw new BookingError('not-found', 'Buchung nicht gefunden');
  if (!['vorlaeufig', 'bestaetigt'].includes(b.status)) throw new BookingError('state', `Buchung ist ${b.status}`);
  db.update(bookings)
    .set({ status: 'storniert', decidedBy: actor, decidedAt: new Date(), decisionNote: note, holdUntil: null })
    .where(eq(bookings.id, id))
    .run();
  audit(db, actor, 'storniert-vom-haus', id, note);
  invalidate();
  const nb = getBooking(db, id)!;
  if (nb.contactChannel !== 'intern') void safe(() => notifier.cancelled(bookingView(db, nb), true, note));
  return nb;
}

/** Hold verlängern (z. B. wenn die Raum-AG mehr Zeit braucht). */
export function extendHold(db: DB, id: number, actor: string, hours: number) {
  const b = getBooking(db, id);
  if (!b || b.status !== 'vorlaeufig') throw new BookingError('state', 'Nur vorläufige Anfragen');
  const base = Math.max(Date.now(), b.holdUntil?.getTime() ?? 0);
  db.update(bookings).set({ holdUntil: new Date(base + hours * HOUR) }).where(eq(bookings.id, id)).run();
  audit(db, actor, 'haltefrist-verlaengert', id, `${hours} h`);
}

export function setTrusted(db: DB, booking: Booking, trusted: boolean, actor: string) {
  if (!booking.contactHash) return;
  db.insert(trustedContacts)
    .values({ contactHash: booking.contactHash, trusted })
    .onConflictDoUpdate({ target: trustedContacts.contactHash, set: { trusted, updatedAt: new Date() } })
    .run();
  audit(db, actor, trusted ? 'kontakt-vertraut' : 'kontakt-nicht-vertraut', booking.id);
}

export function isTrusted(db: Q, booking: Booking): boolean {
  if (!booking.contactHash) return false;
  return !!db.select().from(trustedContacts).where(eq(trustedContacts.contactHash, booking.contactHash)).get()?.trusted;
}

// ---------------------------------------------------------------- Interne Buchungen

export interface InternalInput {
  roomSlug: string;
  start: Date;
  end: Date;
  seriesRule?: string | null;
  seriesUntil?: Date | null;
  purpose: string;
  persons: number;
  isPublic: boolean;
  category?: string | null;
  offer?: string | null;
  name?: string | null;
  /** Vorrang: überschneidende Anfragen stornieren (Notiz Pflicht). */
  override?: boolean;
  note?: string | null;
}

export async function createInternal(db: DB, notifier: Notifier, actor: string, input: InternalInput) {
  const room = getRoom(db, input.roomSlug);
  if (!room) throw new BookingError('invalid', 'Unbekannter Raum');
  if (!(input.end > input.start)) throw new BookingError('invalid', 'Das Ende muss nach dem Beginn liegen.');
  if (input.override && !input.note?.trim())
    throw new BookingError('invalid', 'Für Vorrang ist eine Notiz an die Betroffenen nötig.');
  const occurrences = seriesOccurrences(input.start, input.end, input.seriesRule, input.seriesUntil);
  const candidates = buildCandidates(db, room, occurrences);

  const { booking, toCancel } = db.transaction(
    (tx) => {
      const conflicts = findConflicts(tx, candidates, { ignoreBlocks: !!input.override });
      let toCancel: number[] = [];
      let skipped = new Set<number>();
      if (conflicts.length) {
        if (input.override) {
          toCancel = [...new Set(conflicts.filter((c) => c.type === 'booking').map((c) => c.bookingId!))];
        } else if (!input.seriesRule) {
          throw new ConflictError(conflicts);
        } else {
          skipped = new Set(conflicts.map((c) => c.occurrence));
          if (skipped.has(0)) throw new ConflictError(conflicts.filter((c) => c.occurrence === 0));
        }
      }
      const b = tx
        .insert(bookings)
        .values({
          publicId: newPublicId(),
          status: 'bestaetigt',
          roomSlug: room.slug,
          purpose: input.purpose,
          kind: 'intern',
          persons: input.persons,
          isPublic: input.isPublic,
          category: input.category || null,
          offer: input.offer || null,
          name: input.name || actor,
          contactChannel: 'intern',
          decidedBy: actor,
          decidedAt: new Date(),
          decisionNote: input.note || null,
        })
        .returning()
        .get();
      const token = manageToken(b.publicId);
      tx.update(bookings).set({ manageTokenHash: manageTokenHash(token) }).where(eq(bookings.id, b.id)).run();
      insertSlots(tx, b.id, candidates, skipped);
      if (input.seriesRule && occurrences.length > 1) {
        tx.insert(series)
          .values({ bookingId: b.id, rule: input.seriesRule, until: occurrences[occurrences.length - 1].start })
          .run();
      }
      audit(tx, actor, input.override ? 'intern-gebucht-mit-vorrang' : 'intern-gebucht', b.id, input.note || undefined);
      return { booking: getBooking(tx, b.id)!, toCancel };
    },
    { behavior: 'immediate' },
  );
  for (const id of toCancel) {
    await cancelByHouse(db, notifier, id, actor, input.note ?? 'Vorrang für eine Buchung des Hauses');
  }
  invalidate();
  return booking;
}

export function updatePublicInfo(
  db: DB,
  id: number,
  actor: string,
  data: { isPublic: boolean; category: string | null; offer: string | null; purpose?: string | null },
) {
  db.update(bookings)
    .set({ isPublic: data.isPublic, category: data.category, offer: data.offer, ...(data.purpose ? { purpose: data.purpose } : {}) })
    .where(eq(bookings.id, id))
    .run();
  audit(db, actor, 'termin-info-geaendert', id);
  invalidate();
}

// ---------------------------------------------------------------- Sperrzeiten

export function addBlock(
  db: DB,
  actor: string,
  data: { roomSlug: string | null; start: Date; end: Date; rule?: string | null; until?: Date | null; reason: string },
) {
  if (!(data.end > data.start)) throw new BookingError('invalid', 'Das Ende muss nach dem Beginn liegen.');
  const b = db
    .insert(blocks)
    .values({ ...data, rule: data.rule || null, until: data.until || null, createdBy: actor })
    .returning()
    .get();
  audit(db, actor, 'sperrzeit-angelegt', null, `${b.id}: ${data.reason}`);
  invalidate();
  return b;
}

export function deleteBlock(db: DB, actor: string, id: number) {
  db.delete(blocks).where(eq(blocks.id, id)).run();
  audit(db, actor, 'sperrzeit-geloescht', null, String(id));
  invalidate();
}

// ---------------------------------------------------------------- Jobs

/** Vorläufige Anfragen nach der Haltefrist auslaufen lassen. */
export async function expireHolds(db: DB, notifier: Notifier) {
  const due = db
    .select()
    .from(bookings)
    .where(and(eq(bookings.status, 'vorlaeufig'), lte(bookings.holdUntil, new Date())))
    .all();
  for (const b of due) {
    db.update(bookings).set({ status: 'abgelaufen', holdUntil: null }).where(eq(bookings.id, b.id)).run();
    audit(db, 'System', 'haltefrist-abgelaufen', b.id);
    const view = bookingView(db, getBooking(db, b.id)!);
    void safe(() => notifier.expired(view, 'hold'));
    void safe(() => notifier.admin('abgelaufen', adminMessage('Haltefrist abgelaufen', view)));
  }
  if (due.length) invalidate();
  return due.length;
}

/** Unbestätigte Anfragen nach X Stunden ganz löschen. */
export function deleteUnconfirmed(db: DB) {
  const cutoff = new Date(Date.now() - config.booking.unconfirmedDeleteHours * HOUR);
  const rows = db
    .select({ id: bookings.id })
    .from(bookings)
    .where(and(eq(bookings.status, 'unbestaetigt'), lt(bookings.createdAt, cutoff)))
    .all();
  if (!rows.length) return 0;
  const ids = rows.map((r) => r.id);
  db.delete(bookings).where(inArray(bookings.id, ids)).run();
  db.delete(auditLog).where(inArray(auditLog.bookingId, ids)).run();
  return ids.length;
}

/** Personenbezogene Daten nach der Löschfrist entfernen. Raum, Zeit, Art und Personenzahl bleiben. */
export function anonymize(db: DB) {
  const now = new Date();
  const due = db
    .select()
    .from(bookings)
    .where(and(isNull(bookings.anonymizedAt), lte(bookings.deleteAfter, now)))
    .all()
    .filter((b) => b.contactChannel !== 'intern');
  for (const b of due) {
    db.update(bookings)
      .set({
        name: null,
        contactAddress: null,
        contactHash: null,
        purpose: b.isPublic ? b.purpose : null,
        cancelReason: null,
        decisionNote: null,
        manageTokenHash: null,
        anonymizedAt: now,
      })
      .where(eq(bookings.id, b.id))
      .run();
    db.delete(verifications).where(eq(verifications.bookingId, b.id)).run();
    audit(db, 'System', 'anonymisiert', b.id);
  }
  return due.length;
}

// ---------------------------------------------------------------- Admin-Auswertungen

export function listBookings(db: Q, opts: { statuses?: Booking['status'][]; from?: Date; to?: Date; limit?: number } = {}) {
  let ids: number[] | null = null;
  if (opts.from || opts.to) {
    const rows = db
      .selectDistinct({ id: slots.bookingId })
      .from(slots)
      .where(and(opts.to ? lt(slots.start, opts.to) : undefined, opts.from ? gt(slots.end, opts.from) : undefined))
      .all();
    ids = rows.map((r) => r.id);
    if (!ids.length) return [];
  }
  const list = db
    .select()
    .from(bookings)
    .where(
      and(
        opts.statuses?.length ? inArray(bookings.status, opts.statuses) : undefined,
        ids ? inArray(bookings.id, ids) : undefined,
      ),
    )
    .orderBy(desc(bookings.id))
    .limit(opts.limit ?? 1000)
    .all();
  return list.map((b) => bookingView(db, b));
}

/** Nutzungsstunden pro Raum und Art (für Förderberichte). */
export function statistics(db: Q, from: Date, to: Date) {
  const views = listBookings(db, { statuses: ['bestaetigt'], from, to });
  const byRoom = new Map<string, { room: string; kinds: Record<string, number>; total: number; count: number; persons: number }>();
  for (const v of views) {
    for (const o of v.occurrences) {
      if (!(o.start < to && o.end > from)) continue;
      const hours = (o.end.getTime() - o.start.getTime()) / HOUR;
      const e = byRoom.get(v.room.slug) ?? { room: v.room.name, kinds: {}, total: 0, count: 0, persons: 0 };
      e.kinds[v.booking.kind] = (e.kinds[v.booking.kind] ?? 0) + hours;
      e.total += hours;
      e.count += 1;
      e.persons += v.booking.persons;
      byRoom.set(v.room.slug, e);
    }
  }
  return [...byRoom.values()];
}

export function auditFor(db: Q, bookingId: number) {
  return db.select().from(auditLog).where(eq(auditLog.bookingId, bookingId)).orderBy(asc(auditLog.id)).all();
}

export function recentAudit(db: Q, limit = 200) {
  return db.select().from(auditLog).orderBy(desc(auditLog.id)).limit(limit).all();
}

export function weekRange(monday: string) {
  return { from: dayStart(monday), to: dayStart(addDays(monday, 7)) };
}

/** Bestätigungsweg wechseln (z. B. Matrix-ID nicht erreichbar → E-Mail). */
export function changeContact(db: DB, booking: Booking, channel: 'email' | 'matrix', address: string): Booking {
  if (booking.status !== 'unbestaetigt') throw new BookingError('state', 'Diese Anfrage ist schon bestätigt.');
  const a = normalizeContact(channel, address);
  db.update(bookings)
    .set({ contactChannel: channel, contactAddress: a, contactHash: contactHash(channel, a) })
    .where(eq(bookings.id, booking.id))
    .run();
  audit(db, 'Buchende:r', 'kontaktweg-geaendert', booking.id, channel);
  return getBooking(db, booking.id)!;
}
