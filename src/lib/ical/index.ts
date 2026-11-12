import ical, { ICalEventStatus } from 'ical-generator';
import { config } from '../config';
import type { BookingView, PublicEvent } from '../booking/types';

const LOCATION = 'Treibhaus Donaufeld, Simone-Veil-Gasse 7, 1210 Wien';

function calendar(name: string) {
  return ical({
    name,
    prodId: { company: 'Treibhaus Donaufeld', product: 'treibhaus-web', language: 'DE' },
    timezone: 'Europe/Vienna',
    ttl: 60 * 60,
  });
}

/** Feed der öffentlichen Termine. */
export function eventsFeed(events: PublicEvent[], name = 'Treibhaus Donaufeld – Termine'): string {
  const cal = calendar(name);
  for (const e of events) {
    cal.createEvent({
      id: `${e.key}@treibhausdonaufeld.at`,
      start: e.start,
      end: e.end,
      summary: e.title,
      location: `${e.roomName}, ${LOCATION}`,
      url: e.offer ? `${config.publicUrl}/angebote/${e.offer}` : `${config.publicUrl}/termine`,
    });
  }
  return cal.toString();
}

/** Anonyme Belegung eines Raums (nur „belegt“ bzw. „angefragt“). */
export function occupancyFeed(roomName: string, items: { key: string; start: Date; end: Date; state: string }[]): string {
  const cal = calendar(`${roomName} – Belegung`);
  for (const it of items) {
    cal.createEvent({
      id: `${it.key}@treibhausdonaufeld.at`,
      start: it.start,
      end: it.end,
      summary: `${roomName}: ${it.state}`,
      location: LOCATION,
      status: it.state === 'angefragt' ? ICalEventStatus.TENTATIVE : ICalEventStatus.CONFIRMED,
    });
  }
  return cal.toString();
}

/** .ics einer einzelnen Buchung (alle Vorkommen). */
export function bookingIcs(view: BookingView, manageUrl?: string): string {
  const cal = calendar(`${view.room.name} – Buchung`);
  view.occurrences.forEach((o, i) => {
    cal.createEvent({
      id: `b-${view.booking.publicId}-${i}@treibhausdonaufeld.at`,
      start: o.start,
      end: o.end,
      summary: `${view.room.name}${view.booking.purpose ? ` · ${view.booking.purpose}` : ''}`,
      location: LOCATION,
      description: manageUrl ? `Buchung verwalten: ${manageUrl}` : undefined,
      url: manageUrl,
      status: view.booking.status === 'bestaetigt' ? ICalEventStatus.CONFIRMED : ICalEventStatus.TENTATIVE,
    });
  });
  return cal.toString();
}

/** Admin-Export mit allen Angaben. */
export function adminFeed(views: BookingView[]): string {
  const cal = calendar('Treibhaus – alle Buchungen (intern)');
  for (const v of views) {
    v.occurrences.forEach((o, i) => {
      cal.createEvent({
        id: `a-${v.booking.publicId}-${i}@treibhausdonaufeld.at`,
        start: o.start,
        end: o.end,
        summary: `${v.room.name}: ${v.booking.purpose ?? '–'} (${v.booking.status})`,
        description: [v.booking.name, v.booking.kind, `${v.booking.persons} Personen`].filter(Boolean).join(' · '),
        location: LOCATION,
        status: v.booking.status === 'bestaetigt' ? ICalEventStatus.CONFIRMED : ICalEventStatus.TENTATIVE,
      });
    });
  }
  return cal.toString();
}
