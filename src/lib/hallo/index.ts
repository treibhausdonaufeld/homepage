/**
 * „Sag hallo“-Chat auf der Website.
 *
 * Gäste schreiben ohne Konto. Der Matrix-Bot postet die erste Nachricht eines Gesprächs als neuen
 * Beitrag in #hallo, jede weitere im Thread darunter. Antworten im Thread (oder direkte Antworten auf
 * eine dieser Nachrichten) werden dem Gast auf der Website angezeigt. Ein Gespräch hängt an einem
 * zufälligen Token im Cookie; gespeichert wird nur dessen HMAC.
 */
import { and, asc, eq, gt, inArray, lt } from 'drizzle-orm';
import { config } from '../config';
import type { DB } from '../db';
import { halloConversations, halloMessages, type HalloConversation, type HalloMessage } from '../db/schema';
import { hit } from '../verify/ratelimit';
import { hmac, randomToken } from '../verify/tokens';
import { DAY } from '../time';
import type { MatrixEvent } from '../notify/matrix';

/** Was der Chat vom Matrix-Bot braucht (im Test ersetzbar). */
export interface HalloTransport {
  /** Raum-ID von #hallo (Bot ist Mitglied). */
  roomId(): Promise<string>;
  send(roomId: string, text: string, html: string, extra: Record<string, unknown>): Promise<string>;
}

export const MAX_BODY = 1000;
export const MAX_NAME = 40;

export class HalloError extends Error {
  constructor(
    public code: 'invalid' | 'limit' | 'unavailable',
    message: string,
  ) {
    super(message);
  }
}

export interface PublicMessage {
  id: number;
  from: 'gast' | 'team';
  author: string | null;
  text: string;
  at: number;
}

const toPublic = (m: HalloMessage): PublicMessage => ({
  id: m.id,
  from: m.direction,
  author: m.direction === 'team' ? m.author : null,
  text: m.body,
  at: m.createdAt.getTime(),
});

// ---------------------------------------------------------------- Eingaben

/** Steuerzeichen raus, Leerzeilen begrenzen, kürzen. */
export function cleanText(input: unknown, max: number): string {
  return String(input ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** „@room“ nicht als Erwähnung aller wirken lassen. */
const defuse = (s: string) => s.replace(/@room\b/gi, '@⁠room');

/** Antwort-Zitat („> <@user> …“) am Anfang einer Matrix-Antwort entfernen. */
export function stripReplyFallback(body: string): string {
  const lines = body.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].startsWith('>')) i++;
  if (i > 0 && i < lines.length && lines[i].trim() === '') i++;
  return i > 0 ? lines.slice(i).join('\n').trim() : body.trim();
}

// ---------------------------------------------------------------- Gespräche

export function findConversation(db: DB, token: string | undefined | null): HalloConversation | undefined {
  if (!token || token.length > 100) return undefined;
  return db.select().from(halloConversations).where(eq(halloConversations.tokenHash, hmac(token, 'hallo'))).get();
}

export function messagesFor(db: DB, conversationId: number, afterId = 0, limit = 200): PublicMessage[] {
  return db
    .select()
    .from(halloMessages)
    .where(and(eq(halloMessages.conversationId, conversationId), gt(halloMessages.id, afterId)))
    .orderBy(asc(halloMessages.id))
    .limit(limit)
    .all()
    .map(toPublic);
}

/**
 * Nachricht eines Gasts annehmen und nach Matrix schicken.
 * Ohne gültiges Token wird ein neues Gespräch angelegt; das neue Token kommt zurück.
 */
