import type { APIRoute } from 'astro';
import { getEntry } from 'astro:content';
import { getDb } from '../../lib/db';
import { getRoom, occupancy } from '../../lib/booking/service';
import { occupancyFeed } from '../../lib/ical';
import { DAY } from '../../lib/time';

export const prerender = false;

/** Anonyme Belegung eines Raums als iCal (ohne Namen oder Zwecke, ohne Sperrzeiten). */
export const GET: APIRoute = async ({ params }) => {
  const entry = await getEntry('rooms', params.slug ?? '');
  const db = getDb();
  const room = entry ? getRoom(db, entry.data.bookingId) : undefined;
  if (!room) return new Response('Nicht gefunden', { status: 404 });
  const now = Date.now();
  const segs = occupancy(db, room, new Date(now - 7 * DAY), new Date(now + 180 * DAY)).filter((s) => s.state !== 'gesperrt');
  const items = segs.map((s) => ({ key: `${room.slug}-${s.start.getTime()}`, start: s.start, end: s.end, state: s.state }));
  return new Response(occupancyFeed(room.name, items), {
    headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
  });
};
