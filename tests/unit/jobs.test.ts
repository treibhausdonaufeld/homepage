import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { config } from '../../src/lib/config';
import { openDb } from '../../src/lib/db';
import { snapshot } from '../../src/jobs';

describe('Snapshot', () => {
  it('schreibt eine lesbare Kopie und behält nur die letzten N', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'th-backup-'));
    const db = openDb(path.join(dir, 'live.db'), './drizzle');
    for (const d of ['2020-01-01', '2020-01-02']) fs.writeFileSync(path.join(dir, `treibhaus-${d}.db`), '');
    Object.assign(config, { backupDir: dir, backupKeep: 2 });
    const file = snapshot(db)!;
    expect(fs.existsSync(file)).toBe(true);
    const copy = openDb(file, './drizzle');
    expect(copy.$client.prepare('select count(*) n from rooms').get()).toEqual({ n: 0 });
    const left = fs.readdirSync(dir).filter((f) => /^treibhaus-.*\.db$/.test(f));
    expect(left).toHaveLength(2);
  });
});