export async function sendGuestMessage(
  db: DB,
  transport: HalloTransport,
  input: { token?: string | null; name?: unknown; text: unknown; ip: string },
): Promise<{ token: string; conversation: HalloConversation; message: PublicMessage }> {
  const text = cleanText(input.text, MAX_BODY);
  if (!text) throw new HalloError('invalid', 'Bitte schreib eine Nachricht.');
  const name = cleanText(input.name, MAX_NAME).replace(/\n/g, ' ') || null;

  let token = input.token ?? null;
  let conv = findConversation(db, token);

  // Rate-Limits: pro IP, pro Gespräch und für den ganzen Raum (Schutz vor Fluten)
  const ok =
    hit(db, `hallo:ip:${input.ip}`, 15, 600) &&
    hit(db, `hallo:ip-tag:${input.ip}`, 60, 86_400) &&
    (conv ? hit(db, `hallo:conv:${conv.id}`, 30, 3600) : hit(db, `hallo:neu:${input.ip}`, 3, 3600)) &&
    hit(db, 'hallo:alle', 200, 3600);
  if (!ok) throw new HalloError('limit', 'Du hast gerade sehr viele Nachrichten geschickt. Bitte warte ein bisschen.');

  let roomId: string;
  try {
    roomId = await transport.roomId();
  } catch {
    throw new HalloError('unavailable', 'Der Chat ist gerade nicht erreichbar.');
  }

  if (!conv) {
    token = randomToken();
    conv = db.insert(halloConversations).values({ tokenHash: hmac(token, 'hallo'), name, roomId }).returning().get();
  } else if (name && name !== conv.name) {
    db.update(halloConversations).set({ name }).where(eq(halloConversations.id, conv.id)).run();
    conv = { ...conv, name };
  }

  const who = conv.name ? `Gast „${conv.name}“` : 'Gast';
  const first = !conv.rootEventId || conv.roomId !== roomId;
  let body: string;
  let html: string;
  let extra: Record<string, unknown> = {};
  if (first) {
    body = `${who} (über die Website): ${defuse(text)}\n\n↪ Antworte im Thread – das sieht die Person auf der Website.`;
    html = `<b>${esc(who)}</b> <i>(über die Website)</i><br>${esc(defuse(text)).replace(/\n/g, '<br>')}<br><br><sub>↪ Antworte im Thread – das sieht die Person auf der Website.</sub>`;
  } else {
    const last = db
      .select({ eventId: halloMessages.eventId })
      .from(halloMessages)
      .where(eq(halloMessages.conversationId, conv.id))
      .orderBy(asc(halloMessages.id))
      .all()
      .filter((m) => m.eventId)
      .at(-1);
    body = `${who}: ${defuse(text)}`;
    html = `<b>${esc(who)}:</b> ${esc(defuse(text)).replace(/\n/g, '<br>')}`;
    extra = {
      'm.relates_to': {
        rel_type: 'm.thread',
        event_id: conv.rootEventId,
        is_falling_back: true,
        'm.in_reply_to': { event_id: last?.eventId ?? conv.rootEventId },
      },
    };
  }

  let eventId: string;
  try {
    eventId = await transport.send(roomId, body, html, extra);
  } catch {
    throw new HalloError('unavailable', 'Deine Nachricht konnte gerade nicht zugestellt werden.');
  }

  const now = new Date();
  const msg = db
    .insert(halloMessages)
    .values({ conversationId: conv.id, direction: 'gast', body: text, eventId, createdAt: now })
    .returning()
    .get();
  db.update(halloConversations)
    .set({ lastActivityAt: now, ...(first ? { rootEventId: eventId, roomId } : {}) })
    .where(eq(halloConversations.id, conv.id))
    .run();
  return { token: token!, conversation: { ...conv, ...(first ? { rootEventId: eventId, roomId } : {}) }, message: toPublic(msg) };
}

/**
 * Nachricht aus #hallo: gehört sie zu einem Gespräch (Thread-Antwort oder Antwort auf eine
 * Gesprächsnachricht), wird sie dem Gast angezeigt. Gibt die Gesprächs-ID zurück.
 */
export async function handleRoomMessage(
  db: DB,
  roomId: string,
  ev: MatrixEvent,
  displayName: (userId: string) => Promise<string>,
): Promise<number | null> {
  const rel = ev.content?.['m.relates_to'] ?? {};
  if (rel.rel_type === 'm.replace') return null; // Bearbeitungen ignorieren
  const threadRoot: string | undefined = rel.rel_type === 'm.thread' ? rel.event_id : undefined;
  const replyTo: string | undefined = rel['m.in_reply_to']?.event_id;
  if (!threadRoot && !replyTo) return null;

  let conv: HalloConversation | undefined;
  if (threadRoot) {
    conv = db
      .select()
      .from(halloConversations)
      .where(and(eq(halloConversations.rootEventId, threadRoot), eq(halloConversations.roomId, roomId)))
      .get();
  }
  if (!conv && replyTo) {
    const m = db.select().from(halloMessages).where(eq(halloMessages.eventId, replyTo)).get();
    if (m) conv = db.select().from(halloConversations).where(eq(halloConversations.id, m.conversationId)).get();
  }
  if (!conv) return null;
  if (db.select({ id: halloMessages.id }).from(halloMessages).where(eq(halloMessages.eventId, ev.event_id)).get()) return conv.id;

  const msgtype = ev.content?.msgtype;
  let body = typeof ev.content?.body === 'string' ? ev.content.body : '';
  if (msgtype && !['m.text', 'm.notice', 'm.emote'].includes(msgtype)) body = '(Datei oder Bild – bitte im Matrix-Raum ansehen)';
  body = cleanText(stripReplyFallback(body), 4000);
  if (!body) return null;
  const author = await displayName(ev.sender);
  const at = ev.origin_server_ts ? new Date(ev.origin_server_ts) : new Date();
  db.insert(halloMessages)
    .values({ conversationId: conv.id, direction: 'team', author, body: msgtype === 'm.emote' ? `* ${author} ${body}` : body, eventId: ev.event_id, createdAt: at })
    .onConflictDoNothing()
    .run();
  db.update(halloConversations).set({ lastActivityAt: new Date() }).where(eq(halloConversations.id, conv.id)).run();
  return conv.id;
}

/** Gespräche ohne Aktivität seit `retentionDays` löschen (mit Nachrichten). */
export function cleanupHallo(db: DB, retentionDays = config.halloChat.retentionDays): number {
  const cutoff = new Date(Date.now() - retentionDays * DAY);
  const old = db.select({ id: halloConversations.id }).from(halloConversations).where(lt(halloConversations.lastActivityAt, cutoff)).all();
  if (!old.length) return 0;
  db.delete(halloConversations).where(inArray(halloConversations.id, old.map((o) => o.id))).run();
  return old.length;
}
