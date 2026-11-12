import { describe, expect, it } from 'vitest';
import { addDays, fmt, localDate, localTime, mondayOf, parseLocal, weekdayOf } from '../../src/lib/time';
import { expandRule } from '../../src/lib/booking/recurrence';

describe('Zeit in Wien', () => {
  it('rechnet Winter- und Sommerzeit richtig um', () => {
    expect(parseLocal('2026-11-19', '10:00')!.toISOString()).toBe('2026-11-19T09:00:00.000Z');
    expect(parseLocal('2026-07-01', '10:00')!.toISOString()).toBe('2026-07-01T08:00:00.000Z');
    expect(localTime(parseLocal('2026-03-29', '12:00')!)).toBe('12:00');
  });
  it('lehnt ungültige Eingaben ab', () => {
    expect(parseLocal('2026-02-30', '10:00')).toBeNull();
    expect(parseLocal('2026-11-19', '25:00')).toBeNull();
    expect(parseLocal('kaputt', '10:00')).toBeNull();
  });
  it('Datumshelfer', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(weekdayOf('2026-11-19')).toBe(3); // Donnerstag
    expect(mondayOf('2026-11-19')).toBe('2026-11-16');
    expect(localDate(parseLocal('2026-11-19', '23:30')!)).toBe('2026-11-19');
    expect(fmt.range(parseLocal('2026-11-19', '10:00')!, parseLocal('2026-11-19', '14:00')!)).toBe('10:00–14:00');
  });
  it('Serien bleiben über die Zeitumstellung bei gleicher Uhrzeit', () => {
    const first = { start: parseLocal('2026-10-17', '13:30')!, end: parseLocal('2026-10-17', '16:30')! };
    const occ = expandRule(first, 'FREQ=WEEKLY', first.start, parseLocal('2026-11-08')!);
    expect(occ.map((o) => localTime(o.start))).toEqual(['13:30', '13:30', '13:30', '13:30']);
    expect(occ.map((o) => localDate(o.start))).toEqual(['2026-10-17', '2026-10-24', '2026-10-31', '2026-11-07']);
  });
  it('Nachtruhe über Mitternacht', () => {
    const first = { start: parseLocal('2026-01-01', '22:00')!, end: parseLocal('2026-01-02', '08:00')! };
    const occ = expandRule(first, 'FREQ=DAILY', parseLocal('2026-11-19', '06:00')!, parseLocal('2026-11-19', '23:00')!);
    expect(occ).toHaveLength(2);
    expect(localTime(occ[0].end)).toBe('08:00');
    expect(localTime(occ[1].start)).toBe('22:00');
  });
});
