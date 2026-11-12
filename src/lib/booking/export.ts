import type { BookingView } from './types';
import { KIND_LABEL, STATUS_LABEL } from './types';
import { localDate, localTime } from '../time';

const cell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  // CSV-Injection in Tabellenprogrammen verhindern
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[";\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** CSV (Semikolon, UTF-8 mit BOM – öffnet sauber in Excel/LibreOffice). */
export function bookingsCsv(views: BookingView[], from: Date, to: Date): string {
  const head = ['Nr', 'Status', 'Raum', 'Datum', 'Von', 'Bis', 'Stunden', 'Zweck', 'Art', 'Personen', 'Öffentlich', 'Name', 'Kontaktweg', 'Kontakt', 'Freigegeben von'];
  const rows = [head.join(';')];
  for (const v of views) {
    for (const o of v.occurrences) {
      if (!(o.start < to && o.end > from)) continue;
      const b = v.booking;
      rows.push(
        [
          b.id,
          STATUS_LABEL[b.status],
          v.room.name,
          localDate(o.start),
          localTime(o.start),
          localTime(o.end),
          ((o.end.getTime() - o.start.getTime()) / 3600000).toFixed(2).replace('.', ','),
          b.purpose,
          KIND_LABEL[b.kind],
          b.persons,
          b.isPublic ? 'ja' : 'nein',
          b.name,
          b.contactChannel,
          b.contactAddress,
          b.decidedBy,
        ]
          .map(cell)
          .join(';'),
      );
    }
  }
  return '﻿' + rows.join('\r\n') + '\r\n';
}
