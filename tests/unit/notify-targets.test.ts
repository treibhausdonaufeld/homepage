import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../../src/lib/config';
import { addTarget, dispatch, formatMessage, listTargets, validateTarget, type Senders } from '../../src/lib/notify/targets';
import { sendRocketChat } from '../../src/lib/notify/rocketchat';
import { testDb } from './helpers';

const msg = { title: 'Neue Anfrage: Viertelsaal, Do 19. Nov, 10:00–14:00', text: 'Kleidertausch\n30 Personen', url: 'https://example.org/admin/buchung/1' };

function recorder() {
  const sent: string[] = [];
  const senders: Senders = {
    async email(to, subject) { sent.push(`email ${to} ${subject}`); },
    async rocketchat(channel, text) { sent.push(`rc ${channel} ${text.split('\n')[0]}`); },
    async matrix(room) {
      if (room.includes('kaputt')) throw new Error('M_FORBIDDEN');
      sent.push(`matrix ${room}`);
    },
  };
  return { sent, senders };
}

describe('Benachrichtigungsziele', () => {
  it('prüft Ziele je Kanal', () => {
    expect(validateTarget({ kind: 'email', target: 'raum-ag@example.org', events: ['anfrage'] })).toHaveProperty('value');
    expect(validateTarget({ kind: 'email', target: 'kein-mail', events: ['anfrage'] })).toHaveProperty('error');
    expect(validateTarget({ kind: 'rocketchat', target: '#raum-ag', events: ['anfrage'] })).toHaveProperty('value');
    expect(validateTarget({ kind: 'rocketchat', target: 'raum ag', events: ['anfrage'] })).toHaveProperty('error');
    expect(validateTarget({ kind: 'matrix', target: '!abc:treibhausdonaufeld.at', events: ['anfrage'] })).toHaveProperty('value');
    expect(validateTarget({ kind: 'matrix', target: '#raum-ag:treibhausdonaufeld.at', events: ['anfrage'] })).toHaveProperty('value');
    expect(validateTarget({ kind: 'matrix', target: '@person:server', events: ['anfrage'] })).toHaveProperty('error');
    expect(validateTarget({ kind: 'email', target: 'a@example.org', events: ['gibtsnicht'] })).toHaveProperty('error');
  });

  it('schickt nur an aktive Ziele mit passendem Ereignis und merkt sich Fehler', async () => {
    const db = testDb();
    addTarget(db, 'test', { kind: 'email', target: 'raum-ag@example.org', label: null, events: ['anfrage', 'storno'], enabled: true });
    addTarget(db, 'test', { kind: 'rocketchat', target: '#raum-ag', label: null, events: ['anfrage'], enabled: true });
    addTarget(db, 'test', { kind: 'matrix', target: '#kaputt:example.org', label: null, events: ['anfrage'], enabled: true });
    addTarget(db, 'test', { kind: 'matrix', target: '!pausiert:example.org', label: null, events: ['anfrage'], enabled: false });
    addTarget(db, 'test', { kind: 'email', target: 'nur-idee@example.org', label: null, events: ['idee'], enabled: true });
    const { sent, senders } = recorder();
    const results = await dispatch(db, 'anfrage', msg, senders);
    expect(sent.sort()).toEqual(['email raum-ag@example.org [Raum-AG] ' + msg.title, 'rc #raum-ag *' + msg.title + '*']);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);
    const t = listTargets(db);
    expect(t.find((x) => x.target === '#kaputt:example.org')!.lastError).toBe('M_FORBIDDEN');
    expect(t.find((x) => x.target === 'raum-ag@example.org')!.lastSentAt).toBeInstanceOf(Date);
  });

  it('formatiert je Kanal mit Link in den Admin-Bereich', () => {
    expect(formatMessage('email', msg)).toMatchObject({ subject: `[Raum-AG] ${msg.title}` });
    expect((formatMessage('rocketchat', msg) as { text: string }).text).toContain(msg.url);
    expect((formatMessage('matrix', msg) as { html: string }).html).toContain(`<a href="${msg.url}">`);
  });
});

describe('Rocket.Chat', () => {
  const calls: { headers: http.IncomingHttpHeaders; body: any; url: string }[] = [];
  let server: http.Server;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        calls.push({ headers: req.headers, body, url: req.url! });
        res.writeHead(body.channel === '#gibtsnicht' ? 400 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body.channel === '#gibtsnicht' ? { success: false, error: 'error-invalid-channel' } : { success: true }));
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    Object.assign(config.rocketchat, { url: `http://127.0.0.1:${(server.address() as any).port}`, userId: 'bot-id', token: 'geheim' });
  });
  afterAll(() => {
    server.close();
    Object.assign(config.rocketchat, { url: '', userId: '', token: '' });
  });

  it('postet mit Bot-Token in den Channel', async () => {
    await sendRocketChat('#raum-ag', 'Hallo');
    expect(calls[0].url).toBe('/api/v1/chat.postMessage');
    expect(calls[0].headers['x-user-id']).toBe('bot-id');
    expect(calls[0].headers['x-auth-token']).toBe('geheim');
    expect(calls[0].body).toEqual({ channel: '#raum-ag', text: 'Hallo' });
  });

  it('meldet Fehler von Rocket.Chat', async () => {
    await expect(sendRocketChat('#gibtsnicht', 'x')).rejects.toThrow('error-invalid-channel');
  });
});
