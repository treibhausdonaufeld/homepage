/** Verbindung des „Sag hallo“-Chats mit dem Matrix-Bot (einmal pro Prozess). */
import { config } from '../config';
import { getDb } from '../db';
import { log } from '../log';
import { getMatrixBot } from '../notify/matrix';
import { handleRoomMessage, type HalloTransport } from './index';

const g = globalThis as unknown as { __halloRoomId?: string | null };

/** Beim Start: #hallo beobachten. Fehler (z. B. Bot noch nicht eingeladen) werden geloggt. */
export async function startHallo(): Promise<void> {
  const bot = getMatrixBot();
  if (!config.halloChat.enabled || !bot) return;
  const db = getDb();
  try {
    g.__halloRoomId = await bot.watchRoom(config.matrixHalloRoom, (roomId, ev) =>
      handleRoomMessage(db, roomId, ev, (userId) => bot.displayName(roomId, userId)).then(() => undefined),
    );
    if (bot.isJoined(g.__halloRoomId)) log.info('Website-Chat verbunden', { room: config.matrixHalloRoom });
  } catch (err) {
    g.__halloRoomId = null;
    log.warn('Website-Chat: Raum nicht gefunden', { room: config.matrixHalloRoom, err });
  }
}

/** Ist die Chat-Box nutzbar? */
export function halloAvailable(): boolean {
  const bot = getMatrixBot();
  return !!(config.halloChat.enabled && bot && bot.connected && g.__halloRoomId && bot.isJoined(g.__halloRoomId));
}

export function halloTransport(): HalloTransport {
  return {
    async roomId() {
      const bot = getMatrixBot();
      if (!bot || !g.__halloRoomId) throw new Error('Website-Chat nicht verbunden');
      return bot.joinedRoom(g.__halloRoomId);
    },
    async send(roomId, text, html, extra) {
      const bot = getMatrixBot();
      if (!bot) throw new Error('Matrix-Bot nicht konfiguriert');
      return bot.send(roomId, text, html, false, extra);
    },
  };
}
