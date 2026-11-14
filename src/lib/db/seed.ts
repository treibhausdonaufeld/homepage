import { count } from 'drizzle-orm';
import type { DB } from './index';
import { blocks, bookings, rooms } from './schema';
import { addDays, parseLocal, today, weekdayOf } from '../time';
import { createInternal } from '../booking/service';
import type { Notifier } from '../booking/types';
import { log } from '../log';

/**
 * Grunddaten beim ersten Start: Räume, Nachtruhe als Sperrzeit und der Samstagstreff
 * als erste öffentliche Serie. Alle Werte sind Platzhalter und im Admin-Bereich änderbar.
 */
export async function seed(db: DB, notifier: Notifier) {
  const hasRooms = db.select({ n: count() }).from(rooms).get()!.n > 0;
  if (!hasRooms) {
    db.insert(rooms)
      .values([
        { slug: 'viertelsaal', name: 'Viertelsaal', capacity: 60, bufferMinutes: 30, sortOrder: 1, locationKeywords: ['viertelsaal'] },
        { slug: 'viertelkueche', name: 'Viertelküche', capacity: 15, bufferMinutes: 30, sortOrder: 2, locationKeywords: ['viertelküche'] },
        {
          slug: 'saal-kueche',
          name: 'Saal + Küche',
          capacity: 75,
          bufferMinutes: 30,
          combines: ['viertelsaal', 'viertelkueche'],
          sortOrder: 3,
        },
        // Nicht öffentlich buchbar; wird über Termine aus abonnierten Kalendern gesperrt.
        { slug: 'werkstatt', name: 'Werkstatt', capacity: 10, bufferMinutes: 0, bookable: false, sortOrder: 4, locationKeywords: ['werkstatt'] },
      ])
      .run();
    log.info('Seed: Räume angelegt');

    // TODO Hausgemeinschaft: Nachtruhe ab wann? Platzhalter 22–8 Uhr.
    const d = today();
    db.insert(blocks)
      .values({
        roomSlug: null,
        start: parseLocal(d, '22:00')!,
        end: parseLocal(addDays(d, 1), '08:00')!,
        rule: 'FREQ=DAILY',
        reason: 'Nachtruhe',
        createdBy: 'System',
      })
      .run();
    log.info('Seed: Nachtruhe als Sperrzeit angelegt');
  }

  const hasBookings = db.select({ n: count() }).from(bookings).get()!.n > 0;
  if (!hasBookings) {
    // Samstagstreff: jeden Samstag 13:30–16:30 in der Viertelküche
    let sat = today();
    while (weekdayOf(sat) !== 5) sat = addDays(sat, 1);
    const start = parseLocal(sat, '13:30')!;
    if (start.getTime() < Date.now()) sat = addDays(sat, 7);
    await createInternal(db, notifier, 'System', {
      roomSlug: 'viertelkueche',
      start: parseLocal(sat, '13:30')!,
      end: parseLocal(sat, '16:30')!,
      seriesRule: 'FREQ=WEEKLY',
      seriesUntil: parseLocal(addDays(sat, 7 * 25), '23:59')!,
      purpose: 'Offener Nachbarschaftstreff',
      persons: 15,
      isPublic: true,
      category: 'treffen',
      offer: 'nachbarschaftstreff',
      name: 'Treibhaus',
    });
    log.info('Seed: Samstagstreff als Serie angelegt');
  }
}
