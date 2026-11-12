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

export class MatrixBot {
  userId: string | null = null;
  connected = false;
  lastError: string | null = null;
  private state: BotState = { dms: {} };
  private running = false;
  private adminRoomId: string | null = null;
  private onCode: CodeHandler | null = null;

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

  private async resolveAdminRoom(): Promise<string | null> {
    if (this.adminRoomId) return this.adminRoomId;
    const r = config.matrix.adminRoom;
    if (!r) return null;
    if (r.startsWith('#')) {
      const res = await this.req<{ room_id: string }>('GET', `/directory/room/${encodeURIComponent(r)}`);
      this.adminRoomId = res.room_id;
    } else {
      this.adminRoomId = r;
    }
    try {
      await this.req('POST', `/join/${encodeURIComponent(this.adminRoomId)}`, {});
    } catch (err) {
      log.warn('Konnte dem Raum-AG-Raum nicht beitreten', { err });
    }
    return this.adminRoomId;
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
    // Einladungen nur in den Raum-AG-Raum annehmen
    for (const roomId of Object.keys(res.rooms?.invite ?? {})) {
      if (roomId === config.matrix.adminRoom || roomId === this.adminRoomId) {
        await this.req('POST', `/join/${encodeURIComponent(roomId)}`, {}).catch(() => undefined);
      }
    }
    const dmRooms = new Set(Object.values(this.state.dms));
    for (const [roomId, room] of Object.entries<any>(res.rooms?.join ?? {})) {
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

  async send(roomId: string, text: string, html?: string, notice = false) {
    const txn = crypto.randomUUID();
    await this.req('PUT', `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txn}`, {
      msgtype: notice ? 'm.notice' : 'm.text',
      body: text,
      ...(html ? { format: 'org.matrix.custom.html', formatted_body: html } : {}),
    });
  }

  async sendToUser(userId: string, text: string, html?: string) {
    const roomId = await this.dmRoom(userId);
    await this.send(roomId, text, html);
  }

  async sendAdmin(text: string, html?: string) {
    const roomId = await this.resolveAdminRoom();
    if (!roomId) return;
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

export const MATRIX_ID_RE = /^@[a-z0-9._=\-/+]+:[a-z0-9.\-]+(:\d+)?$/i;
