import type { APIRoute } from 'astro';
import { getDb } from '../../lib/db';
import { listBookings } from '../../lib/booking/service';
import { adminFeed } from '../../lib/ical';
import { addDays, dayStart, isValidDate, today } from '../../lib/time';

export const prerender = false;

export const GET: APIRoute = ({ url }) => {
  const t = today();
  const von = isValidDate(url.searchParams.get('von')) ? url.searchParams.get('von')! : `${t.slice(0, 4)}-01-01`;
  const bis = isValidDate(url.searchParams.get('bis')) ? url.searchParams.get('bis')! : `${t.slice(0, 4)}-12-31`;
  const views = listBookings(getDb(), { statuses: ['vorlaeufig', 'bestaetigt'], from: dayStart(von), to: dayStart(addDays(bis, 1)) });
  return new Response(adminFeed(views), {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `attachment; filename="treibhaus-buchungen-${von}-${bis}.ics"`,
      'Cache-Control': 'no-store',
    },
  });
};
