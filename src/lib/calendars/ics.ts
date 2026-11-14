/**
 * Kleiner iCalendar-Parser (RFC 5545) für abonnierte Kalender, z. B. Nextcloud-Exporte.
 *
 * Unterstützt: gefaltete Zeilen, Escapes, DTSTART/DTEND/DURATION mit TZID, UTC (Z),
 * schwebender Zeit und ganztägigen Terminen (VALUE=DATE), RRULE mit EXDATE,
 * geänderte Einzeltermine (RECURRENCE-ID) und abgesagte Termine (STATUS:CANCELLED).
 * Serien werden in einem Zeitfenster aufgelöst; jedes Vorkommen wird ein Eintrag.
 */
import rrulePkg from 'rrule';
import { DAY, TZ } from '../time';

const { RRule } = rrulePkg;

export interface IcsOccurrence {
  uid: string;
  start: Date;
  end: Date;
  allDay: boolean;
  title: string;
  location: string | null;
}

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

/** Wanduhrzeit als „schwebende“ Millisekunden (Date.UTC der lokalen Werte). */
type Wall = number;

interface DateValue {
  wall: Wall;
  /** IANA-Zeitzone, 'UTC' oder null (schwebend = Wiener Zeit). */
  tz: string;
  allDay: boolean;
}

interface RawEvent {
  uid: string;
  start: DateValue;
  end: DateValue | null;
  durationMs: number | null;
  title: string;
  location: string | null;
  rrule: string | null;
  exdates: number[];
  recurrenceId: number | null;
  cancelled: boolean;
}

// ---------------------------------------------------------------- Zeitzonen

const fmtCache = new Map<string, Intl.DateTimeFormat | null>();
function zoneFmt(tz: string): Intl.DateTimeFormat | null {
  if (!fmtCache.has(tz)) {
    try {
      fmtCache.set(
        tz,
        new Intl.DateTimeFormat('en-US', {
          timeZone: tz,
          hourCycle: 'h23',
          year: 'numeric',
          month: 'numeric',
          day: 'numeric',
          hour: 'numeric',
          minute: 'numeric',
          second: 'numeric',
        }),
      );
    } catch {
      fmtCache.set(tz, null);
    }
  }
  return fmtCache.get(tz)!;
}

/** Bekannte Zeitzone oder Wien (z. B. bei Windows-Namen wie „W. Europe Standard Time“). */
function zone(tz: string | undefined | null): string {
  if (!tz) return TZ;
  const clean = tz.replace(/^\/+/, '');
  if (clean.toUpperCase() === 'UTC' || clean === 'Etc/UTC' || clean === 'GMT') return 'UTC';
  return zoneFmt(clean) ? clean : TZ;
}

