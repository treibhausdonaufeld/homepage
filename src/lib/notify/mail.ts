import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config';
import { log } from '../log';

let transporter: Transporter | null = null;
let lastVerify: { at: number; ok: boolean; error?: string } | null = null;

export const mailEnabled = () => !!config.smtp.host;

function getTransport(): Transporter | null {
  if (!mailEnabled()) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    });
  }
  return transporter;
}

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: { filename: string; content: string; contentType: string }[];
}

export async function sendMail(mail: Mail): Promise<void> {
  const t = getTransport();
  if (!t) {
    // Entwicklung: Mail nur ins Log schreiben
    log.info('Mail (nicht versendet, SMTP_HOST fehlt)', { to: mail.to, subject: mail.subject, text: mail.text });
    return;
  }
  await t.sendMail({ from: config.smtp.from, ...mail });
  log.info('Mail versendet', { subject: mail.subject });
}

/** Für /health: SMTP-Verbindung prüfen, Ergebnis 5 Minuten merken. */
export async function mailHealth(): Promise<{ ok: boolean; configured: boolean; error?: string }> {
  const t = getTransport();
  if (!t) return { ok: true, configured: false };
  if (lastVerify && Date.now() - lastVerify.at < 5 * 60_000) return { configured: true, ...lastVerify };
  try {
    await t.verify();
    lastVerify = { at: Date.now(), ok: true };
  } catch (err) {
    lastVerify = { at: Date.now(), ok: false, error: (err as Error).message };
  }
  return { configured: true, ok: lastVerify.ok, error: lastVerify.error };
}
