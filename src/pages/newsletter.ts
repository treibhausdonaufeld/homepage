import type { APIRoute } from 'astro';
import { z } from 'zod';
import { config } from '../lib/config';
import { getDb } from '../lib/db';
import { log } from '../lib/log';
import { hit } from '../lib/verify/ratelimit';
import { checkFormStamp } from '../lib/verify/tokens';

export const prerender = false;

/** Newsletter-Anmeldung: leitet an die öffentliche Abo-Schnittstelle von listmonk weiter (Double-Opt-in dort). */
export const POST: APIRoute = async ({ request, locals, redirect }) => {
  const f = await request.formData();
  const backRaw = String(f.get('back') ?? '/');
  const back = backRaw.startsWith('/') && !backRaw.startsWith('//') ? backRaw : '/';
  const to = (s: string) => redirect(`${back}?newsletter=${s}#newsletter`, 303);

  if (String(f.get('website') ?? '')) return to('ok'); // Honeypot
  if (checkFormStamp(String(f.get('stamp') ?? ''), 2) === 'too-fast') return to('error');
  const email = z.string().trim().email().max(200).safeParse(f.get('email'));
  if (!email.success) return to('error');
  const db = getDb();
  if (!hit(db, `nl-ip:${locals.ip}`, 5, 3600) || !hit(db, `nl-mail:${email.data.toLowerCase()}`, 3, 86400)) return to('error');

  if (!config.listmonk.url || !config.listmonk.listUuids.length) {
    log.info('Newsletter-Anmeldung (listmonk nicht konfiguriert)', { email: email.data });
    return to('ok');
  }
  try {
    const res = await fetch(`${config.listmonk.url}/api/public/subscription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.data, name: '', list_uuids: config.listmonk.listUuids }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      log.warn('listmonk lehnt Anmeldung ab', { status: res.status });
      return to('error');
    }
    return to('ok');
  } catch (err) {
    log.error('listmonk nicht erreichbar', { err });
    return to('error');
  }
};

export const GET: APIRoute = ({ redirect }) => redirect('/#newsletter');
