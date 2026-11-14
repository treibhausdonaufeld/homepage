/**
 * Start der Hintergrunddienste (einmal pro Prozess): Datenbank, Seed, Matrix-Bot, Jobs.
 */
import { config, configProblems } from './config';
import { getDb } from './db';
import { seed } from './db/seed';
import { getNotifier, refreshMatrixRooms } from './notify';
import { getMatrixBot } from './notify/matrix';
import { verifyFromMatrix } from './booking/service';
import { startJobs } from '../jobs';
import { startHallo } from './hallo/runtime';
import { log } from './log';

const g = globalThis as unknown as { __booted?: Promise<void> };

export function ensureStarted(): Promise<void> {
  if (!g.__booted) {
    g.__booted = boot().catch((err) => {
      log.error('Start fehlgeschlagen', { err });
      g.__booted = undefined;
      throw err;
    });
  }
  return g.__booted;
}

async function boot() {
  const problems = configProblems();
  if (problems.length) {
    if (config.isProd) throw new Error(`Konfiguration unvollständig: ${problems.join(', ')}`);
    log.warn('Konfiguration unvollständig', { problems });
  }
  const db = getDb();
  const notifier = getNotifier();
  if (config.seed) await seed(db, notifier);

  const bot = getMatrixBot();
  if (bot) {
    await bot.start(async (sender, code) => {
      const r = await verifyFromMatrix(db, notifier, sender, code);
      switch (r.result) {
        case 'ok':
          return r.autoApproved
            ? 'Danke, bestätigt! Deine Buchung ist freigegeben – die Details kommen gleich.'
            : 'Danke, bestätigt! Deine Anfrage ist jetzt vorläufig reserviert. Die Raum-AG meldet sich hier.';
        case 'wrong':
          return `Der Code stimmt nicht. Du hast noch ${r.remaining} Versuch(e).`;
        case 'expired':
          return 'Der Code ist abgelaufen. Auf der Website kannst du einen neuen anfordern.';
        case 'locked':
          return `Zu viele Versuche. Bitte fordere auf der Website einen neuen Code an oder schreib uns in ${config.matrixHalloRoom}.`;
        case 'conflict':
          return 'Diese Zeit ist leider gerade vergeben worden. Auf der Website findest du freie Zeiten.';
        default:
          return null;
      }
    });
    await refreshMatrixRooms().catch((err) => log.warn('Matrix-Räume für Benachrichtigungen nicht erreichbar', { err }));
    await startHallo();
  } else {
    log.info('Matrix-Bot nicht konfiguriert (MATRIX_HOMESERVER/MATRIX_BOT_TOKEN)');
  }
  startJobs(db, notifier);
  log.info('Treibhaus-Dienste gestartet', { publicUrl: config.publicUrl });
}
