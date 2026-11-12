import type { APIRoute } from 'astro';
import { clearSession } from '../../lib/auth/session';

export const prerender = false;

export const POST: APIRoute = ({ cookies, redirect }) => {
  clearSession(cookies);
  return redirect('/', 303);
};
