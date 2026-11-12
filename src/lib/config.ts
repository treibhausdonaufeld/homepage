/**
 * Konfiguration aus Umgebungsvariablen.
 *
 * Werte, die die Hausgemeinschaft noch festlegen muss (Haltefrist, Löschfrist,
 * Code-Gültigkeit …), haben Platzhalter-Standardwerte und lassen sich ohne
 * Codeänderung über Umgebungsvariablen anpassen.
 */

const env = (name: string, fallback = ''): string => process.env[name] ?? fallback;
const num = (name: string, fallback: number): number => {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const bool = (name: string, fallback: boolean): boolean => {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'ja', 'on'].includes(v.toLowerCase());
};

const isProd = process.env.NODE_ENV === 'production';

export const config = {
  isProd,
  publicUrl: env('PUBLIC_URL', 'http://localhost:4321').replace(/\/$/, ''),
  timezone: 'Europe/Vienna',

  databasePath: env('DATABASE_PATH', './data/treibhaus.db'),
  migrationsDir: env('MIGRATIONS_DIR', './drizzle'),
  backupDir: env('BACKUP_DIR', ''),
  backupKeep: num('BACKUP_KEEP', 7),
  seed: bool('SEED', true),

  sessionSecret: env('SESSION_SECRET', isProd ? '' : 'dev-session-secret-bitte-aendern'),
  hmacSecret: env('HMAC_SECRET', isProd ? '' : 'dev-hmac-secret-bitte-aendern'),
  trustProxy: bool('TRUST_PROXY', true),

  contactEmail: env('CONTACT_EMAIL', 'hallo@treibhausdonaufeld.at'),
  matrixHalloRoom: env('MATRIX_HALLO_ROOM', '#hallo:treibhausdonaufeld.at'),

  smtp: {
    host: env('SMTP_HOST'),
    port: num('SMTP_PORT', 587),
    secure: bool('SMTP_SECURE', false),
    user: env('SMTP_USER'),
    pass: env('SMTP_PASS'),
    from: env('SMTP_FROM', 'Treibhaus Donaufeld <hallo@treibhausdonaufeld.at>'),
  },

  matrix: {
    homeserver: env('MATRIX_HOMESERVER').replace(/\/$/, ''),
    token: env('MATRIX_BOT_TOKEN'),
    stateFile: env('MATRIX_STATE_FILE', './data/matrix-bot.json'),
  },

  /** Rocket.Chat: Bot-Benutzer mit persönlichem Zugangstoken. Der Channel wird im Admin eingestellt. */
  rocketchat: {
    url: env('ROCKETCHAT_URL').replace(/\/$/, ''),
    userId: env('ROCKETCHAT_USER_ID'),
    token: env('ROCKETCHAT_TOKEN'),
  },

  oidc: {
    issuer: env('OIDC_ISSUER'),
    clientId: env('OIDC_CLIENT_ID'),
    clientSecret: env('OIDC_CLIENT_SECRET'),
    adminGroup: env('OIDC_ADMIN_GROUP', 'raum-ag'),
    scopes: env('OIDC_SCOPES', 'openid profile email'),
  },
  /** Nur für lokale Entwicklung: Admin-Login ohne Authentik. */
  devAdminLogin: bool('DEV_ADMIN_LOGIN', !isProd),

  listmonk: {
    url: env('LISTMONK_URL').replace(/\/$/, ''),
    listUuids: env('LISTMONK_LIST_UUIDS').split(',').map((s) => s.trim()).filter(Boolean),
  },

  booking: {
    /** TODO Hausgemeinschaft: Wie lange gilt ein Code (Minuten)? */
    codeTtlMinutes: num('CODE_TTL_MINUTES', 30),
    codeMaxAttempts: num('CODE_MAX_ATTEMPTS', 3),
    /** TODO Hausgemeinschaft: Haltefrist für vorläufige Anfragen (Stunden). */
    holdHours: num('HOLD_HOURS', 72),
    /** TODO Hausgemeinschaft: Antwortzeit der Raum-AG, nur für Texte. */
    responseTimeText: env('RESPONSE_TIME_TEXT', '3 Werktagen'),
    /** Unbestätigte Anfragen werden nach so vielen Stunden gelöscht. */
    unconfirmedDeleteHours: num('UNCONFIRMED_DELETE_HOURS', 24),
    /** TODO Hausgemeinschaft: Löschfrist personenbezogener Daten (Monate nach dem Termin). */
    retentionMonths: num('RETENTION_MONTHS', 6),
    /** Bis wann eine Serie höchstens aufgelöst wird (Wochen). */
    seriesMaxWeeks: num('SERIES_MAX_WEEKS', 26),
    /** Wie weit im Voraus gebucht werden kann (Tage). */
    maxAdvanceDays: num('MAX_ADVANCE_DAYS', 365),
    /** Buchbare Tageszeiten (lokal). */
    dayStartHour: num('DAY_START_HOUR', 8),
    dayEndHour: num('DAY_END_HOUR', 22),
    /** Bekannte Kontakte ab so vielen freigegebenen Buchungen automatisch vertrauen (0 = aus). */
    trustAfterApprovals: num('TRUST_AFTER_APPROVALS', 0),
    /** Mindestzeit zum Ausfüllen des Formulars (Sekunden). */
    minFormSeconds: num('MIN_FORM_SECONDS', 3),
  },

  rateLimit: {
    requestsPerIpPerHour: num('RATE_LIMIT_IP_PER_HOUR', 10),
    requestsPerContactPerDay: num('RATE_LIMIT_CONTACT_PER_DAY', 5),
    codeSendsPerBooking: num('RATE_LIMIT_CODE_SENDS', 4),
  },
};

export type Config = typeof config;

/** Prüft beim Start, ob in Produktion alle Pflichtwerte gesetzt sind. */
export function configProblems(): string[] {
  const problems: string[] = [];
  if (!config.hmacSecret) problems.push('HMAC_SECRET fehlt');
  if (!config.sessionSecret) problems.push('SESSION_SECRET fehlt');
  if (config.isProd && !process.env.PUBLIC_URL) problems.push('PUBLIC_URL ist nicht gesetzt');
  return problems;
}
