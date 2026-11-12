import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MatrixBot } from '../../src/lib/notify/matrix';

const calls: { method: string; url: string; body: any }[] = [];
let server: http.Server;
let base = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      calls.push({ method: req.method!, url: req.url!, body });
      const json = (status: number, data: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      const u = decodeURIComponent(req.url!);
      if (u.includes('/profile/@gibtsnicht:example.org')) return json(404, { errcode: 'M_NOT_FOUND', error: 'Profile not found' });
      if (u.includes('/profile/')) return json(200, { displayname: 'Amira' });
      if (u.endsWith('/createRoom')) return json(200, { room_id: '!dm:example.org' });
      if (u.includes('/send/m.room.message/')) return json(200, { event_id: '$1' });
      if (u.includes('/state/m.room.member/')) return json(200, { membership: 'join' });
      if (u.includes('/directory/room/#raum-ag:example.org')) return json(200, { room_id: '!raumag:example.org' });
      if (u.includes('/join/')) return json(200, { room_id: u.split('/join/')[1] });
      return json(404, { errcode: 'M_UNRECOGNIZED' });
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(() => server.close());

describe('Matrix-Bot', () => {
  it('erkennt unbekannte Matrix-IDs', async () => {
    const bot = new MatrixBot(base, 'tok', path.join(os.tmpdir(), `mb-${Date.now()}.json`));
    expect(await bot.userExists('@amira:example.org')).toBe(true);
    expect(await bot.userExists('@gibtsnicht:example.org')).toBe(false);
  });

  it('legt einen unverschlüsselten DM-Raum an und verwendet ihn wieder', async () => {
    const bot = new MatrixBot(base, 'tok', path.join(os.tmpdir(), `mb-${Date.now()}-2.json`));
    await bot.sendToUser('@amira:example.org', 'Dein Code: 123 456', '<b>123 456</b>');
    await bot.sendToUser('@amira:example.org', 'Noch eine Nachricht');
    const creates = calls.filter((c) => c.url.endsWith('/createRoom'));
    expect(creates).toHaveLength(1);
    expect(creates[0].body.is_direct).toBe(true);
    expect(creates[0].body.invite).toEqual(['@amira:example.org']);
    expect(JSON.stringify(creates[0].body)).not.toContain('m.room.encryption');
    const sends = calls.filter((c) => c.url.includes('/send/'));
    expect(sends).toHaveLength(2);
    expect(sends[0].body.body).toContain('123 456');
    expect(sends[0].body.formatted_body).toContain('<b>');
  });

  it('schickt Hinweise in einen Raum per Alias und tritt vorher bei', async () => {
    const bot = new MatrixBot(base, 'tok', path.join(os.tmpdir(), `mb-${Date.now()}-3.json`));
    await bot.sendToRoom('#raum-ag:example.org', 'Neue Anfrage', '<b>Neue Anfrage</b>');
    const joins = calls.filter((c) => c.url.includes('/join/'));
    expect(decodeURIComponent(joins.at(-1)!.url)).toContain('!raumag:example.org');
    const send = calls.filter((c) => c.url.includes('/send/')).at(-1)!;
    expect(decodeURIComponent(send.url)).toContain('/rooms/!raumag:example.org/send/');
    expect(send.body.msgtype).toBe('m.notice');
  });
});
