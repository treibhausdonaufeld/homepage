import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** Alle Zeitpunkte werden als UTC-Millisekunden gespeichert. */
const ts = (name: string) => integer(name, { mode: 'timestamp_ms' });
const now = sql`(unixepoch('subsec') * 1000)`;

export const BOOKING_STATUS = [
  'unbestaetigt',
  'vorlaeufig',
  'bestaetigt',
  'abgelehnt',
  'storniert',
  'abgelaufen',
] as const;
export type BookingStatus = (typeof BOOKING_STATUS)[number];

export const BOOKING_KINDS = ['privat', 'gemeinnuetzig', 'kommerziell', 'intern'] as const;
export type BookingKind = (typeof BOOKING_KINDS)[number];

export const CHANNELS = ['email', 'matrix', 'intern'] as const;
export type Channel = (typeof CHANNELS)[number];

export const rooms = sqliteTable('rooms', {
  slug: text('slug').primaryKey(),
  name: text('name').notNull(),
  capacity: integer('capacity').notNull(),
  bufferMinutes: integer('buffer_minutes').notNull().default(30),
  autoApprove: integer('auto_approve', { mode: 'boolean' }).notNull().default(false),
  /** Kombinierter Raum: Liste der Räume, die er belegt (JSON). */
  combines: text('combines', { mode: 'json' }).$type<string[] | null>(),
  bookable: integer('bookable', { mode: 'boolean' }).notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  /**
   * Stichwörter im Ort (LOCATION) eines abonnierten Kalendertermins, bei denen dieser Raum
   * gesperrt wird (JSON-Liste). null = Raumname. Groß/klein und ä/ae egal.
   */
  locationKeywords: text('location_keywords', { mode: 'json' }).$type<string[] | null>(),
});

export const bookings = sqliteTable(
  'bookings',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    publicId: text('public_id').notNull(),
    status: text('status', { enum: BOOKING_STATUS }).notNull(),
    roomSlug: text('room_slug')
      .notNull()
      .references(() => rooms.slug),
    purpose: text('purpose'),
    kind: text('kind', { enum: BOOKING_KINDS }).notNull(),
    persons: integer('persons').notNull(),
    isPublic: integer('is_public', { mode: 'boolean' }).notNull().default(false),
    /** Kategorie im Terminkalender (werkstatt, bewegung, essen, kinder, kultur, treffen). */
    category: text('category'),
    /** Verknüpftes Angebot aus der Content Collection (slug). */
    offer: text('offer'),
    name: text('name'),
    contactChannel: text('contact_channel', { enum: CHANNELS }).notNull(),
    contactAddress: text('contact_address'),
    /** HMAC der normalisierten Kontaktadresse, für Rate-Limit und vertraute Kontakte. */
    contactHash: text('contact_hash'),
    rulesAcceptedAt: ts('rules_accepted_at'),
    holdUntil: ts('hold_until'),
    decidedBy: text('decided_by'),
    decidedAt: ts('decided_at'),
    decisionNote: text('decision_note'),
    cancelReason: text('cancel_reason'),
    manageTokenHash: text('manage_token_hash'),
    verifiedAt: ts('verified_at'),
    /** Ab diesem Zeitpunkt werden Name und Kontakt entfernt. */
    deleteAfter: ts('delete_after'),
    anonymizedAt: ts('anonymized_at'),
    createdAt: ts('created_at').notNull().default(now),
  },
  (t) => [
    uniqueIndex('bookings_public_id').on(t.publicId),
    index('bookings_status').on(t.status),
    index('bookings_manage').on(t.manageTokenHash),
  ],
);

export const slots = sqliteTable(
  'slots',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    bookingId: integer('booking_id')
      .notNull()
      .references(() => bookings.id, { onDelete: 'cascade' }),
    /** Physischer Raum (bei Kombinationen ein Slot je Raum). */
    roomSlug: text('room_slug').notNull(),
    start: ts('start').notNull(),
    end: ts('end').notNull(),
    endWithBuffer: ts('end_with_buffer').notNull(),
    /** Serientermin, der wegen eines Konflikts nicht reserviert wurde. */
    skipped: integer('skipped', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [index('slots_room_time').on(t.roomSlug, t.start, t.endWithBuffer), index('slots_booking').on(t.bookingId)],
);

export const series = sqliteTable('series', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  bookingId: integer('booking_id')
    .notNull()
    .references(() => bookings.id, { onDelete: 'cascade' }),
  rule: text('rule').notNull(),
  until: ts('until').notNull(),
});

