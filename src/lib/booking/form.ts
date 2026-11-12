/** Eingaben des Buchungsformulars: Parsen und Validieren (Zod), mit deutschen Fehlermeldungen. */
import { z } from 'zod';
import { config } from '../config';
import { MATRIX_ID_RE } from '../notify/matrix';
import { isValidDate, parseLocal } from '../time';
import { SERIES_RULES } from './recurrence';

export interface TimeFields {
  raum: string;
  datum: string;
  von: string;
  bis: string;
  serie: string;
  serie_bis: string;
}

export interface DetailFields {
  name: string;
  zweck: string;
  personen: string;
  art: string;
  oeffentlich: string;
  regeln: string;
}

export interface ContactFields {
  kanal: string;
  email: string;
  matrix: string;
}

export type AllFields = TimeFields & DetailFields & ContactFields;

export const FIELD_NAMES: (keyof AllFields)[] = [
  'raum', 'datum', 'von', 'bis', 'serie', 'serie_bis',
  'name', 'zweck', 'personen', 'art', 'oeffentlich', 'regeln',
  'kanal', 'email', 'matrix',
];

export function readFields(src: URLSearchParams | FormData): AllFields {
  const out = {} as AllFields;
  for (const k of FIELD_NAMES) {
    const v = src.get(k);
    out[k] = typeof v === 'string' ? v.slice(0, 2000) : '';
  }
  return out;
}

/** Felder als Query-String (nur Zeitwahl, keine personenbezogenen Daten). */
export function timeQuery(f: Partial<TimeFields>): string {
  const p = new URLSearchParams();
  for (const k of ['raum', 'datum', 'von', 'bis', 'serie', 'serie_bis'] as const) if (f[k]) p.set(k, f[k]!);
  return p.toString();
}

export function timeOptions(): string[] {
  const out: string[] = [];
  for (let h = config.booking.dayStartHour; h <= config.booking.dayEndHour; h++) {
    for (const m of [0, 30]) {
      if (h === config.booking.dayEndHour && m > 0) break;
      out.push(`${String(h).padStart(2, '0')}:${m ? '30' : '00'}`);
    }
  }
  return out;
}

export interface ParsedTime {
  start: Date | null;
  end: Date | null;
  seriesRule: string | null;
  seriesUntil: Date | null;
  errors: Record<string, string>;
}

export function parseTime(f: TimeFields): ParsedTime {
  const errors: Record<string, string> = {};
  if (!isValidDate(f.datum)) errors.datum = 'Bitte wähl einen Tag.';
  const start = isValidDate(f.datum) ? parseLocal(f.datum, f.von) : null;
  const end = isValidDate(f.datum) ? parseLocal(f.datum, f.bis) : null;
  if (!start) errors.von = 'Bitte wähl, wann du anfängst.';
  if (!end) errors.bis = 'Bitte wähl, wann du fertig bist.';
  let seriesRule: string | null = null;
  let seriesUntil: Date | null = null;
  if (f.serie) {
    seriesRule = SERIES_RULES[f.serie]?.rule ?? null;
    if (!seriesRule) errors.serie = 'Bitte wähl, wie oft.';
    if (!isValidDate(f.serie_bis)) errors.serie_bis = 'Bitte gib an, bis wann die Serie läuft.';
    else {
      seriesUntil = parseLocal(f.serie_bis, '23:59');
      if (start && seriesUntil && seriesUntil <= start) errors.serie_bis = 'Das Ende der Serie muss nach dem ersten Termin liegen.';
    }
  }
  return { start, end, seriesRule, seriesUntil, errors };
}

const KINDS = ['privat', 'gemeinnuetzig', 'kommerziell'] as const;

export const detailSchema = z.object({
  name: z.string().trim().min(2, 'Bitte gib deinen Namen an.').max(100, 'Der Name ist zu lang.'),
  zweck: z.string().trim().min(3, 'Bitte schreib kurz, was du vorhast.').max(300, 'Bitte fass dich kürzer (höchstens 300 Zeichen).'),
  personen: z.coerce
    .number({ error: 'Bitte gib eine Zahl an.' })
    .int('Bitte gib eine ganze Zahl an.')
    .min(1, 'Bitte gib an, wie viele Personen ungefähr kommen.')
    .max(500, 'Bitte gib eine realistische Zahl an.'),
  art: z.enum(KINDS, { error: 'Bitte wähl, wofür du den Raum brauchst.' }),
  oeffentlich: z.string().optional(),
  regeln: z.literal('ja', { error: 'Bitte lies die Hausregeln und hak das Kästchen an.' }),
});

export type Details = z.infer<typeof detailSchema>;

export function parseDetails(f: DetailFields): { data?: Details; errors: Record<string, string> } {
  const r = detailSchema.safeParse(f);
  if (r.success) return { data: r.data, errors: {} };
  const errors: Record<string, string> = {};
  for (const issue of r.error.issues) {
    const k = String(issue.path[0]);
    if (!errors[k]) errors[k] = issue.message;
  }
  return { errors };
}

export function parseContact(f: ContactFields): { channel?: 'email' | 'matrix'; address?: string; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  if (f.kanal === 'email') {
    const r = z.email().max(200).safeParse(f.email.trim());
    if (!r.success) errors.email = 'Bitte prüf deine E-Mail-Adresse.';
    else return { channel: 'email', address: r.data, errors };
  } else if (f.kanal === 'matrix') {
    const id = f.matrix.trim();
    if (!MATRIX_ID_RE.test(id)) errors.matrix = 'Prüf die Schreibweise: @name:server, z. B. @amira:matrix.org';
    else return { channel: 'matrix', address: id, errors };
  } else {
    errors.kanal = 'Bitte wähl, wie wir dir schreiben sollen.';
  }
  return { errors };
}

export const FIELD_LABEL: Record<string, string> = {
  name: 'Name',
  zweck: 'Was hast du vor?',
  personen: 'Personenzahl',
  art: 'Wofür?',
  regeln: 'Hausregeln',
  email: 'E-Mail-Adresse',
  matrix: 'Matrix-ID',
  kanal: 'Bestätigungsweg',
  datum: 'Tag',
  von: 'Beginn',
  bis: 'Ende',
  zeit: 'Zeit',
  serie: 'Wiederholung',
  serie_bis: 'Serie bis',
};

/** a***@example.org */
export function maskEmail(e: string | null | undefined): string {
  if (!e) return '';
  const [u, d] = e.split('@');
  return `${u.slice(0, 1)}${'*'.repeat(Math.max(2, Math.min(u.length - 1, 5)))}@${d}`;
}
