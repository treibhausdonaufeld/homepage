import type { Booking, BookingKind, BookingStatus, Room, Slot } from '../db/schema';

export const BLOCKING_STATUSES: BookingStatus[] = ['vorlaeufig', 'bestaetigt'];
export const FINAL_STATUSES: BookingStatus[] = ['abgelehnt', 'storniert', 'abgelaufen'];

export const STATUS_LABEL: Record<BookingStatus, string> = {
  unbestaetigt: 'unbestätigt',
  vorlaeufig: 'vorläufig',
  bestaetigt: 'bestätigt',
  abgelehnt: 'abgelehnt',
  storniert: 'storniert',
  abgelaufen: 'abgelaufen',
};

export const KIND_LABEL: Record<BookingKind, string> = {
  privat: 'privat',
  gemeinnuetzig: 'gemeinnützig / Initiative',
  kommerziell: 'kommerziell',
  intern: 'intern (Haus)',
};

export const CATEGORIES = ['werkstatt', 'bewegung', 'essen', 'kinder', 'kultur', 'treffen'] as const;
export type Category = (typeof CATEGORIES)[number];
export const CATEGORY_LABEL: Record<Category, string> = {
  werkstatt: 'Werkstatt',
  bewegung: 'Bewegung',
  essen: 'Essen',
  kinder: 'Kinder',
  kultur: 'Kultur',
  treffen: 'Treffen',
};

/** Öffentlich sichtbarer Zustand einer Zeitspanne – nie mit Namen oder Zweck. */
export type AvailabilityState = 'frei' | 'angefragt' | 'belegt' | 'gesperrt';

export interface Segment {
  start: Date;
  end: Date;
  state: AvailabilityState;
}

export interface CandidateSlot {
  roomSlug: string;
  start: Date;
  end: Date;
  endWithBuffer: Date;
  /** Index des Vorkommens (bei Serien), 0 = erstes */
  occurrence: number;
}

export interface Conflict {
  occurrence: number;
  roomSlug: string;
  start: Date;
  end: Date;
  type: 'booking' | 'block';
  bookingId?: number;
  status?: BookingStatus;
  reason?: string;
}

export interface BookingView {
  booking: Booking;
  room: Room;
  /** Belegte Zeiten (ein Eintrag pro Vorkommen, ohne übersprungene). */
  occurrences: { start: Date; end: Date }[];
  skipped: { start: Date; end: Date }[];
  slots: Slot[];
  seriesRule: string | null;
  seriesUntil: Date | null;
}

export interface PublicEvent {
  key: string;
  bookingId: number;
  title: string;
  roomSlug: string;
  roomName: string;
  start: Date;
  end: Date;
  category: string | null;
  offer: string | null;
}

export class BookingError extends Error {
  constructor(
    public code:
      | 'not-found'
      | 'invalid'
      | 'conflict'
      | 'state'
      | 'rate-limit'
      | 'capacity'
      | 'matrix-unreachable'
      | 'send-failed',
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'BookingError';
  }
}

export class ConflictError extends BookingError {
  constructor(
    public conflicts: Conflict[],
    message = 'Diese Zeit ist leider schon vergeben.',
  ) {
    super('conflict', message);
    this.name = 'ConflictError';
  }
}

/** Was die Benachrichtigungen (Mail, Matrix) können müssen. Die Buchungslogik kennt nur dieses Interface. */
export interface Notifier {
  /** Code + Link zur Bestätigung des Kontakts. Wirft BookingError('matrix-unreachable'), wenn die Matrix-ID nicht erreichbar ist. */
  sendCode(view: BookingView, code: string, link: string): Promise<void>;
  received(view: BookingView, manageUrl: string): Promise<void>;
  confirmed(view: BookingView, manageUrl: string, ics: string): Promise<void>;
  rejected(view: BookingView, note: string | null): Promise<void>;
  expired(view: BookingView, reason: 'hold' | 'conflict'): Promise<void>;
  cancelled(view: BookingView, byHouse: boolean, note: string | null): Promise<void>;
  /** Meldung an die Raum-AG (interner Matrix-Raum, optional Mail). */
  admin(text: string, html?: string): Promise<void>;
}
