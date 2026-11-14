import type { APIRoute, AstroCookies } from 'astro';
import { config } from '../../lib/config';
import { getDb } from '../../lib/db';
import { HalloError, MAX_BODY, findConversation, messagesFor, sendGuestMessage } from '../../lib/hallo';
import { halloAvailable, halloTransport } from '../../lib/hallo/runtime';
import { log } from '../../lib/log';

export const prerender = false;

const COOKIE = 'hallo';
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });

function setToken(cookies: AstroCookies, token: string) {
  cookies.set(COOKIE, token, {
    path: '/api/hallo',
    httpOnly: true,
    sameSite: 'strict',
    secure: config.publicUrl.startsWith('https://'),
    maxAge: config.halloChat.retentionDays * 86_400,
  });
}

/** Status und Nachrichten des eigenen Gesprächs (`?nach=<id>` für nur neue). */
export const GET: APIRoute = ({ cookies, url }) => {
  const enabled = halloAvailable();
  const conv = findConversation(getDb(), cookies.get(COOKIE)?.value);
  const after = Math.max(0, Number(url.searchParams.get('nach')) || 0);
  return json({
    enabled,
    room: config.matrixHalloRoom,
    name: conv?.name ?? null,
    messages: conv ? messagesFor(getDb(), conv.id, after) : [],
  });
};

/** Nachricht schicken: JSON { name?, text, website? (Honigtopf) }. */
export const POST: APIRoute = async ({ request, cookies, locals, url }) => {
  // JSON von der eigenen Seite (fremde Seiten können ohne CORS kein JSON schicken; Origin trotzdem prüfen)
  const origin = request.headers.get('origin');
  if (origin && new URL(origin).host !== url.host) return json({ error: 'Nicht erlaubt.' }, 403);
  if (!request.headers.get('content-type')?.includes('application/json')) return json({ error: 'Ungültige Anfrage.' }, 415);
  if (!halloAvailable()) return json({ error: 'Der Chat ist gerade nicht erreichbar.' }, 503);

  let data: Record<string, unknown>;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY * 8) return json({ error: 'Die Nachricht ist zu lang.' }, 413);
    data = JSON.parse(raw);
  } catch {
    return json({ error: 'Ungültige Anfrage.' }, 400);
  }
  // Honigtopf: Bots füllen das versteckte Feld aus – so tun, als wäre alles gut
  if (typeof data.website === 'string' && data.website.trim()) return json({ ok: true, messages: [] });

  const db = getDb();
  try {
    const r = await sendGuestMessage(db, halloTransport(), {
      token: cookies.get(COOKIE)?.value,
      name: data.name,
      text: data.text,
      ip: locals.ip ?? 'unknown',
    });
    setToken(cookies, r.token);
    return json({ ok: true, name: r.conversation.name, messages: [r.message] });
  } catch (err) {
    if (err instanceof HalloError) {
      return json({ error: err.message }, err.code === 'invalid' ? 400 : err.code === 'limit' ? 429 : 503);
    }
    log.error('Website-Chat: Nachricht fehlgeschlagen', { err });
    return json({ error: 'Da ist etwas schiefgegangen.' }, 500);
  }
};
