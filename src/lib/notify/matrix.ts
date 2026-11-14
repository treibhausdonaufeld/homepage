/**
 * Schlanker Matrix-Bot über die Client-Server-API (fetch, ohne SDK).
 * Legt unverschlüsselte Direktnachrichten-Räume an, schickt Codes und meldet Anfragen im Raum-AG-Raum.
 * Antworten mit einem 6-stelligen Code in der Direktnachricht werden an einen Handler gegeben.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config';
import { log } from '../log';

export class MatrixError extends Error {
  constructor(
    message: string,
    public status: number,
    public errcode?: string,
  ) {
    super(message);
  }
}

interface BotState {
  since?: string;
  dms: Record<string, string>;
}

type CodeHandler = (sender: string, code: string, roomId: string) => Promise<string | null>;
/** Nachricht in einem beobachteten Raum (nicht vom Bot selbst). */
export type RoomMessageHandler = (roomId: string, event: MatrixEvent) => Promise<void> | void;
export interface MatrixEvent {
  event_id: string;
  sender: string;
  type: string;
  origin_server_ts?: number;
  content: Record<string, any>;
}

export class MatrixBot {
  userId: string | null = null;
  connected = false;
  lastError: string | null = null;
  private state: BotState = { dms: {} };
  private running = false;
  /** Räume für Benachrichtigungen der Raum-AG (aufgelöste IDs); Einladungen dorthin nimmt der Bot an. */
  private notifyRooms = new Set<string>();
  private aliasCache = new Map<string, string>();
  private joined = new Set<string>();
  private onCode: CodeHandler | null = null;
  /** Beobachtete Räume (z. B. #hallo für den Website-Chat); Einladungen dorthin nimmt der Bot an. */
  private listeners = new Map<string, RoomMessageHandler>();
  private displayNames = new Map<string, { name: string; at: number }>();

  constructor(
    private homeserver: string,
    private token: string,
    private stateFile: string,
  ) {}

