/**
 * Benachrichtigungen an Buchende (über den Kanal der Anfrage) und an die Raum-AG.
 */
import { config } from '../config';
import { log } from '../log';
import { BookingError, type BookingView, type Notifier } from '../booking/types';
import { describeRule } from '../booking/recurrence';
import { fmt } from '../time';
import { sendMail } from './mail';
import { getMatrixBot, MatrixError } from './matrix';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** „den Viertelsaal“, „die Viertelküche“, „Saal + Küche“ */
export function withArticle(name: string): string {
  if (/saal$/i.test(name)) return `den ${name}`;
  if (/(küche|werkstatt)$/i.test(name)) return `die ${name}`;
  if (/raum$/i.test(name)) return `den ${name}`;
  return name;
}

function when(view: BookingView): string {
  const o = view.occurrences[0] ?? view.skipped[0];
  if (!o) return '';
  const base = `${fmt.long(o.start)}, ${fmt.range(o.start, o.end)} Uhr`;
  if (view.seriesRule) return `${base} (${describeRule(view.seriesRule)}, ${view.occurrences.length} Termine)`;
  return base;
}

function shortWhen(view: BookingView): string {
  const o = view.occurrences[0] ?? view.skipped[0];
  if (!o) return '';
  return `${fmt.short(o.start)}, ${fmt.range(o.start, o.end).replace(/:00/g, '')} Uhr`;
}

const footer = () =>
  `Fragen? Schreib uns im Matrix-Raum ${config.matrixHalloRoom} oder an ${config.contactEmail}.\n\nTreibhaus Donaufeld · Simone-Veil-Gasse 7 · 1210 Wien`;

function htmlWrap(paragraphs: string[]): string {
  return `<!doctype html><html lang="de"><body style="font-family:system-ui,sans-serif;font-size:16px;line-height:1.5;color:#1E1C19;background:#FAF8F3;padding:24px">
<div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #E2DDD1;border-radius:12px;padding:24px">
${paragraphs.map((p) => `<p style="margin:0 0 16px">${p}</p>`).join('\n')}
<p style="margin:24px 0 0;color:#5F5A50;font-size:14px">Fragen? Schreib uns im Matrix-Raum <a href="https://matrix.to/#/${encodeURIComponent(config.matrixHalloRoom)}" style="color:#5D7A10">${esc(config.matrixHalloRoom)}</a> oder an <a href="mailto:${config.contactEmail}" style="color:#5D7A10">${config.contactEmail}</a>.<br>Treibhaus Donaufeld · Simone-Veil-Gasse 7 · 1210 Wien</p>
</div></body></html>`;
}

const button = (href: string, label: string) =>
  `<a href="${href}" style="display:inline-block;background:#4A2C7A;color:#fff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:8px">${esc(label)}</a>`;

interface Message {
  subject: string;
  text: string;
  html: string;
  /** Kurzfassung für Matrix */
  matrixText: string;
  matrixHtml?: string;
  attachments?: { filename: string; content: string; contentType: string }[];
}

async function deliver(view: BookingView, msg: Message) {
  const b = view.booking;
  if (!b.contactAddress || b.contactChannel === 'intern') return;
  if (b.contactChannel === 'email') {
    await sendMail({ to: b.contactAddress, subject: msg.subject, text: msg.text, html: msg.html, attachments: msg.attachments });
    return;
  }
  const bot = getMatrixBot();
  if (!bot) {
    log.info('Matrix-Nachricht (nicht versendet, Bot nicht konfiguriert)', { to: b.contactAddress, text: msg.matrixText });
    return;
  }
  await bot.sendToUser(b.contactAddress, msg.matrixText, msg.matrixHtml);
}

