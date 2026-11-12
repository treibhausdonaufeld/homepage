import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DB } from '../../src/lib/db';
import { bookings, verifications } from '../../src/lib/db/schema';
import * as svc from '../../src/lib/booking/service';
import { BookingError, ConflictError } from '../../src/lib/booking/types';
import { addDays, parseLocal, today } from '../../src/lib/time';
import { manageToken } from '../../src/lib/verify/tokens';
import { addNightBlock, fakeNotifier, testDb } from './helpers';

const day = addDays(today(), 10);
const at = (t: string, d = day) => parseLocal(d, t)!;

function request(over: Partial<svc.RequestInput> = {}): svc.RequestInput {
  return {
    roomSlug: 'saal',
    start: at('10:00'),
    end: at('14:00'),
    name: 'Amira K.',
    purpose: 'Kleidertausch fürs Viertel',
    persons: 30,
    kind: 'gemeinnuetzig',
    isPublic: true,
    channel: 'email',
    address: `amira${Math.random()}@example.org`,
    ...over,
  };
}

async function requestAndVerify(db: DB, n: ReturnType<typeof fakeNotifier>, over: Partial<svc.RequestInput> = {}) {
  const b = svc.createRequest(db, request(over));
  await svc.sendVerification(db, n.n, b);
  const code = n.sent.filter((s) => s.kind === 'code').at(-1)!.code!;
  return svc.verifyCode(db, n.n, b, code);
}

