/**
 * Zeit-Helfer: gespeichert wird UTC, angezeigt und eingegeben wird Wiener Ortszeit.
 * Kommt ohne Zeitzonen-Bibliothek aus, nutzt Intl.
 */

export const TZ = 'Europe/Vienna';
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  weekday: 'short',
});

export interface LocalParts {
  year: number;
  month: number; // 1–12
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Montag … 6 = Sonntag */
  weekday: number;
}

const WD: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

export function localParts(d: Date | number): LocalParts {
  const p: Record<string, string> = {};
  for (const { type, value } of partsFmt.formatToParts(new Date(d))) p[type] = value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    second: Number(p.second),
    weekday: WD[p.weekday] ?? 0,
  };
}

/** Versatz der Wiener Zeit gegenüber UTC zum Zeitpunkt d (ms). */
function offsetAt(ms: number): number {
  const p = localParts(ms);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Wiener Ortszeit → UTC-Date. */
export function fromLocal(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let ms = guess - offsetAt(guess);
  const o2 = offsetAt(ms);
  if (guess - o2 !== ms) ms = guess - o2;
  return new Date(ms);
}

/** "2026-11-19" + "10:00" (Wiener Zeit) → Date. Gibt null bei ungültiger Eingabe. */
export function parseLocal(date: string, time = '00:00'): Date | null {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date ?? '');
  const tm = /^(\d{1,2}):(\d{2})$/.exec(time ?? '');
  if (!dm || !tm) return null;
  const [y, m, d] = [Number(dm[1]), Number(dm[2]), Number(dm[3])];
  const [h, mi] = [Number(tm[1]), Number(tm[2])];
  if (m < 1 || m > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const res = fromLocal(y, m, d, h, mi);
  const back = localParts(res);
  if (back.day !== d) return null;
  return res;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Date → "YYYY-MM-DD" in Wiener Zeit. */
export function localDate(d: Date | number): string {
  const p = localParts(d);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Date → "HH:MM" in Wiener Zeit. */
export function localTime(d: Date | number): string {
  const p = localParts(d);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** Tage auf ein "YYYY-MM-DD" addieren. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Wochentag eines "YYYY-MM-DD" (0 = Montag). */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

/** Montag der Woche eines "YYYY-MM-DD". */
export function mondayOf(date: string): string {
  return addDays(date, -weekdayOf(date));
}

export function today(): string {
  return localDate(new Date());
}

/** Beginn eines lokalen Tages als Date. */
export function dayStart(date: string): Date {
  return parseLocal(date, '00:00')!;
}

export function isValidDate(date: string | null | undefined): date is string {
  return !!date && /^\d{4}-\d{2}-\d{2}$/.test(date) && parseLocal(date) !== null;
}

const de = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('de-AT', { timeZone: TZ, ...opts });
const fmtLong = de({ weekday: 'long', day: 'numeric', month: 'long' });
const fmtLongYear = de({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const fmtShort = de({ weekday: 'short', day: 'numeric', month: 'short' });
const fmtDayMonth = de({ day: 'numeric', month: 'long' });
const fmtNumeric = de({ day: '2-digit', month: '2-digit', year: 'numeric' });
const fmtWdShort = de({ weekday: 'short' });
const fmtMonShort = de({ month: 'short' });
const fmtMonthYear = de({ month: 'long', year: 'numeric' });

export const fmt = {
  /** Donnerstag, 19. November */
  long: (d: Date | number) => fmtLong.format(d),
  longYear: (d: Date | number) => fmtLongYear.format(d),
  /** Do., 19. Nov. → "Do 19. Nov" */
  short: (d: Date | number) => fmtShort.format(d).replace(/\./g, '').replace(/,/, '').replace(/(\d+) /, '$1. '),
  dayMonth: (d: Date | number) => fmtDayMonth.format(d),
  numeric: (d: Date | number) => fmtNumeric.format(d),
  time: (d: Date | number) => localTime(d),
  range: (s: Date | number, e: Date | number) => `${localTime(s)}–${localTime(e)}`,
  wdShort: (d: Date | number) => fmtWdShort.format(d).replace('.', ''),
  monShort: (d: Date | number) => fmtMonShort.format(d).replace('.', ''),
  monthYear: (d: Date | number) => fmtMonthYear.format(d),
  dateTime: (d: Date | number) => `${fmtNumeric.format(d)} ${localTime(d)}`,
};

export function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}
