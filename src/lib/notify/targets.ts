/**
 * Interne Benachrichtigungen der Raum-AG: Ziele (E-Mail, Rocket.Chat, Matrix) werden im
 * Admin-Bereich gepflegt, Zugangsdaten kommen aus Umgebungsvariablen.
 */
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { DB } from '../db';
import { notificationTargets, type NotificationTarget, type NotifyKind } from '../db/schema';
import { ADMIN_EVENT_KEYS, type AdminEvent, type AdminMessage } from '../booking/types';
import { config } from '../config';
import { log } from '../log';

export const KIND_LABEL: Record<NotifyKind, string> = {
  email: 'E-Mail',
  rocketchat: 'Rocket.Chat',
  matrix: 'Matrix',
};

export const TARGET_HINT: Record<NotifyKind, string> = {
  email: 'z. B. raum-ag@treibhausdonaufeld.at',
  rocketchat: 'Channel #raum-ag, Person @name oder Raum-ID',
  matrix: 'Raum-ID !abc:server oder Alias #raum-ag:server',
};

/** Ist der Kanal per Umgebungsvariablen eingerichtet? */
export function kindStatus(kind: NotifyKind): { ok: boolean; missing?: string } {
  if (kind === 'email')
    return config.smtp.host ? { ok: true } : { ok: false, missing: 'SMTP_HOST (Mails werden nur ins Log geschrieben)' };
  if (kind === 'rocketchat')
    return config.rocketchat.url && config.rocketchat.userId && config.rocketchat.token
      ? { ok: true }
      : { ok: false, missing: 'ROCKETCHAT_URL, ROCKETCHAT_USER_ID, ROCKETCHAT_TOKEN' };
  return config.matrix.homeserver && config.matrix.token
    ? { ok: true }
    : { ok: false, missing: 'MATRIX_HOMESERVER, MATRIX_BOT_TOKEN' };
}

const targetSchemas: Record<NotifyKind, z.ZodType<string>> = {
  email: z.email('Bitte eine gültige E-Mail-Adresse angeben.').max(200),
  rocketchat: z
    .string()
    .regex(/^([#@][\w.\-]{1,80}|[A-Za-z0-9]{10,40})$/, 'Bitte #channel, @person oder eine Raum-ID angeben.'),
  matrix: z.string().regex(/^[!#][^:\s]{1,255}:[a-z0-9.\-]+(:\d+)?$/i, 'Bitte eine Raum-ID (!abc:server) oder einen Alias (#name:server) angeben.'),
};

export interface TargetInput {
  kind: NotifyKind;
  target: string;
  label?: string | null;
  events: string[];
  enabled?: boolean;
}

/** Eingaben prüfen; gibt Fehlermeldung oder bereinigte Werte zurück. */
export function validateTarget(input: TargetInput): { error: string } | { value: Required<TargetInput> } {
  if (!(input.kind in targetSchemas)) return { error: 'Unbekannter Kanal.' };
  const r = targetSchemas[input.kind].safeParse(input.target.trim());
  if (!r.success) return { error: r.error.issues[0]?.message ?? 'Ungültiges Ziel.' };
  const events = input.events.filter((e): e is AdminEvent => (ADMIN_EVENT_KEYS as string[]).includes(e));
  if (!events.length) return { error: 'Bitte mindestens ein Ereignis wählen.' };
  return {
    value: {
      kind: input.kind,
      target: r.data,
      label: input.label?.trim().slice(0, 100) || null,
      events,
      enabled: input.enabled ?? true,
    },
  };
}

export function listTargets(db: DB): NotificationTarget[] {
  return db.select().from(notificationTargets).orderBy(asc(notificationTargets.id)).all();
}

export function addTarget(db: DB, actor: string, input: Required<TargetInput>) {
  return db
    .insert(notificationTargets)
    .values({ ...input, createdBy: actor })
    .returning()
    .get();
}

export function updateTarget(db: DB, id: number, input: Partial<typeof notificationTargets.$inferInsert>) {
  db.update(notificationTargets).set(input).where(eq(notificationTargets.id, id)).run();
}

export function deleteTarget(db: DB, id: number) {
  db.delete(notificationTargets).where(eq(notificationTargets.id, id)).run();
}

export function getTarget(db: DB, id: number) {
  return db.select().from(notificationTargets).where(eq(notificationTargets.id, id)).get();
}

/** Wie eine Meldung je Kanal aussieht. */
export function formatMessage(kind: NotifyKind, msg: AdminMessage) {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  switch (kind) {
    case 'email':
      return {
        subject: `[Raum-AG] ${msg.title}`,
        text: `${msg.title}\n\n${msg.text}${msg.url ? `\n\nIm Admin-Bereich ansehen: ${msg.url}` : ''}\n\n– Treibhaus Donaufeld, Raumbuchung`,
      };
    case 'rocketchat':
      return { text: `*${msg.title}*\n${msg.text}${msg.url ? `\n${msg.url}` : ''}` };
    case 'matrix':
      return {
        text: `${msg.title}: ${msg.text}${msg.url ? ` ${msg.url}` : ''}`,
        html: `<b>${esc(msg.title)}</b><br>${esc(msg.text).replace(/\n/g, '<br>')}${msg.url ? `<br><a href="${esc(msg.url)}">Im Admin-Bereich ansehen</a>` : ''}`,
      };
  }
}

export interface Senders {
  email(to: string, subject: string, text: string): Promise<void>;
  rocketchat(channel: string, text: string): Promise<void>;
  matrix(room: string, text: string, html: string): Promise<void>;
}

/** An ein einzelnes Ziel senden. Wirft bei Fehlern. */
export async function sendToTarget(t: Pick<NotificationTarget, 'kind' | 'target'>, msg: AdminMessage, senders: Senders) {
  if (t.kind === 'email') {
    const m = formatMessage('email', msg) as { subject: string; text: string };
    await senders.email(t.target, m.subject, m.text);
  } else if (t.kind === 'rocketchat') {
    await senders.rocketchat(t.target, (formatMessage('rocketchat', msg) as { text: string }).text);
  } else {
    const m = formatMessage('matrix', msg) as { text: string; html: string };
    await senders.matrix(t.target, m.text, m.html);
  }
}

/**
 * Meldung an alle aktiven Ziele, die das Ereignis abonniert haben. Fehler einzelner Ziele
 * halten die anderen nicht auf; Ergebnis (zuletzt gesendet / letzter Fehler) wird gespeichert.
 */
export async function dispatch(db: DB, event: AdminEvent, msg: AdminMessage, senders: Senders) {
  const targets = listTargets(db).filter((t) => t.enabled && t.events.includes(event));
  if (!targets.length) {
    log.info('Raum-AG-Meldung ohne Empfänger (keine Benachrichtigung für dieses Ereignis eingestellt)', { event, title: msg.title });
    return [];
  }
  return Promise.all(
    targets.map(async (t) => {
      try {
        await sendToTarget(t, msg, senders);
        updateTarget(db, t.id, { lastSentAt: new Date(), lastError: null });
        return { id: t.id, ok: true as const };
      } catch (err) {
        const error = (err as Error).message.slice(0, 300);
        log.error('Raum-AG-Benachrichtigung fehlgeschlagen', { kind: t.kind, targetId: t.id, err });
        updateTarget(db, t.id, { lastError: error });
        return { id: t.id, ok: false as const, error };
      }
    }),
  );
}
