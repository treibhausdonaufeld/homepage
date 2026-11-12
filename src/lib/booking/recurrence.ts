import rrulePkg from 'rrule';
import { DAY, fromLocal, localParts } from '../time';

const { RRule } = rrulePkg;

export interface Interval {
  start: Date;
  end: Date;
}

/** Date → "schwebende" UTC-Zeit mit den Wiener Wanduhr-Werten. */
function floating(d: Date): Date {
  const p = localParts(d);
  return new Date(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute));
}

function unfloat(f: Date): Date {
  return fromLocal(f.getUTCFullYear(), f.getUTCMonth() + 1, f.getUTCDate(), f.getUTCHours(), f.getUTCMinutes());
}

/**
 * Löst eine Wiederholungsregel (RRULE ohne DTSTART, z. B. "FREQ=WEEKLY;INTERVAL=2")
 * in Wiener Ortszeit auf. Liefert alle Vorkommen, die [from, to) überschneiden.
 * Das erste Vorkommen ist (first.start, first.end).
 */
export function expandRule(
  first: Interval,
  rule: string | null | undefined,
  from: Date,
  to: Date,
  until?: Date | null,
): Interval[] {
  if (!rule) {
    return first.start < to && from < first.end ? [first] : [];
  }
  const fStart = floating(first.start);
  const fEnd = floating(first.end);
  const durMs = fEnd.getTime() - fStart.getTime();
  const opts = RRule.parseString(rule.replace(/^RRULE:/, ''));
  opts.dtstart = fStart;
  if (until) opts.until = floating(until);
  const rr = new RRule(opts);
  const windowStart = new Date(floating(from).getTime() - durMs - DAY);
  const windowEnd = new Date(floating(to).getTime() + DAY);
  const out: Interval[] = [];
  for (const occ of rr.between(windowStart, windowEnd, true)) {
    const start = unfloat(occ);
    const end = unfloat(new Date(occ.getTime() + durMs));
    if (start < to && from < end) out.push({ start, end });
  }
  return out;
}

/** Alle Vorkommen bis `until` (für Serien). */
export function expandAll(first: Interval, rule: string, until: Date, max = 200): Interval[] {
  return expandRule(first, rule, first.start, new Date(until.getTime() + DAY), until).slice(0, max);
}

export const SERIES_RULES: Record<string, { rule: string; label: string }> = {
  weekly: { rule: 'FREQ=WEEKLY', label: 'jede Woche' },
  biweekly: { rule: 'FREQ=WEEKLY;INTERVAL=2', label: 'alle 2 Wochen' },
  monthly: { rule: 'FREQ=MONTHLY', label: 'jeden Monat (gleicher Tag)' },
};

export function describeRule(rule: string | null | undefined): string {
  if (!rule) return '';
  const hit = Object.values(SERIES_RULES).find((r) => r.rule === rule);
  if (hit) return hit.label;
  if (rule === 'FREQ=DAILY') return 'täglich';
  return rule;
}
