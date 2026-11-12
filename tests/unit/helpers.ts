import { openDb, type DB } from '../../src/lib/db';
import { rooms, blocks } from '../../src/lib/db/schema';
import type { BookingView, Notifier } from '../../src/lib/booking/types';

export function testDb(): DB {
  const db = openDb(':memory:', './drizzle');
  db.insert(rooms)
    .values([
      { slug: 'saal', name: 'Viertelsaal', capacity: 60, bufferMinutes: 30, sortOrder: 1 },
      { slug: 'kueche', name: 'Viertelküche', capacity: 15, bufferMinutes: 30, sortOrder: 2 },
      { slug: 'beide', name: 'Saal + Küche', capacity: 75, bufferMinutes: 30, combines: ['saal', 'kueche'], sortOrder: 3 },
    ])
    .run();
  return db;
}

export function addNightBlock(db: DB, start: Date, end: Date) {
  db.insert(blocks).values({ roomSlug: null, start, end, rule: 'FREQ=DAILY', reason: 'Nachtruhe', createdBy: 'test' }).run();
}

export interface Sent {
  kind: string;
  view: BookingView;
  code?: string;
  link?: string;
}

export function fakeNotifier() {
  const sent: Sent[] = [];
  const admin: string[] = [];
  const n: Notifier = {
    async sendCode(view, code, link) {
      sent.push({ kind: 'code', view, code, link });
    },
    async received(view) {
      sent.push({ kind: 'received', view });
    },
    async confirmed(view) {
      sent.push({ kind: 'confirmed', view });
    },
    async rejected(view) {
      sent.push({ kind: 'rejected', view });
    },
    async expired(view) {
      sent.push({ kind: 'expired', view });
    },
    async cancelled(view) {
      sent.push({ kind: 'cancelled', view });
    },
    async admin(text) {
      admin.push(text);
    },
  };
  return { n, sent, admin };
}
