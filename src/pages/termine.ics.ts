import type { APIRoute } from 'astro';
import { getDb } from '../lib/db';
import { publicEvents } from '../lib/booking/service';
import { eventsFeed } from '../lib/ical';
import { DAY } from '../lib/time';

export const prerender = false;

/** iCal-Feed aller öffentlichen Termine (30 Tage zurück, 1 Jahr voraus). */
export const GET: APIRoute = () => {
  const now = Date.now();
  const events = publicEvents(getDb(), new Date(now - 30 * DAY), new Date(now + 365 * DAY), 2000);
  return new Response(eventsFeed(events), {
    headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
  });
};
