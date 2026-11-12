/** Rocket.Chat über die REST-API (chat.postMessage) mit dem Token eines Bot-Benutzers. */
import { config } from '../config';

export const rocketchatEnabled = () => !!(config.rocketchat.url && config.rocketchat.userId && config.rocketchat.token);

export class RocketChatError extends Error {}

/** Nachricht an einen Channel (#name), eine Person (@name) oder eine Raum-ID schicken. */
export async function sendRocketChat(channel: string, text: string): Promise<void> {
  if (!rocketchatEnabled())
    throw new RocketChatError('Rocket.Chat ist nicht eingerichtet (ROCKETCHAT_URL, ROCKETCHAT_USER_ID, ROCKETCHAT_TOKEN).');
  const res = await fetch(`${config.rocketchat.url}/api/v1/chat.postMessage`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-User-Id': config.rocketchat.userId,
      'X-Auth-Token': config.rocketchat.token,
    },
    body: JSON.stringify({ channel, text }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string };
  if (!res.ok || json.success === false) {
    throw new RocketChatError(`Rocket.Chat: ${json.error ?? `HTTP ${res.status}`}`);
  }
}
