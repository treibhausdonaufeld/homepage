import { and, eq, lt, sql } from 'drizzle-orm';
import type { DB } from '../db';
import { rateLimits } from '../db/schema';
import { hmac } from './tokens';

/**
 * Zählt einen Versuch für `key` im aktuellen Zeitfenster.
 * Gibt false zurück, wenn das Limit überschritten ist. Schlüssel werden gehasht gespeichert.
 */
export function hit(db: DB, key: string, limit: number, windowSeconds: number): boolean {
  const k = hmac(key, 'rl');
  const windowStart = Math.floor(Date.now() / 1000 / windowSeconds) * windowSeconds;
  const row = db
    .insert(rateLimits)
    .values({ key: k, windowStart, count: 1 })
    .onConflictDoUpdate({
      target: [rateLimits.key, rateLimits.windowStart],
      set: { count: sql`${rateLimits.count} + 1` },
    })
    .returning({ count: rateLimits.count })
    .get();
  return row.count <= limit;
}

/** Prüft, ohne zu zählen. */
export function isLimited(db: DB, key: string, limit: number, windowSeconds: number): boolean {
  const k = hmac(key, 'rl');
  const windowStart = Math.floor(Date.now() / 1000 / windowSeconds) * windowSeconds;
  const row = db
    .select({ count: rateLimits.count })
    .from(rateLimits)
    .where(and(eq(rateLimits.key, k), eq(rateLimits.windowStart, windowStart)))
    .get();
  return (row?.count ?? 0) >= limit;
}

export function cleanupRateLimits(db: DB) {
  const cutoff = Math.floor(Date.now() / 1000) - 2 * 86400;
  db.delete(rateLimits).where(lt(rateLimits.windowStart, cutoff)).run();
}
