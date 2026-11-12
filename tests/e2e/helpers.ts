import fs from 'node:fs';

export const serverLog = () => fs.readFileSync('test-results/e2e/server.log', 'utf8');

/**
 * Letzten Code für eine Empfängeradresse aus dem Server-Log lesen (ohne SMTP werden Mails geloggt).
 * Nach Adresse gefiltert, weil die Tests parallel gegen denselben Server laufen.
 */
export function codeFor(email: string): string {
  const lines = serverLog().trim().split('\n').reverse();
  for (const l of lines) {
    if (!l.includes(`"to":"${email}"`)) continue;
    const m = /Dein Code: (\d{3}) (\d{3})/.exec(l);
    if (m) return m[1] + m[2];
  }
  throw new Error(`kein Code für ${email} im Log`);
}

export const futureDate = (days: number) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
