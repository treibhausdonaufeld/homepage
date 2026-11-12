import type { APIRoute } from 'astro';
import { getDb } from '../../lib/db';
import { listBookings } from '../../lib/booking/service';
import { bookingsCsv } from '../../lib/booking/export';
import { addDays, dayStart, isValidDate, today } from '../../lib/time';

export const prerender = false;

export const GET: APIRoute = ({ url }) => {
  const t = today();
  const von = isValidDate(url.searchParams.get('von')) ? url.searchParams.get('von')! : `${t.slice(0, 4)}-01-01`;
  const bis = isValidDate(url.searchParams.get('bis')) ? url.searchParams.get('bis')! : `${t.slice(0, 4)}-12-31`;
  const from = dayStart(von);
  const to = dayStart(addDays(bis, 1));
  const views = listBookings(getDb(), { statuses: ['vorlaeufig', 'bestaetigt'], from, to });
  return new Response(bookingsCsv(views, from, to), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="treibhaus-buchungen-${von}-${bis}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
};
