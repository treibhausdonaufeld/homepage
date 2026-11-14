import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DB } from '../../src/lib/db';
import { calendarSubscriptions, externalEvents, rooms } from '../../src/lib/db/schema';
import { parseDuration, parseIcs } from '../../src/lib/calendars/ics';
import { normalize, parseKeywords, roomsForLocation, syncAll, syncSubscription, cleanUrl } from '../../src/lib/calendars';
import * as svc from '../../src/lib/booking/service';
import { ConflictError } from '../../src/lib/booking/types';
import { addDays, localDate, localTime, parseLocal, today } from '../../src/lib/time';
import { testDb } from './helpers';

const wrap = (body: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Nextcloud//EN\r\n${body}\r\nEND:VCALENDAR\r\n`;
const ymd = (d: string) => d.replace(/-/g, '');
const from = new Date('2026-01-01T00:00:00Z');
const to = new Date('2027-12-31T00:00:00Z');

describe('ICS-Parser', () => {
  it('liest Zeitzone, Faltung, Escapes und Ort', () => {
    const ics = wrap(
      [
        'BEGIN:VTIMEZONE', 'TZID:Europe/Vienna', 'END:VTIMEZONE',
        'BEGIN:VEVENT', 'UID:a1', 'SUMMARY:Repair\\, Café', 'LOCATION:Viertelsaal\\, Viertel',
        ' küche',
        'DTSTART;TZID=Europe/Vienna:20260715T180000', 'DTEND;TZID=Europe/Vienna:20260715T200000',
        'BEGIN:VALARM', 'TRIGGER:-PT15M', 'DESCRIPTION:Erinnerung', 'END:VALARM',
        'END:VEVENT',
      ].join('\r\n'),
    );
    const [e] = parseIcs(ics, from, to);
    expect(e.title).toBe('Repair, Café');
    expect(e.location).toBe('Viertelsaal, Viertelküche');
    expect(e.start.toISOString()).toBe('2026-07-15T16:00:00.000Z'); // Sommerzeit UTC+2
    expect(e.end.toISOString()).toBe('2026-07-15T18:00:00.000Z');
    expect(e.allDay).toBe(false);
  });

  it('UTC, schwebende Zeit, Dauer und ganztägig', () => {
    const ics = wrap(
      [
        'BEGIN:VEVENT', 'UID:u', 'SUMMARY:UTC', 'DTSTART:20261201T100000Z', 'DURATION:PT1H30M', 'END:VEVENT',
        'BEGIN:VEVENT', 'UID:f', 'SUMMARY:Schwebend', 'DTSTART:20261201T100000', 'DTEND:20261201T110000', 'END:VEVENT',
        'BEGIN:VEVENT', 'UID:d', 'SUMMARY:Ganztags', 'DTSTART;VALUE=DATE:20261202', 'DTEND;VALUE=DATE:20261204', 'END:VEVENT',
      ].join('\r\n'),
    );
    const byUid = Object.fromEntries(parseIcs(ics, from, to).map((e) => [e.uid, e]));
    expect(byUid.u.end.getTime() - byUid.u.start.getTime()).toBe(90 * 60_000);
    expect(byUid.f.start.toISOString()).toBe('2026-12-01T09:00:00.000Z'); // Wiener Zeit, Winter UTC+1
    expect(byUid.d.allDay).toBe(true);
    expect(localDate(byUid.d.start)).toBe('2026-12-02');
    expect(localTime(byUid.d.start)).toBe('00:00');
    expect(localDate(byUid.d.end)).toBe('2026-12-04');
  });

  it('löst Serien auf: EXDATE, geänderter Einzeltermin, Absage, Zeitumstellung', () => {
    const ics = wrap(
      [
        'BEGIN:VEVENT', 'UID:s', 'SUMMARY:Treff', 'LOCATION:Viertelküche',
        'DTSTART;TZID=Europe/Vienna:20261017T133000', 'DTEND;TZID=Europe/Vienna:20261017T163000',
        'RRULE:FREQ=WEEKLY;COUNT=5', 'EXDATE;TZID=Europe/Vienna:20261024T133000', 'END:VEVENT',
        // 31.10. verschoben auf 15 Uhr
        'BEGIN:VEVENT', 'UID:s', 'SUMMARY:Treff (später)', 'RECURRENCE-ID;TZID=Europe/Vienna:20261031T133000',
        'DTSTART;TZID=Europe/Vienna:20261031T150000', 'DTEND;TZID=Europe/Vienna:20261031T170000', 'END:VEVENT',
        // 7.11. abgesagt
        'BEGIN:VEVENT', 'UID:s', 'STATUS:CANCELLED', 'RECURRENCE-ID;TZID=Europe/Vienna:20261107T133000',
        'DTSTART;TZID=Europe/Vienna:20261107T133000', 'DTEND;TZID=Europe/Vienna:20261107T163000', 'END:VEVENT',
      ].join('\r\n'),
    );
    const list = parseIcs(ics, from, to).map((e) => `${localDate(e.start)} ${localTime(e.start)} ${e.title}`);
    expect(list).toEqual([
      '2026-10-17 13:30 Treff',
      '2026-10-31 15:00 Treff (später)', // nach der Zeitumstellung trotzdem 15 Uhr Ortszeit
      '2026-11-14 13:30 Treff',
    ]);
  });

  it('unendliche Serien nur im Fenster, abgesagte Termine fehlen', () => {
    const ics = wrap(
      [
        'BEGIN:VEVENT', 'UID:t', 'SUMMARY:Täglich', 'DTSTART:20200101T080000Z', 'DTEND:20200101T090000Z', 'RRULE:FREQ=DAILY', 'END:VEVENT',
        'BEGIN:VEVENT', 'UID:x', 'SUMMARY:Abgesagt', 'STATUS:CANCELLED', 'DTSTART:20260601T080000Z', 'DTEND:20260601T090000Z', 'END:VEVENT',
      ].join('\r\n'),
    );
    const list = parseIcs(ics, new Date('2026-03-01T00:00:00Z'), new Date('2026-03-08T00:00:00Z'));
    expect(list).toHaveLength(7);
    expect(list.every((e) => e.uid === 't')).toBe(true);
  });

  it('Dauer', () => {
    expect(parseDuration('P1W')).toBe(7 * 86_400_000);
    expect(parseDuration('PT2H15M')).toBe(8_100_000);
    expect(parseDuration('P1DT1H')).toBe(90_000_000);
    expect(parseDuration('quatsch')).toBeNull();
  });
});

describe('Räume über den Ort', () => {
  const list = [
    { slug: 'viertelsaal', name: 'Viertelsaal', locationKeywords: ['viertelsaal'], combines: null },
    { slug: 'viertelkueche', name: 'Viertelküche', locationKeywords: ['Viertelküche'], combines: null },
    { slug: 'werkstatt', name: 'Werkstatt', locationKeywords: null, combines: null },
    { slug: 'beide', name: 'Saal + Küche', locationKeywords: null, combines: ['viertelsaal', 'viertelkueche'] },
  ] as never[];
  const slugs = (loc: string) => roomsForLocation(loc, list).map((r: { slug: string }) => r.slug);

  it('Groß/klein, Umlaute und mehrere Räume', () => {
    expect(normalize('Viertel-KÜCHE')).toBe('viertel kueche');
    expect(slugs('VIERTELSAAL')).toEqual(['viertelsaal']);
    expect(slugs('Viertelkueche, 1. Stock')).toEqual(['viertelkueche']);
    expect(slugs('Viertelsaal + Viertelküche')).toEqual(['viertelsaal', 'viertelkueche']);
    expect(slugs('Fahrradwerkstatt im Hof')).toEqual(['werkstatt']); // ohne Stichwort: Raumname
    expect(slugs('Garten')).toEqual([]);
  });

  it('Stichwort-Eingabe', () => {
    expect(parseKeywords('Viertelsaal, Saal ,, Saal')).toEqual(['Viertelsaal', 'Saal']);
    expect(parseKeywords('  ')).toBeNull();
    expect(cleanUrl('webcal://example.org/cal.ics')).toBe('https://example.org/cal.ics');
    expect(cleanUrl('file:///etc/passwd')).toBeNull();
  });
});

describe('Kalender-Abos: Sperren und öffentliche Termine', () => {
  let db: DB;
  const day = addDays(today(), 10);
  const at = (t: string) => parseLocal(day, t)!;
  const vevent = (uid: string, title: string, loc: string, s: string, e: string) =>
    ['BEGIN:VEVENT', `UID:${uid}`, `SUMMARY:${title}`, `LOCATION:${loc}`, `DTSTART;TZID=Europe/Vienna:${ymd(day)}T${s.replace(':', '')}00`, `DTEND;TZID=Europe/Vienna:${ymd(day)}T${e.replace(':', '')}00`, 'END:VEVENT'].join('\r\n');

  const publicIcs = wrap(vevent('p1', 'Kleidertausch', 'Viertelsaal, Viertelküche', '15:00', '17:00'));
  const privateIcs = wrap(vevent('h1', 'Hausversammlung intern', 'Viertelküche', '19:00', '21:00'));

  async function subscribe(label: string, showPublic: boolean, text: string, blockRooms = true) {
    const sub = db.insert(calendarSubscriptions).values({ label, url: `https://example.org/${label}`, showPublic, blockRooms, createdBy: 'test' }).returning().get();
    const r = await syncSubscription(db, sub, { fetchText: async () => text });
    svc.invalidate();
    return { sub, r };
  }

  beforeEach(async () => {
    db = testDb();
    db.delete(calendarSubscriptions).run(); // von der Migration angelegtes Abo
    db.update(rooms).set({ locationKeywords: ['viertelsaal'] }).where(eq(rooms.slug, 'saal')).run();
    db.update(rooms).set({ locationKeywords: ['viertelküche'] }).where(eq(rooms.slug, 'kueche')).run();
    await subscribe('oeffentlich', true, publicIcs);
    await subscribe('intern', false, privateIcs);
  });

  it('sperrt passende Räume inkl. Pufferzeit, Kombiraum über beide', () => {
    const cands = (slug: string, s: string, e: string) => svc.buildCandidates(db, svc.getRoom(db, slug)!, [{ start: at(s), end: at(e) }]);
    const saal = svc.findConflicts(db, cands('saal', '16:00', '18:00'));
    expect(saal).toHaveLength(1);
    expect(saal[0].reason).toBe('Termin: Kleidertausch');
    // Ende 14:45 + 30 Min. Puffer läuft in den Termin um 15:00
    expect(svc.findConflicts(db, cands('saal', '13:00', '14:45'))).toHaveLength(1);
    // Nach 17:00 + 30 Min. Puffer frei
    expect(svc.findConflicts(db, cands('saal', '17:30', '18:30'))).toHaveLength(0);
    // Interner Kalender: Titel bleibt geheim
    const k = svc.findConflicts(db, cands('kueche', '19:30', '20:00'));
    expect(k[0].reason).toBe('Termin im Haus');
    expect(svc.findConflicts(db, cands('beide', '20:00', '22:00')).length).toBeGreaterThan(0);
  });

  it('Buchungsanfrage scheitert an Kalendertermin', () => {
    expect(() =>
      svc.createRequest(db, {
        roomSlug: 'kueche', start: at('19:00'), end: at('20:00'), name: 'X', purpose: 'Test', persons: 5,
        kind: 'privat', isPublic: false, channel: 'email', address: 'x@example.org',
      }),
    ).toThrow(ConflictError);
  });

  it('Belegung zeigt Kalendertermine als belegt', () => {
    const tl = svc.dayTimeline(db, svc.getRoom(db, 'kueche')!, day);
    const busy = tl.filter((s) => s.state === 'belegt').map((s) => `${localTime(s.start)}-${localTime(s.end)}`);
    expect(busy).toEqual(['15:00-17:30', '19:00-21:30']);
  });

  it('nur öffentliche Kalender erscheinen als Termine', () => {
    const ev = svc.publicEvents(db, parseLocal(day, '00:00')!, parseLocal(addDays(day, 1), '00:00')!);
    expect(ev.map((e) => e.title)).toEqual(['Kleidertausch']);
    expect(ev[0].roomName).toBe('Viertelsaal + Viertelküche');
    expect(ev[0].key).toMatch(/^k[0-9a-f]{12}-\d+$/);
  });

  it('Stichwörter änderbar, Sperren abschaltbar, Abo löschen hebt Sperre auf', () => {
    const kueche = () => svc.findConflicts(db, svc.buildCandidates(db, svc.getRoom(db, 'kueche')!, [{ start: at('19:30'), end: at('20:00') }]));
    db.update(rooms).set({ locationKeywords: ['küche 2'] }).where(eq(rooms.slug, 'kueche')).run();
    expect(kueche()).toHaveLength(0);
    db.update(rooms).set({ locationKeywords: null }).where(eq(rooms.slug, 'kueche')).run(); // Raumname „Viertelküche“
    expect(kueche()).toHaveLength(1);
    db.update(calendarSubscriptions).set({ blockRooms: false }).where(eq(calendarSubscriptions.label, 'intern')).run();
    expect(kueche()).toHaveLength(0);
    db.update(calendarSubscriptions).set({ blockRooms: true }).where(eq(calendarSubscriptions.label, 'intern')).run();
    db.delete(calendarSubscriptions).where(eq(calendarSubscriptions.label, 'intern')).run();
    expect(kueche()).toHaveLength(0);
    expect(db.select().from(externalEvents).all()).toHaveLength(1);
  });

  it('Abruffehler: alte Termine bleiben, Fehler wird gespeichert', async () => {
    const r = await syncAll(db, { fetchText: async () => { throw new Error('HTTP 503'); } });
    expect(r).toEqual({ total: 2, ok: 0 });
    const subs = db.select().from(calendarSubscriptions).all();
    expect(subs.every((s) => s.lastError === 'HTTP 503')).toBe(true);
    expect(db.select().from(externalEvents).all()).toHaveLength(2);
    // Erfolgreicher Abruf ersetzt die Termine und löscht den Fehler
    await syncAll(db, { fetchText: async () => wrap('') });
    expect(db.select().from(externalEvents).all()).toHaveLength(0);
    expect(db.select().from(calendarSubscriptions).all().every((s) => s.lastError === null && s.eventCount === 0)).toBe(true);
  });
});
