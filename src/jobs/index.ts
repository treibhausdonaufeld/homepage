/** Hintergrundjobs im selben Prozess wie der Webserver. */
import fs from 'node:fs';
import path from 'node:path';
import { Cron } from 'croner';
import { config } from '../lib/config';
import type { DB } from '../lib/db';
import { anonymize, deleteUnconfirmed, expireHolds } from '../lib/booking/service';
import type { Notifier } from '../lib/booking/types';
import { cleanupRateLimits } from '../lib/verify/ratelimit';
import { log } from '../lib/log';
import { localDate } from '../lib/time';

const opts = { timezone: 'Europe/Vienna', protect: true, catch: (err: unknown) => log.error('Job fehlgeschlagen', { err }) };

/** Snapshot der Datenbank mit VACUUM INTO, die letzten N werden behalten. */
export function snapshot(db: DB) {
  if (!config.backupDir) return null;
  fs.mkdirSync(config.backupDir, { recursive: true });
  const file = path.join(config.backupDir, `treibhaus-${localDate(new Date())}.db`);
  if (fs.existsSync(file)) fs.rmSync(file);
  db.$client.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const old = fs
    .readdirSync(config.backupDir)
    .filter((f) => /^treibhaus-\d{4}-\d{2}-\d{2}\.db$/.test(f))
    .sort()
    .reverse()
    .slice(config.backupKeep);
  for (const f of old) fs.rmSync(path.join(config.backupDir, f));
  log.info('Snapshot geschrieben', { file });
  return file;
}

export function startJobs(db: DB, notifier: Notifier): Cron[] {
  return [
    // Haltefrist: jede Minute
    new Cron('* * * * *', { ...opts, name: 'haltefrist' }, async () => {
      const n = await expireHolds(db, notifier);
      if (n) log.info('Vorläufige Anfragen abgelaufen', { count: n });
    }),
    // Unbestätigte Anfragen löschen, Rate-Limits aufräumen: stündlich
    new Cron('7 * * * *', { ...opts, name: 'aufraeumen' }, () => {
      const n = deleteUnconfirmed(db);
      cleanupRateLimits(db);
      if (n) log.info('Unbestätigte Anfragen gelöscht', { count: n });
    }),
    // Löschfrist: nächtlich
    new Cron('17 3 * * *', { ...opts, name: 'loeschfrist' }, () => {
      const n = anonymize(db);
      if (n) log.info('Buchungen anonymisiert', { count: n });
    }),
    // Snapshot: nächtlich
    new Cron('37 3 * * *', { ...opts, name: 'snapshot' }, () => {
      snapshot(db);
    }),
  ];
}
