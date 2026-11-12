import type { APIRoute } from 'astro';
import { sql } from 'drizzle-orm';
import { getDb } from '../lib/db';
import { mailHealth } from '../lib/notify/mail';
import { getMatrixBot } from '../lib/notify/matrix';
import { rocketchatEnabled } from '../lib/notify/rocketchat';

export const prerender = false;

/** Zustand für Monitoring: Datenbank (kritisch), SMTP und Matrix (nur gemeldet). */
export const GET: APIRoute = async () => {
  let db: { ok: boolean; error?: string } = { ok: true };
  try {
    getDb().get(sql`select 1`);
  } catch (err) {
    db = { ok: false, error: (err as Error).message };
  }
  const mail = await mailHealth();
  const bot = getMatrixBot();
  const matrix = bot ? { configured: true, ok: bot.connected, userId: bot.userId, error: bot.lastError ?? undefined } : { configured: false, ok: true };
  const rocketchat = { configured: rocketchatEnabled() };
  const ok = db.ok;
  return new Response(JSON.stringify({ ok, db, mail, matrix, rocketchat }), {
    status: ok ? 200 : 503,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};
