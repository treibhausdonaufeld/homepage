import type { APIRoute } from 'astro';
import { getDb } from '../../lib/db';
import { getBookingByPublicId } from '../../lib/booking/service';

export const prerender = false;

/** Status einer Anfrage (nur der Status, keine Daten). Für die Matrix-Warteseite. */
export const GET: APIRoute = ({ url }) => {
  const b = getBookingByPublicId(getDb(), url.searchParams.get('b') ?? '');
  return new Response(JSON.stringify({ status: b?.status ?? null }), {
    status: b ? 200 : 404,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};
