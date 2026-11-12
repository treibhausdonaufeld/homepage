import type { APIRoute } from 'astro';
import { getDb } from '../../lib/db';
import { bookingView, getBookingByManageToken, manageUrl } from '../../lib/booking/service';
import { bookingIcs } from '../../lib/ical';

export const prerender = false;

export const GET: APIRoute = ({ params }) => {
  const db = getDb();
  const b = getBookingByManageToken(db, params.token ?? '');
  if (!b || !['vorlaeufig', 'bestaetigt'].includes(b.status)) return new Response('Nicht gefunden', { status: 404 });
  return new Response(bookingIcs(bookingView(db, b), manageUrl(b)), {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'attachment; filename="treibhaus-buchung.ics"',
      'Cache-Control': 'no-store',
    },
  });
};
