import type { APIRoute } from 'astro';
import { getDb } from '../../lib/db';
import { publicEvents } from '../../lib/booking/service';
import { eventsFeed } from '../../lib/ical';
import { DAY } from '../../lib/time';

export const prerender = false;

/** Einzelner öffentlicher Termin als .ics („In meinen Kalender“). */
export const GET: APIRoute = ({ params }) => {
  const key = params.key ?? '';
  const ts = Number(key.split('-').pop());
  if (!Number.isFinite(ts)) return new Response('Nicht gefunden', { status: 404 });
  const ev = publicEvents(getDb(), new Date(ts - DAY), new Date(ts + DAY)).find((e) => e.key === key);
  if (!ev) return new Response('Nicht gefunden', { status: 404 });
  return new Response(eventsFeed([ev], ev.title), {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'attachment; filename="treibhaus-termin.ics"',
    },
  });
};
