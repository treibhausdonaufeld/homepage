import { defineMiddleware } from 'astro:middleware';
import { ensureStarted } from './lib/boot';
import { getSession } from './lib/auth/session';
import { config } from './lib/config';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ');

const PUBLIC_ADMIN = ['/admin/login', '/admin/callback'];

export const onRequest = defineMiddleware(async (ctx, next) => {
  if (ctx.isPrerendered) return next();

  await ensureStarted();

  const fwd = ctx.request.headers.get('x-forwarded-for');
  ctx.locals.ip = (config.trustProxy && fwd ? fwd.split(',')[0].trim() : ctx.clientAddress) || 'unknown';
  ctx.locals.admin = null;

  const path = ctx.url.pathname.replace(/\/$/, '');
  if (path === '/admin' || path.startsWith('/admin/')) {
    ctx.locals.admin = getSession(ctx.cookies);
    if (!ctx.locals.admin && !PUBLIC_ADMIN.includes(path)) {
      return ctx.redirect(`/admin/login?next=${encodeURIComponent(ctx.url.pathname + ctx.url.search)}`);
    }
  }

  const res = await next();
  res.headers.set('Content-Security-Policy', CSP);
  res.headers.set('X-Content-Type-Options', 'nosniff');
  res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (config.publicUrl.startsWith('https://'))
    res.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (path.startsWith('/admin') || path.startsWith('/b/') || path.startsWith('/buchen')) {
    res.headers.set('Cache-Control', 'no-store');
    res.headers.set('X-Robots-Tag', 'noindex');
  }
  return res;
});
