/**
 * Abonnierte Kalender: Abruf, Speicherung der Vorkommen und Zuordnung zu Räumen über den Ort.
 */
import { and, asc, eq, gt, lt } from 'drizzle-orm';
import type { DB } from '../db';
import {
  calendarSubscriptions,
  externalEvents,
  rooms,
  type CalendarSubscription,
  type ExternalEvent,
  type Room,
} from '../db/schema';
import { log } from '../log';
import { DAY } from '../time';
import { parseIcs } from './ics';

type Q = Pick<DB, 'select'>;

/** Wie weit in Vergangenheit und Zukunft Termine gespeichert werden. */
export const WINDOW_PAST = 7 * DAY;
export const WINDOW_FUTURE = 400 * DAY;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_BYTES = 5 * 1024 * 1024;

// ---------------------------------------------------------------- Räume über den Ort

/** Für Vergleiche: klein, ä→ae usw., nur Buchstaben/Ziffern. */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Stichwörter eines Raums (Standard: Raumname). Kombinierte Räume haben keine eigenen. */
export function roomKeywords(room: Pick<Room, 'name' | 'locationKeywords' | 'combines'>): string[] {
  if (room.combines?.length) return [];
  const list = room.locationKeywords ?? [room.name];
  return list.map(normalize).filter(Boolean);
}

/** Physische Räume, deren Stichwort im Ort vorkommt (mehrere möglich, z. B. „Viertelsaal + Viertelküche“). */
export function roomsForLocation(location: string | null | undefined, roomList: Room[]): Room[] {
  if (!location) return [];
  const loc = ` ${normalize(location)} `;
  return roomList.filter((r) => roomKeywords(r).some((k) => loc.includes(k)));
}

/** Eingabe „Viertelsaal, Saal“ → ['Viertelsaal', 'Saal'] (leer → null = Raumname). */
export function parseKeywords(input: string): string[] | null {
  const list = [...new Set(input.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean))];
  return list.length ? list : null;
}

// ---------------------------------------------------------------- Lesen

export interface ExternalOccurrence extends ExternalEvent {
  showPublic: boolean;
  blockRooms: boolean;
  label: string;
}

/** Gespeicherte Vorkommen aktiver Abos im Zeitraum. */
export function externalEventsBetween(
  db: Q,
  from: Date,
  to: Date,
  filter: { showPublic?: boolean; blockRooms?: boolean } = {},
): ExternalOccurrence[] {
  const rows = db
    .select({
      ev: externalEvents,
      showPublic: calendarSubscriptions.showPublic,
      blockRooms: calendarSubscriptions.blockRooms,
      label: calendarSubscriptions.label,
    })
    .from(externalEvents)
    .innerJoin(calendarSubscriptions, eq(calendarSubscriptions.id, externalEvents.subscriptionId))
    .where(
      and(
        eq(calendarSubscriptions.enabled, true),
        filter.showPublic ? eq(calendarSubscriptions.showPublic, true) : undefined,
        filter.blockRooms ? eq(calendarSubscriptions.blockRooms, true) : undefined,
        lt(externalEvents.start, to),
        gt(externalEvents.end, from),
      ),
    )
    .orderBy(asc(externalEvents.start))
    .all();
  return rows.map((r) => ({ ...r.ev, showPublic: r.showPublic, blockRooms: r.blockRooms, label: r.label }));
}

export function listSubscriptions(db: Q): CalendarSubscription[] {
  return db.select().from(calendarSubscriptions).orderBy(asc(calendarSubscriptions.id)).all();
}

// ---------------------------------------------------------------- Abruf

/** webcal:// → https://, nur http(s) erlaubt. Gibt null bei ungültiger URL. */
export function cleanUrl(input: string): string | null {
  const raw = input.trim().replace(/^webcals?:\/\//i, 'https://');
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

async function download(url: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: 'text/calendar, */*;q=0.5', 'User-Agent': 'treibhaus-web (Kalender-Abo)' },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > MAX_BYTES) throw new Error('Kalender ist zu groß');
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new Error('Kalender ist zu groß');
    if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('Antwort ist kein iCal-Kalender');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Einen Kalender abrufen und seine Vorkommen ersetzen. Bei einem Fehler bleiben die
 * bisherigen Termine stehen (Räume bleiben gesperrt), der Fehler wird gespeichert.
 */
export async function syncSubscription(
  db: DB,
  sub: CalendarSubscription,
  opts: { fetchText?: (url: string) => Promise<string>; now?: Date } = {},
): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  const now = opts.now ?? new Date();
  try {
    const text = await (opts.fetchText ?? download)(sub.url);
    const occ = parseIcs(text, new Date(now.getTime() - WINDOW_PAST), new Date(now.getTime() + WINDOW_FUTURE));
    db.transaction((tx) => {
      tx.delete(externalEvents).where(eq(externalEvents.subscriptionId, sub.id)).run();
      for (let i = 0; i < occ.length; i += 200) {
        tx.insert(externalEvents)
          .values(occ.slice(i, i + 200).map((o) => ({ subscriptionId: sub.id, ...o })))
          .run();
      }
      tx.update(calendarSubscriptions)
        .set({ lastFetchedAt: now, lastError: null, eventCount: occ.length })
        .where(eq(calendarSubscriptions.id, sub.id))
        .run();
    });
    return { ok: true, count: occ.length };
  } catch (err) {
    const error = err instanceof Error ? (err.name === 'AbortError' ? 'Zeitüberschreitung' : err.message) : String(err);
    db.update(calendarSubscriptions)
      .set({ lastFetchedAt: now, lastError: error.slice(0, 500) })
      .where(eq(calendarSubscriptions.id, sub.id))
      .run();
    log.warn('Kalender-Abo konnte nicht abgerufen werden', { id: sub.id, label: sub.label, error });
    return { ok: false, error };
  }
}

/** Alle aktiven Abos abrufen (Job). */
export async function syncAll(db: DB, opts: Parameters<typeof syncSubscription>[2] = {}) {
  const subs = listSubscriptions(db).filter((s) => s.enabled);
  let changed = 0;
  for (const s of subs) {
    const r = await syncSubscription(db, s, opts);
    if (r.ok) changed++;
  }
  return { total: subs.length, ok: changed };
}

/** Alle Räume (für die Zuordnung). */
export function allRooms(db: Q): Room[] {
  return db.select().from(rooms).orderBy(asc(rooms.sortOrder)).all();
}