  private async req<T = any>(method: string, p: string, body?: unknown, timeoutMs = 20_000): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.homeserver}/_matrix/client/v3${p}`, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      const json = (await res.json().catch(() => ({}))) as any;
      if (!res.ok) throw new MatrixError(json.error ?? res.statusText, res.status, json.errcode);
      return json as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private loadState() {
    try {
      this.state = { dms: {}, ...JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) };
    } catch {
      this.state = { dms: {} };
    }
  }

  private saveState() {
    try {
      fs.mkdirSync(path.dirname(path.resolve(this.stateFile)), { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify(this.state));
    } catch (err) {
      log.warn('Matrix-Zustand konnte nicht gespeichert werden', { err });
    }
  }

  async start(onCode: CodeHandler) {
    this.onCode = onCode;
    this.loadState();
    try {
      const who = await this.req<{ user_id: string }>('GET', '/account/whoami');
      this.userId = who.user_id;
      this.connected = true;
      log.info('Matrix-Bot verbunden', { userId: this.userId });
    } catch (err) {
      this.lastError = (err as Error).message;
      log.error('Matrix-Bot konnte sich nicht anmelden', { err });
    }
    this.running = true;
    void this.syncLoop();
  }

  stop() {
    this.running = false;
  }

  /** Raum-ID oder Alias (#name:server) in eine Raum-ID auflösen. */
  async resolveRoom(room: string): Promise<string> {
    if (!room.startsWith('#')) return room;
    const cached = this.aliasCache.get(room);
    if (cached) return cached;
    const res = await this.req<{ room_id: string }>('GET', `/directory/room/${encodeURIComponent(room)}`);
    this.aliasCache.set(room, res.room_id);
    return res.room_id;
  }

  private async ensureJoined(roomId: string) {
    if (this.joined.has(roomId)) return;
    await this.req('POST', `/join/${encodeURIComponent(roomId)}`, {});
    this.joined.add(roomId);
  }

  /** Benachrichtigungsräume aus dem Admin übernehmen: auflösen und beitreten (wenn möglich). */
  async setNotifyRooms(rooms: string[]) {
    const ids = new Set<string>();
    for (const r of rooms) {
      try {
        const id = await this.resolveRoom(r);
        ids.add(id);
        await this.ensureJoined(id).catch((err) =>
          log.warn('Matrix-Bot kann dem Raum noch nicht beitreten – bitte einladen', { room: r, err }),
        );
      } catch (err) {
        log.warn('Matrix-Raum nicht gefunden', { room: r, err });
      }
    }
    this.notifyRooms = ids;
  }

  private async syncLoop() {
    const filter = JSON.stringify({
      presence: { types: [] },
      account_data: { types: [] },
      room: {
        state: { lazy_load_members: true, types: ['m.room.member'] },
        timeline: { limit: 20, types: ['m.room.message'] },
        ephemeral: { types: [] },
        account_data: { types: [] },
      },
    });
    let backoff = 2_000;
    while (this.running) {
      try {
        const initial = !this.state.since;
        const qs = new URLSearchParams({ timeout: '30000', filter });
        if (this.state.since) qs.set('since', this.state.since);
        const res = await this.req<any>('GET', `/sync?${qs}`, undefined, 45_000);
        this.connected = true;
        this.lastError = null;
        backoff = 2_000;
        if (!initial) await this.handleSync(res);
        this.state.since = res.next_batch;
        this.saveState();
      } catch (err) {
        this.connected = false;
        this.lastError = (err as Error).message;
        log.warn('Matrix-Sync fehlgeschlagen', { err });
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  private async handleSync(res: any) {
    // Einladungen nur in den Raum-AG-Raum und beobachtete Räume annehmen
    for (const roomId of Object.keys(res.rooms?.invite ?? {})) {
      if (this.notifyRooms.has(roomId) || this.listeners.has(roomId)) {
        await this.req('POST', `/join/${encodeURIComponent(roomId)}`, {})
          .then(() => this.joined.add(roomId))
          .catch(() => undefined);
      }
    }
    const dmRooms = new Set(Object.values(this.state.dms));
    for (const [roomId, room] of Object.entries<any>(res.rooms?.join ?? {})) {
      const listener = this.listeners.get(roomId);
      if (listener) {
        for (const ev of room.timeline?.events ?? []) {
          if (ev.type !== 'm.room.message' || ev.sender === this.userId) continue;
          try {
            await listener(roomId, ev);
          } catch (err) {
            log.error('Matrix-Nachricht konnte nicht verarbeitet werden', { roomId, err });
          }
        }
        continue;
      }
      if (!dmRooms.has(roomId)) continue;
      for (const ev of room.timeline?.events ?? []) {
        if (ev.type !== 'm.room.message' || ev.sender === this.userId) continue;
        const body: string = ev.content?.body ?? '';
        const m = /^\s*(\d{3})\s?(\d{3})\s*$/.exec(body);
        if (!m || !this.onCode) continue;
        try {
          const reply = await this.onCode(ev.sender, m[1] + m[2], roomId);
          if (reply) await this.send(roomId, reply);
        } catch (err) {
          log.error('Matrix-Code konnte nicht verarbeitet werden', { err });
        }
      }
    }
  }

  /** Prüft, ob die Matrix-ID existiert (Profil abrufbar). */
  async userExists(userId: string): Promise<boolean> {
    try {
      await this.req('GET', `/profile/${encodeURIComponent(userId)}`);
      return true;
    } catch (err) {
      if (err instanceof MatrixError && (err.status === 404 || err.errcode === 'M_NOT_FOUND')) return false;
      if (err instanceof MatrixError && err.status === 403) return true; // Profil privat – existiert vermutlich
      throw err;
    }
  }

  /** Direktnachrichten-Raum mit der Person (wiederverwendet, falls vorhanden). */
  async dmRoom(userId: string): Promise<string> {
    const existing = this.state.dms[userId];
    if (existing) {
      try {
        const m = await this.req<{ membership?: string }>(
          'GET',
          `/rooms/${encodeURIComponent(existing)}/state/m.room.member/${encodeURIComponent(userId)}`,
        );
        if (m.membership === 'join' || m.membership === 'invite') return existing;
        await this.req('POST', `/rooms/${encodeURIComponent(existing)}/invite`, { user_id: userId });
        return existing;
      } catch {
        // neu anlegen
      }
    }
    const room = await this.req<{ room_id: string }>('POST', '/createRoom', {
      preset: 'trusted_private_chat',
      is_direct: true,
      invite: [userId],
      name: 'Treibhaus Räume',
      topic: 'Raumbuchung im Treibhaus Donaufeld',
      initial_state: [{ type: 'm.room.history_visibility', state_key: '', content: { history_visibility: 'shared' } }],
    });
    this.state.dms[userId] = room.room_id;
    this.saveState();
    return room.room_id;
  }

  /** Nachricht senden; `extra` z. B. für `m.relates_to` (Thread). Gibt die Event-ID zurück. */
  async send(roomId: string, text: string, html?: string, notice = false, extra: Record<string, unknown> = {}): Promise<string> {
    const txn = crypto.randomUUID();
    const res = await this.req<{ event_id: string }>('PUT', `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txn}`, {
      msgtype: notice ? 'm.notice' : 'm.text',
      body: text,
      ...(html ? { format: 'org.matrix.custom.html', formatted_body: html } : {}),
      ...extra,
    });
    return res.event_id;
  }

  /** Raum beobachten: auflösen, beitreten (öffentlicher Raum oder nach Einladung) und Nachrichten weitergeben. */
  async watchRoom(room: string, handler: RoomMessageHandler): Promise<string> {
    const roomId = await this.resolveRoom(room);
    this.listeners.set(roomId, handler);
    // Nicht öffentlich? Dann klappt der Beitritt erst nach einer Einladung (siehe handleSync).
    await this.ensureJoined(roomId).catch((err) =>
      log.warn('Matrix-Bot kann dem Raum noch nicht beitreten – bitte einladen', { room, err }),
    );
    return roomId;
  }

  isJoined(roomId: string): boolean {
    return this.joined.has(roomId);
  }

  /** Raum-ID eines Alias und ob der Bot dort Mitglied ist. */
  async joinedRoom(room: string): Promise<string> {
    const roomId = await this.resolveRoom(room);
    await this.ensureJoined(roomId);
    return roomId;
  }

  /** Anzeigename eines Mitglieds (1 h zwischengespeichert), sonst der lokale Teil der Matrix-ID. */
  async displayName(roomId: string, userId: string): Promise<string> {
    const hit = this.displayNames.get(userId);
    if (hit && Date.now() - hit.at < 3_600_000) return hit.name;
    let name = userId.replace(/^@/, '').split(':')[0];
    try {
      const m = await this.req<{ displayname?: string }>(
        'GET',
        `/rooms/${encodeURIComponent(roomId)}/state/m.room.member/${encodeURIComponent(userId)}`,
      );
      if (m.displayname) name = m.displayname;
    } catch {
      // Name bleibt der lokale Teil
    }
    this.displayNames.set(userId, { name, at: Date.now() });
    return name;
  }

  async sendToUser(userId: string, text: string, html?: string) {
    const roomId = await this.dmRoom(userId);
    await this.send(roomId, text, html);
  }

  /** Hinweis (m.notice) in einen Raum schicken, z. B. den Raum der Raum-AG. */
  async sendToRoom(room: string, text: string, html?: string) {
    const roomId = await this.resolveRoom(room);
    await this.ensureJoined(roomId);
    await this.send(roomId, text, html, true);
  }
}

const g = globalThis as unknown as { __matrixBot?: MatrixBot | null };

export function getMatrixBot(): MatrixBot | null {
  if (g.__matrixBot === undefined) {
    g.__matrixBot =
      config.matrix.homeserver && config.matrix.token
        ? new MatrixBot(config.matrix.homeserver, config.matrix.token, config.matrix.stateFile)
        : null;
  }
  return g.__matrixBot;
}

const h = globalThis as unknown as { __halloBot?: MatrixBot | null };

/**
 * Bot für den Website-Chat: eigenes Konto, wenn MATRIX_HALLO_TOKEN gesetzt ist,
 * sonst derselbe Bot wie für Codes und Meldungen.
 */
export function getHalloBot(): MatrixBot | null {
  if (!config.matrix.halloToken) return getMatrixBot();
  if (h.__halloBot === undefined) {
    const stateFile =
      config.matrix.halloStateFile || config.matrix.stateFile.replace(/(\.json)?$/, '-hallo.json');
    h.__halloBot = config.matrix.homeserver ? new MatrixBot(config.matrix.homeserver, config.matrix.halloToken, stateFile) : null;
  }
  return h.__halloBot;
}

/** Läuft der Website-Chat über ein eigenes Konto (und muss eigens gestartet werden)? */
export function halloBotIsSeparate(): boolean {
  return !!config.matrix.halloToken && getHalloBot() !== getMatrixBot();
}

export const MATRIX_ID_RE = /^@[a-z0-9._=\-/+]+:[a-z0-9.\-]+(:\d+)?$/i;