export const blocks = sqliteTable('blocks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** null = alle Räume */
  roomSlug: text('room_slug'),
  /** Erstes (oder einziges) Vorkommen. */
  start: ts('start').notNull(),
  end: ts('end').notNull(),
  /** Optionale Wiederholung als RRULE (in Wiener Ortszeit ausgewertet), z. B. FREQ=DAILY. */
  rule: text('rule'),
  until: ts('until'),
  reason: text('reason').notNull(),
  createdBy: text('created_by').notNull(),
  createdAt: ts('created_at').notNull().default(now),
});

export const verifications = sqliteTable(
  'verifications',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    bookingId: integer('booking_id')
      .notNull()
      .references(() => bookings.id, { onDelete: 'cascade' }),
    channel: text('channel', { enum: ['email', 'matrix'] }).notNull(),
    codeHash: text('code_hash').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: ts('expires_at').notNull(),
    attempts: integer('attempts').notNull().default(0),
    confirmedAt: ts('confirmed_at'),
    createdAt: ts('created_at').notNull().default(now),
  },
  (t) => [index('verifications_token').on(t.tokenHash), index('verifications_booking').on(t.bookingId)],
);

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    at: ts('at').notNull().default(now),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    bookingId: integer('booking_id'),
    details: text('details'),
  },
  (t) => [index('audit_booking').on(t.bookingId)],
);

export const trustedContacts = sqliteTable('trusted_contacts', {
  contactHash: text('contact_hash').primaryKey(),
  approvedCount: integer('approved_count').notNull().default(0),
  trusted: integer('trusted', { mode: 'boolean' }).notNull().default(false),
  updatedAt: ts('updated_at').notNull().default(now),
});

export const rateLimits = sqliteTable(
  'rate_limits',
  {
    key: text('key').notNull(),
    windowStart: integer('window_start').notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.key, t.windowStart] })],
);

export type Room = typeof rooms.$inferSelect;
export type Booking = typeof bookings.$inferSelect;
export type Slot = typeof slots.$inferSelect;
export type Block = typeof blocks.$inferSelect;
export type Verification = typeof verifications.$inferSelect;

export const NOTIFY_KINDS = ['email', 'rocketchat', 'matrix'] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];

/**
 * Interne Benachrichtigungen an die Raum-AG. Hier steht nur das Ziel
 * (Adresse, Channel, Raum) – Zugangsdaten kommen aus Umgebungsvariablen.
 */
export const notificationTargets = sqliteTable('notification_targets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  kind: text('kind', { enum: NOTIFY_KINDS }).notNull(),
  /** E-Mail-Adresse, Rocket.Chat-Channel (#raum-ag) oder Matrix-Raum (!id:server / #alias:server) */
  target: text('target').notNull(),
  label: text('label'),
  /** Ereignisse, bei denen benachrichtigt wird (JSON-Liste) */
  events: text('events', { mode: 'json' }).$type<string[]>().notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdBy: text('created_by').notNull(),
  createdAt: ts('created_at').notNull().default(now),
  lastSentAt: ts('last_sent_at'),
  lastError: text('last_error'),
});

export type NotificationTarget = typeof notificationTargets.$inferSelect;

/** Abonnierte externe Kalender (iCal/ICS-URL, z. B. Nextcloud-Freigabe mit ?export). */
export const calendarSubscriptions = sqliteTable('calendar_subscriptions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  label: text('label').notNull(),
  url: text('url').notNull(),
  /** Termine als öffentliche Termine auf der Website zeigen. */
  showPublic: integer('show_public', { mode: 'boolean' }).notNull().default(false),
  /** Räume sperren, wenn der Ort eines Termins zu einem Raum passt. */
  blockRooms: integer('block_rooms', { mode: 'boolean' }).notNull().default(true),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdBy: text('created_by').notNull(),
  createdAt: ts('created_at').notNull().default(now),
  lastFetchedAt: ts('last_fetched_at'),
  lastError: text('last_error'),
  eventCount: integer('event_count').notNull().default(0),
});

/** Vorkommen aus abonnierten Kalendern (bei jedem Abruf neu geschrieben, Serien aufgelöst). */
export const externalEvents = sqliteTable(
  'external_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    subscriptionId: integer('subscription_id')
      .notNull()
      .references(() => calendarSubscriptions.id, { onDelete: 'cascade' }),
    uid: text('uid').notNull(),
    start: ts('start').notNull(),
    end: ts('end').notNull(),
    allDay: integer('all_day', { mode: 'boolean' }).notNull().default(false),
    title: text('title').notNull(),
    location: text('location'),
  },
  (t) => [index('external_events_time').on(t.start, t.end), index('external_events_sub').on(t.subscriptionId)],
);

export type CalendarSubscription = typeof calendarSubscriptions.$inferSelect;
export type ExternalEvent = typeof externalEvents.$inferSelect;
