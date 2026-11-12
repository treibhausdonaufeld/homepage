import crypto from 'node:crypto';
import { config } from '../config';

function secret(): string {
  if (!config.hmacSecret) throw new Error('HMAC_SECRET ist nicht gesetzt');
  return config.hmacSecret;
}

/** HMAC-SHA256 als base64url – so werden Codes, Tokens und Kontakte gespeichert. */
export function hmac(value: string, purpose = 'v1'): string {
  return crypto.createHmac('sha256', secret()).update(`${purpose}:${value}`).digest('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** 6-stelliger Code, gleichverteilt. */
export function randomCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

export function randomToken(bytes = 24): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Kurze öffentliche ID einer Buchung (nicht geheim, aber nicht erratbar). */
export function publicId(): string {
  return crypto.randomBytes(9).toString('base64url');
}

export function normalizeContact(channel: string, address: string): string {
  const a = address.trim();
  return channel === 'email' ? a.toLowerCase() : a;
}

export function contactHash(channel: string, address: string): string {
  return hmac(`${channel}:${normalizeContact(channel, address)}`, 'contact');
}

export const codeHash = (verificationKey: string, code: string) => hmac(`${verificationKey}:${code}`, 'code');
export const tokenHash = (token: string) => hmac(token, 'link');

/**
 * Verwaltungslink: `<publicId>.<signatur>`. Die Signatur lässt sich aus dem Server-Geheimnis
 * neu berechnen (so kann jede Nachricht den Link enthalten), in der Datenbank steht nur ihr Hash.
 */
export function manageToken(bookingPublicId: string): string {
  return `${bookingPublicId}.${hmac(bookingPublicId, 'manage').slice(0, 32)}`;
}
export const manageTokenHash = (token: string) => hmac(token, 'manage-hash');

/** Signierter Zeitstempel fürs Formular (Mindestzeit zum Ausfüllen). */
export function formStamp(at = Date.now()): string {
  return `${at}.${hmac(String(at), 'form').slice(0, 16)}`;
}
export function checkFormStamp(stamp: string | null | undefined, minSeconds: number): 'ok' | 'too-fast' | 'invalid' {
  if (!stamp) return 'invalid';
  const [at, sig] = stamp.split('.');
  if (!at || !sig || !safeEqual(sig, hmac(at, 'form').slice(0, 16))) return 'invalid';
  const age = Date.now() - Number(at);
  if (age < minSeconds * 1000) return 'too-fast';
  if (age > 24 * 3600 * 1000) return 'invalid';
  return 'ok';
}

/** Signierte Werte (z. B. Session-Cookie). */
export function sign(payload: object, key: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', key).update(body).digest('base64url');
  return `${body}.${sig}`;
}
export function unsign<T>(value: string | undefined, key: string): T | null {
  if (!value) return null;
  const [body, sig] = value.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', key).update(body).digest('base64url');
  if (!safeEqual(sig, expected)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString()) as T;
  } catch {
    return null;
  }
}
