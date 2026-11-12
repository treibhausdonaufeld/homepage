import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { config } from '../config';
import * as schema from './schema';

export type DB = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

/** Öffnet eine SQLite-Datenbank im WAL-Modus und spielt die Migrationen ein. */
export function openDb(file: string, migrationsDir = config.migrationsDir): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  const db = drizzle(sqlite, { schema }) as DB;
  migrate(db, { migrationsFolder: path.resolve(migrationsDir) });
  return db;
}

const g = globalThis as unknown as { __treibhausDb?: DB };

/** Gemeinsame Verbindung für Webserver, Bot und Jobs. */
export function getDb(): DB {
  if (!g.__treibhausDb) g.__treibhausDb = openDb(config.databasePath);
  return g.__treibhausDb;
}

/** Nur für Tests: andere Verbindung setzen. */
export function setDb(db: DB | undefined) {
  g.__treibhausDb = db;
}

export { schema };