/** UTC-Zeitpunkt → Wanduhrzeit in tz. */
function toWall(ms: number, tz: string): Wall {
  if (tz === 'UTC') return ms;
  const p: Record<string, number> = {};
  for (const { type, value } of zoneFmt(tz)!.formatToParts(new Date(ms))) p[type] = Number(value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
}

/** Wanduhrzeit in tz → UTC-Zeitpunkt. */
function fromWall(wall: Wall, tz: string): number {
  if (tz === 'UTC') return wall;
  let ms = wall - (toWall(wall, tz) - wall);
  const corr = toWall(ms, tz) - wall;
  if (corr !== 0) ms -= corr;
  return ms;
}

// ---------------------------------------------------------------- Zeilen

function unfold(text: string): string[] {
  return text.replace(/\r\n|\r/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

function parseLine(line: string): Prop | null {
  // Name und Parameter bis zum ersten ':' außerhalb von Anführungszeichen
  let i = 0;
  let quoted = false;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === ':' && !quoted) break;
  }
  if (i >= line.length) return null;
  const head = line.slice(0, i);
  const value = line.slice(i + 1);
  const parts = head.match(/(?:[^;"]|"[^"]*")+/g) ?? [];
  const name = (parts.shift() ?? '').toUpperCase();
  const params: Record<string, string> = {};
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name, params, value };
}

function unescape(v: string): string {
  return v.replace(/\\([\\;,nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c)).trim();
}

function parseDate(value: string, params: Record<string, string>): DateValue | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  const allDay = params.VALUE === 'DATE' || h === undefined;
  const wall = Date.UTC(+y, +mo - 1, +d, allDay ? 0 : +h, allDay ? 0 : +mi, allDay ? 0 : +(s ?? 0));
  const tz = z ? 'UTC' : zone(params.TZID);
  return { wall, tz, allDay };
}

function instant(dv: DateValue): number {
  // Ganztägige Termine gelten in Wiener Ortszeit (Mitternacht bis Mitternacht).
  return fromWall(dv.wall, dv.allDay ? TZ : dv.tz);
}

/** ISO-8601-Dauer wie P1D, PT1H30M, P1W, -PT15M → ms. */
export function parseDuration(v: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return null;
  const [, sign, w, d, h, mi, s] = m;
  const ms = ((+(w ?? 0) * 7 + +(d ?? 0)) * 24 * 3600 + +(h ?? 0) * 3600 + +(mi ?? 0) * 60 + +(s ?? 0)) * 1000;
  return sign === '-' ? -ms : ms;
}

// ---------------------------------------------------------------- Parsen

function parseEvents(text: string): RawEvent[] {
  const out: RawEvent[] = [];
  let cur: Partial<RawEvent> | null = null;
  let depth = 0; // verschachtelte Komponenten (VALARM) überspringen
  for (const line of unfold(text)) {
    if (!line) continue;
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === 'BEGIN') {
      if (p.value.toUpperCase() === 'VEVENT' && !cur) {
        cur = { exdates: [], cancelled: false, location: null, rrule: null, end: null, durationMs: null, recurrenceId: null };
        depth = 0;
      } else if (cur) depth++;
      continue;
    }
    if (p.name === 'END') {
      if (cur && depth > 0) depth--;
      else if (cur && p.value.toUpperCase() === 'VEVENT') {
        if (cur.start) {
          out.push({
            ...cur,
            uid: cur.uid || `${cur.start.wall}-${cur.title ?? ''}`,
            title: cur.title || 'Termin',
          } as RawEvent);
        }
        cur = null;
      }
      continue;
    }
    if (!cur || depth > 0) continue;
    switch (p.name) {
      case 'UID':
        cur.uid = p.value.trim();
        break;
      case 'SUMMARY':
        cur.title = unescape(p.value);
        break;
      case 'LOCATION':
        cur.location = unescape(p.value) || null;
        break;
      case 'DTSTART':
        cur.start = parseDate(p.value, p.params) ?? undefined;
        break;
      case 'DTEND':
        cur.end = parseDate(p.value, p.params);
        break;
      case 'DURATION':
        cur.durationMs = parseDuration(p.value);
        break;
      case 'RRULE':
        cur.rrule = p.value.trim();
        break;
      case 'EXDATE':
        for (const v of p.value.split(',')) {
          const dv = parseDate(v, p.params);
          if (dv) cur.exdates!.push(instant(dv));
        }
        break;
      case 'RECURRENCE-ID': {
        const dv = parseDate(p.value, p.params);
        if (dv) cur.recurrenceId = instant(dv);
        break;
      }
      case 'STATUS':
        cur.cancelled = p.value.trim().toUpperCase() === 'CANCELLED';
        break;
    }
  }
  return out;
}

/** Dauer eines Termins in Wanduhr-ms (ganztägig ohne Ende: 1 Tag). */
function wallDuration(e: RawEvent): number {
  if (e.end) {
    const d = e.end.wall - e.start.wall;
    // Ende in anderer Zone als Beginn: über echte Zeitpunkte rechnen
    if (!e.start.allDay && e.end.tz !== e.start.tz) return instant(e.end) - instant(e.start);
    return Math.max(0, d);
  }
  if (e.durationMs !== null) return Math.max(0, e.durationMs);
  return e.start.allDay ? DAY : 0;
}

function occurrence(e: RawEvent, startWall: Wall, dur: number): IcsOccurrence {
  const tz = e.start.allDay ? TZ : e.start.tz;
  const start = fromWall(startWall, tz);
  // Ende als Wanduhrzeit, damit ganztägige Termine über die Zeitumstellung bei Mitternacht enden
  const end = fromWall(startWall + dur, tz);
  return {
    uid: e.uid,
    start: new Date(start),
    end: new Date(Math.max(end, start)),
    allDay: e.start.allDay,
    title: e.title,
    location: e.location,
  };
}

/**
 * Alle Vorkommen, die das Fenster [from, to) berühren.
 * `maxPerEvent` begrenzt unendliche Serien (z. B. täglich ohne Ende).
 */
export function parseIcs(text: string, from: Date, to: Date, maxPerEvent = 500): IcsOccurrence[] {
  const events = parseEvents(text);
  const masters = events.filter((e) => e.recurrenceId === null);
  const overrides = events.filter((e) => e.recurrenceId !== null);
  const overridden = new Map<string, Set<number>>();
  for (const o of overrides) {
    if (!overridden.has(o.uid)) overridden.set(o.uid, new Set());
    overridden.get(o.uid)!.add(o.recurrenceId!);
  }

  const out: IcsOccurrence[] = [];
  const inWindow = (o: IcsOccurrence) => o.start < to && o.end > from && o.end >= o.start;

  for (const e of masters) {
    if (e.cancelled) continue;
    const dur = wallDuration(e);
    if (!e.rrule) {
      const o = occurrence(e, e.start.wall, dur);
      if (inWindow(o)) out.push(o);
      continue;
    }
    const tz = e.start.allDay ? TZ : e.start.tz;
    let opts;
    try {
      opts = RRule.parseString(e.rrule.replace(/^RRULE:/i, ''));
    } catch {
      // Unbekannte Regel: nur das erste Vorkommen
      const o = occurrence(e, e.start.wall, dur);
      if (inWindow(o)) out.push(o);
      continue;
    }
    opts.dtstart = new Date(e.start.wall);
    opts.tzid = null;
    if (opts.until) opts.until = new Date(toWall(opts.until.getTime(), tz));
    const rule = new RRule(opts);
    const skip = new Set([...e.exdates, ...(overridden.get(e.uid) ?? [])]);
    const winStart = new Date(toWall(from.getTime(), tz) - dur - DAY);
    const winEnd = new Date(toWall(to.getTime(), tz) + DAY);
    let n = 0;
    for (const occ of rule.between(winStart, winEnd, true)) {
      const o = occurrence(e, occ.getTime(), dur);
      if (skip.has(o.start.getTime())) continue;
      if (!inWindow(o)) continue;
      out.push(o);
      if (++n >= maxPerEvent) break;
    }
  }

  for (const e of overrides) {
    if (e.cancelled) continue;
    const o = occurrence(e, e.start.wall, wallDuration(e));
    if (inWindow(o)) out.push(o);
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}
