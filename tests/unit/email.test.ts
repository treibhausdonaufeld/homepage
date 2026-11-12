import { describe, expect, it } from 'vitest';
import { displayEmail, encodeEmail, parseMailto, splitEmails } from '../../src/lib/email-obfuscate.mjs';

/** So dekodiert public/js/email.js */
const decode = (e: string) => [...Buffer.from(e, 'base64').toString('utf8')].reverse().join('');

describe('E-Mail-Schutz', () => {
  it('kodiert umkehrbar und ohne @ im Klartext', () => {
    const e = encodeEmail('hallo@treibhausdonaufeld.at');
    expect(e).not.toContain('@');
    expect(e).not.toContain('hallo');
    expect(decode(e)).toBe('hallo@treibhausdonaufeld.at');
    expect(displayEmail('hallo@treibhausdonaufeld.at')).toBe('hallo (at) treibhausdonaufeld.at');
  });
  it('liest Adresse und Betreff aus mailto', () => {
    expect(parseMailto('mailto:hallo@treibhausdonaufeld.at?subject=WG')).toEqual({ address: 'hallo@treibhausdonaufeld.at', subject: 'WG' });
  });
  it('ersetzt nackte Adressen im Text durch geschützte Links', () => {
    const parts: any[] = splitEmails('Schreib an hallo@treibhausdonaufeld.at bitte.')!;
    expect(parts.map((p) => p.type)).toEqual(['text', 'element', 'text']);
    expect(parts[1].properties.className).toEqual(['eml']);
    expect(JSON.stringify(parts)).not.toContain('hallo@');
    expect(splitEmails('Matrix @raeume:treibhausdonaufeld.at')).toBeNull();
  });
});