export function createNotifier(): Notifier {
  return {
    async sendCode(view, code, link) {
      const b = view.booking;
      const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
      const question = `Hast du ${withArticle(view.room.name)} für ${shortWhen(view)} angefragt?`;
      if (b.contactChannel === 'matrix') {
        const bot = getMatrixBot();
        if (!bot) {
          log.info('Matrix-Code (nicht versendet, Bot nicht konfiguriert)', { to: b.contactAddress, code, link });
          return;
        }
        try {
          if (!(await bot.userExists(b.contactAddress!)))
            throw new BookingError('matrix-unreachable', 'Diese Matrix-ID haben wir nicht gefunden.');
          await bot.sendToUser(
            b.contactAddress!,
            `Hallo! ${question} Dein Code: ${spaced}\nBestätigen: ${link}\nDu kannst den Code auch einfach hier als Antwort schicken. Der Code gilt ${config.booking.codeTtlMinutes} Minuten.`,
            `Hallo! ${esc(question)} Dein Code: <b>${spaced}</b><br><a href="${link}">✓ Bestätigen</a><br>Du kannst den Code auch einfach hier als Antwort schicken. Der Code gilt ${config.booking.codeTtlMinutes} Minuten.`,
          );
        } catch (err) {
          if (err instanceof BookingError) throw err;
          if (err instanceof MatrixError)
            throw new BookingError('matrix-unreachable', 'Wir konnten dir keine Matrix-Nachricht schicken.', { detail: err.message });
          throw err;
        }
        return;
      }
      await sendMail({
        to: b.contactAddress!,
        subject: `Dein Code: ${spaced} – Raumanfrage Treibhaus`,
        text: `Hallo ${b.name ?? ''}!\n\n${question}\n\nDein Code: ${spaced}\n\nOder bestätige direkt mit diesem Link:\n${link}\n\nDer Code gilt ${config.booking.codeTtlMinutes} Minuten. Wenn du nichts angefragt hast, kannst du diese Mail ignorieren.\n\n${footer()}`,
        html: htmlWrap([
          `Hallo ${esc(b.name ?? '')}!`,
          esc(question),
          `Dein Code: <b style="font-size:24px;letter-spacing:2px">${spaced}</b>`,
          button(link, 'Anfrage bestätigen'),
          `Der Code gilt ${config.booking.codeTtlMinutes} Minuten. Wenn du nichts angefragt hast, kannst du diese Mail ignorieren.`,
        ]),
      });
    },

    async received(view, manageUrl) {
      const hold = view.booking.holdUntil ? fmt.dateTime(view.booking.holdUntil) : '';
      await deliver(view, {
        subject: `Anfrage ist da: ${view.room.name}, ${shortWhen(view)}`,
        text: `Danke! Deine Anfrage ist da.\n\n${view.room.name}\n${when(view)}\nStatus: vorläufig reserviert\n\nWir halten den Termin bis ${hold} für dich frei. Die Raum-AG schaut sich die Anfrage an. Das dauert meist ${config.booking.responseTimeText}. Du bekommst die Antwort auf diesem Weg.\n\nAnfrage ansehen oder zurückziehen: ${manageUrl}\n\n${footer()}`,
        html: htmlWrap([
          '<b>Danke! Deine Anfrage ist da.</b>',
          `${esc(view.room.name)}<br>${esc(when(view))}<br>Status: vorläufig reserviert`,
          `Wir halten den Termin bis ${esc(hold)} für dich frei. Die Raum-AG schaut sich die Anfrage an. Das dauert meist ${esc(config.booking.responseTimeText)}.`,
          button(manageUrl, 'Anfrage ansehen'),
        ]),
        matrixText: `Danke! Deine Anfrage für ${view.room.name}, ${shortWhen(view)} ist da und vorläufig reserviert (bis ${hold}). Die Raum-AG meldet sich hier. Anfrage ansehen: ${manageUrl}`,
      });
    },

    async confirmed(view, manageUrl, ics) {
      const icsUrl = `${manageUrl}.ics`;
      const access = 'Schlüssel und Zugang: [TODO: Schlüsselübergabe, wo und wann]';
      const costs = 'Kosten: [TODO: Betrag, Kaution, wie zahlen]';
      await deliver(view, {
        subject: `Bestätigt: ${view.room.name}, ${shortWhen(view)}`,
        text: `Alles klar – ${view.room.name} ist für dich reserviert!\n\n${view.room.name}${view.booking.purpose ? ` · ${view.booking.purpose}` : ''}\n${when(view)}\nStatus: bestätigt\n${view.booking.decisionNote ? `\nNotiz der Raum-AG: ${view.booking.decisionNote}\n` : ''}\n${access}\n${costs}\n\nBuchung verwalten oder stornieren: ${manageUrl}\nDer Termin hängt als Kalenderdatei an.\n\n${footer()}`,
        html: htmlWrap([
          `<b>Alles klar – ${esc(view.room.name)} ist für dich reserviert!</b>`,
          `${esc(view.room.name)}${view.booking.purpose ? ` · ${esc(view.booking.purpose)}` : ''}<br>${esc(when(view))}<br>Status: <b>bestätigt</b>`,
          ...(view.booking.decisionNote ? [`Notiz der Raum-AG: „${esc(view.booking.decisionNote)}“`] : []),
          esc(access),
          esc(costs),
          button(manageUrl, 'Buchung verwalten'),
          'Der Termin hängt als Kalenderdatei (.ics) an.',
        ]),
        attachments: [{ filename: 'treibhaus-buchung.ics', content: ics, contentType: 'text/calendar; charset=utf-8' }],
        matrixText: `Alles klar – ${view.room.name} ist für ${shortWhen(view)} bestätigt!${view.booking.decisionNote ? ` Notiz der Raum-AG: „${view.booking.decisionNote}“.` : ''} ${access}. In den Kalender: ${icsUrl} · Verwalten oder stornieren: ${manageUrl}`,
      });
    },

    async rejected(view, note) {
      await deliver(view, {
        subject: `Leider klappt es diesmal nicht: ${view.room.name}, ${shortWhen(view)}`,
        text: `Leider klappt es diesmal nicht.\n\n${view.room.name} ist am ${when(view)} nicht frei.${note ? `\nDie Raum-AG schreibt dazu: „${note}“` : ''}\n\nNeue Anfrage stellen: ${config.publicUrl}/buchen\n\n${footer()}`,
        html: htmlWrap([
          '<b>Leider klappt es diesmal nicht.</b>',
          `${esc(view.room.name)} ist am ${esc(when(view))} nicht frei.`,
          ...(note ? [`Die Raum-AG schreibt dazu: „${esc(note)}“`] : []),
          button(`${config.publicUrl}/buchen`, 'Neue Anfrage stellen'),
        ]),
        matrixText: `Leider klappt es diesmal nicht: ${view.room.name}, ${shortWhen(view)}.${note ? ` Die Raum-AG schreibt: „${note}“` : ''} Neue Anfrage: ${config.publicUrl}/buchen`,
      });
    },

    async expired(view, reason) {
      const why =
        reason === 'conflict'
          ? 'Jemand war ein paar Minuten schneller und hat die Zeit vor dir bestätigt.'
          : 'Die Raum-AG hat die Anfrage nicht rechtzeitig beantwortet. Das tut uns leid.';
      await deliver(view, {
        subject: `Anfrage abgelaufen: ${view.room.name}, ${shortWhen(view)}`,
        text: `Deine Anfrage für ${view.room.name} (${when(view)}) ist abgelaufen.\n${why}\n\nNeue Anfrage stellen: ${config.publicUrl}/buchen\n\n${footer()}`,
        html: htmlWrap([
          `Deine Anfrage für ${esc(view.room.name)} (${esc(when(view))}) ist abgelaufen.`,
          esc(why),
          button(`${config.publicUrl}/buchen`, 'Neue Anfrage stellen'),
        ]),
        matrixText: `Deine Anfrage für ${view.room.name}, ${shortWhen(view)} ist abgelaufen. ${why} Neue Anfrage: ${config.publicUrl}/buchen`,
      });
    },

    async cancelled(view, byHouse, note) {
      const text = byHouse
        ? `Die Raum-AG musste deine Buchung für ${view.room.name} (${when(view)}) leider absagen.${note ? ` Sie schreibt dazu: „${note}“` : ''}`
        : `Deine Buchung für ${view.room.name} (${when(view)}) ist storniert. Der Termin ist wieder frei.`;
      await deliver(view, {
        subject: `Storniert: ${view.room.name}, ${shortWhen(view)}`,
        text: `${text}\n\nNeuen Termin finden: ${config.publicUrl}/buchen\n\n${footer()}`,
        html: htmlWrap([esc(text), button(`${config.publicUrl}/buchen`, 'Neuen Termin finden')]),
        matrixText: `${text} Neuen Termin finden: ${config.publicUrl}/buchen`,
      });
    },

    async admin(text, html) {
      const bot = getMatrixBot();
      if (bot) await bot.sendAdmin(text, html).catch((err) => log.error('Raum-AG-Meldung fehlgeschlagen', { err }));
      else log.info('Raum-AG-Meldung', { text });
      if (config.adminEmail) {
        await sendMail({ to: config.adminEmail, subject: `[Raum-AG] ${text.split(':')[0]}`, text }).catch((err) =>
          log.error('Raum-AG-Mail fehlgeschlagen', { err }),
        );
      }
    },
  };
}

const g = globalThis as unknown as { __notifier?: Notifier };
export function getNotifier(): Notifier {
  if (!g.__notifier) g.__notifier = createNotifier();
  return g.__notifier;
}