describe('Buchungslogik', () => {
  let db: DB;
  let n: ReturnType<typeof fakeNotifier>;
  beforeEach(() => {
    db = testDb();
    n = fakeNotifier();
  });

  it('unbestätigte Anfragen blockieren nicht, vorläufige schon', async () => {
    svc.createRequest(db, request());
    expect(() => svc.createRequest(db, request())).not.toThrow();
    const r = await requestAndVerify(db, n);
    expect(r.result).toBe('ok');
    expect(() => svc.createRequest(db, request({ start: at('13:00'), end: at('15:00') }))).toThrow(ConflictError);
  });

  it('Pufferzeit zählt bei der Prüfung mit', async () => {
    await requestAndVerify(db, n);
    // 14:00 + 30 Min Puffer → 14:15 kollidiert, 14:30 geht
    expect(() => svc.createRequest(db, request({ start: at('14:15'), end: at('16:00') }))).toThrow(ConflictError);
    expect(() => svc.createRequest(db, request({ start: at('14:30'), end: at('16:00') }))).not.toThrow();
  });

  it('Saal + Küche belegt beide Räume', async () => {
    await requestAndVerify(db, n, { roomSlug: 'beide', persons: 50 });
    expect(() => svc.createRequest(db, request({ roomSlug: 'kueche', persons: 10 }))).toThrow(ConflictError);
    const room = svc.getRoom(db, 'kueche')!;
    const tl = svc.dayTimeline(db, room, day);
    expect(tl.some((s) => s.state === 'angefragt')).toBe(true);
  });

  it('Sperrzeiten verhindern Buchungen', () => {
    addNightBlock(db, parseLocal(today(), '22:00')!, parseLocal(addDays(today(), 1), '08:00')!);
    expect(() => svc.createRequest(db, request({ start: at('20:00'), end: at('23:00') }))).toThrow(ConflictError);
    expect(() => svc.createRequest(db, request({ start: at('18:00'), end: at('22:00') }))).not.toThrow();
  });

  it('Kapazität wird geprüft', () => {
    expect(() => svc.createRequest(db, request({ persons: 80 }))).toThrow(BookingError);
  });

  it('falscher Code zählt Versuche, dann gesperrt', async () => {
    const b = svc.createRequest(db, request());
    await svc.sendVerification(db, n.n, b);
    expect(await svc.verifyCode(db, n.n, b, '000000x')).toMatchObject({ result: 'wrong', remaining: 2 });
    expect(await svc.verifyCode(db, n.n, b, '000000x')).toMatchObject({ result: 'wrong', remaining: 1 });
    expect((await svc.verifyCode(db, n.n, b, '000000x')).result).toBe('locked');
    const code = n.sent.at(-1)!.code!;
    expect((await svc.verifyCode(db, n.n, b, code)).result).toBe('locked');
  });

  it('abgelaufener Code', async () => {
    const b = svc.createRequest(db, request());
    await svc.sendVerification(db, n.n, b);
    db.update(verifications).set({ expiresAt: new Date(Date.now() - 1000) }).run();
    expect((await svc.verifyCode(db, n.n, b, n.sent.at(-1)!.code!)).result).toBe('expired');
  });

  it('Bestätigung per Link', async () => {
    const b = svc.createRequest(db, request());
    await svc.sendVerification(db, n.n, b);
    const token = new URL(n.sent.at(-1)!.link!).searchParams.get('t')!;
    const r = await svc.verifyToken(db, n.n, token);
    expect(r.result).toBe('ok');
    expect(svc.getBooking(db, b.id)!.status).toBe('vorlaeufig');
  });

  it('wer zuerst bestätigt, bekommt den Raum', async () => {
    const a = svc.createRequest(db, request());
    const b = svc.createRequest(db, request());
    await svc.sendVerification(db, n.n, a);
    const codeA = n.sent.at(-1)!.code!;
    await svc.sendVerification(db, n.n, b);
    const codeB = n.sent.at(-1)!.code!;
    expect((await svc.verifyCode(db, n.n, b, codeB)).result).toBe('ok');
    expect((await svc.verifyCode(db, n.n, a, codeA)).result).toBe('conflict');
    expect(svc.getBooking(db, a.id)!.status).toBe('abgelaufen');
  });

  it('Freigabe, Audit-Log und Verwaltungslink', async () => {
    const r = await requestAndVerify(db, n);
    if (r.result !== 'ok') throw new Error();
    await svc.approve(db, n.n, r.booking.id, 'Fabian', 'passt');
    const b = svc.getBooking(db, r.booking.id)!;
    expect(b.status).toBe('bestaetigt');
    expect(b.decidedBy).toBe('Fabian');
    expect(svc.auditFor(db, b.id).map((a) => a.action)).toContain('freigegeben');
    expect(svc.getBookingByManageToken(db, manageToken(b.publicId))?.id).toBe(b.id);
    expect(svc.publicEvents(db, at('00:00'), at('23:59'))).toHaveLength(1);
  });

  it('Auto-Freigabe für Räume, aber nie für Serien', async () => {
    db.update((await import('../../src/lib/db/schema')).rooms).set({ autoApprove: true }).run();
    const r = await requestAndVerify(db, n);
    expect(r.result === 'ok' && r.autoApproved).toBe(true);
    const s = await requestAndVerify(db, n, {
      start: at('16:00'),
      end: at('18:00'),
      seriesRule: 'FREQ=WEEKLY',
      seriesUntil: parseLocal(addDays(day, 35), '23:00'),
    });
    expect(s.result === 'ok' && s.autoApproved).toBe(false);
  });

  it('Serie: Konflikte einzelner Termine werden übersprungen', async () => {
    await requestAndVerify(db, n, { start: at('16:00', addDays(day, 14)), end: at('18:00', addDays(day, 14)) });
    const r = await requestAndVerify(db, n, {
      start: at('16:00'),
      end: at('18:00'),
      seriesRule: 'FREQ=WEEKLY',
      seriesUntil: parseLocal(addDays(day, 28), '23:00'),
    });
    if (r.result !== 'ok') throw new Error(r.result);
    const view = svc.bookingView(db, r.booking);
    expect(view.occurrences).toHaveLength(4);
    expect(view.skipped).toHaveLength(1);
  });

  it('Haltefrist läuft ab', async () => {
    const r = await requestAndVerify(db, n);
    if (r.result !== 'ok') throw new Error();
    db.update(bookings).set({ holdUntil: new Date(Date.now() - 1) }).where(eq(bookings.id, r.booking.id)).run();
    expect(await svc.expireHolds(db, n.n)).toBe(1);
    expect(svc.getBooking(db, r.booking.id)!.status).toBe('abgelaufen');
    expect(() => svc.createRequest(db, request())).not.toThrow();
  });

  it('Storno gibt den Raum frei', async () => {
    const r = await requestAndVerify(db, n);
    if (r.result !== 'ok') throw new Error();
    await svc.cancelByGuest(db, n.n, r.booking, 'krank');
    expect(() => svc.createRequest(db, request())).not.toThrow();
  });

  it('interne Buchung mit Vorrang storniert Anfragen', async () => {
    const r = await requestAndVerify(db, n);
    if (r.result !== 'ok') throw new Error();
    await expect(
      svc.createInternal(db, n.n, 'Raum-AG', { roomSlug: 'saal', start: at('09:00'), end: at('12:00'), purpose: 'Hausversammlung', persons: 40, isPublic: false }),
    ).rejects.toThrow(ConflictError);
    await svc.createInternal(db, n.n, 'Raum-AG', {
      roomSlug: 'saal',
      start: at('09:00'),
      end: at('12:00'),
      purpose: 'Hausversammlung',
      persons: 40,
      isPublic: false,
      override: true,
      note: 'Hausversammlung hat Vorrang',
    });
    expect(svc.getBooking(db, r.booking.id)!.status).toBe('storniert');
    expect(n.sent.some((s) => s.kind === 'cancelled')).toBe(true);
  });

  it('Anonymisierung entfernt Name und Kontakt', async () => {
    const r = await requestAndVerify(db, n, { isPublic: false });
    if (r.result !== 'ok') throw new Error();
    db.update(bookings).set({ deleteAfter: new Date(Date.now() - 1) }).run();
    expect(svc.anonymize(db)).toBe(1);
    const b = svc.getBooking(db, r.booking.id)!;
    expect(b.name).toBeNull();
    expect(b.contactAddress).toBeNull();
    expect(b.purpose).toBeNull();
    expect(b.persons).toBe(30);
  });

  it('Statistik summiert Stunden pro Raum und Art', async () => {
    const r = await requestAndVerify(db, n);
    if (r.result !== 'ok') throw new Error();
    await svc.approve(db, n.n, r.booking.id, 'x');
    const stats = svc.statistics(db, at('00:00'), at('23:59'));
    expect(stats[0].total).toBe(4);
    expect(stats[0].kinds.gemeinnuetzig).toBe(4);
  });
});
