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
  /** null bei Terminen aus abonnierten Kalendern */
  bookingId: number | null;
  title: string;
  roomSlug: string;
  roomName: string;
  start: Date;
  end: Date;
  category: string | null;
  offer: string | null;
  /** Ganztägiger Termin (nur aus abonnierten Kalendern) */
  allDay?: boolean;
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

/** Ereignisse, zu denen die Raum-AG benachrichtigt werden kann. */
export const ADMIN_EVENTS = {
  abgeschickt: { label: 'Formular ausgefüllt, Code noch nicht eingegeben', hint: 'kann Spam sein', default: false },
  anfrage: { label: 'Neue Anfrage abgeschickt (Kontakt bestätigt, wartet auf Freigabe)', hint: '', default: true },
  auto: { label: 'Anfrage automatisch freigegeben', hint: '', default: true },
  storno: { label: 'Buchung von der buchenden Person storniert', hint: '', default: true },
  abgelaufen: { label: 'Haltefrist abgelaufen, ohne Entscheidung', hint: '', default: true },
  idee: { label: 'Neue Idee über „Selbst etwas anbieten“', hint: '', default: true },
} as const;
export type AdminEvent = keyof typeof ADMIN_EVENTS;
export const ADMIN_EVENT_KEYS = Object.keys(ADMIN_EVENTS) as AdminEvent[];

export interface AdminMessage {
  /** Kurzer Titel, z. B. „Neue Anfrage: Viertelsaal, Do 19. Nov“ */
  title: string;
  /** Ein, zwei Zeilen Details (Klartext) */
  text: string;
  /** Link in den Admin-Bereich */
  url?: string;
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
  /** Meldung an die Raum-AG – an alle im Admin eingestellten Ziele, die dieses Ereignis abonniert haben. */
  admin(event: AdminEvent, msg: AdminMessage): Promise<void>;
}
