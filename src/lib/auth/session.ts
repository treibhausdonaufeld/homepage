import type { AstroCookies } from 'astro';
import { config } from '../config';
import { sign, unsign } from '../verify/tokens';

export interface AdminSession {
  sub: string;
  name: string;
  email?: string;
  exp: number;
}

const COOKIE = 'th_admin';
const MAX_AGE = 8 * 3600; // 8 Stunden

const secure = () => config.publicUrl.startsWith('https://');

export function getSession(cookies: AstroCookies): AdminSession | null {
  const s = unsign<AdminSession>(cookies.get(COOKIE)?.value, config.sessionSecret);
  if (!s || s.exp < Date.now()) return null;
  return s;
}

export function setSession(cookies: AstroCookies, data: Omit<AdminSession, 'exp'>) {
  const value = sign({ ...data, exp: Date.now() + MAX_AGE * 1000 }, config.sessionSecret);
  cookies.set(COOKIE, value, { httpOnly: true, secure: secure(), sameSite: 'lax', path: '/', maxAge: MAX_AGE });
}

export function clearSession(cookies: AstroCookies) {
  cookies.delete(COOKIE, { path: '/' });
}

/** Kurzlebiges Cookie für den OIDC-Ablauf (state, PKCE). */
export function setFlowCookie(cookies: AstroCookies, data: object) {
  cookies.set('th_oidc', sign({ ...data, exp: Date.now() + 10 * 60_000 }, config.sessionSecret), {
    httpOnly: true,
    secure: secure(),
    sameSite: 'lax',
    path: '/admin',
    maxAge: 600,
  });
}

export function takeFlowCookie<T>(cookies: AstroCookies): (T & { exp: number }) | null {
  const v = unsign<T & { exp: number }>(cookies.get('th_oidc')?.value, config.sessionSecret);
  cookies.delete('th_oidc', { path: '/admin' });
  if (!v || v.exp < Date.now()) return null;
  return v;
}
