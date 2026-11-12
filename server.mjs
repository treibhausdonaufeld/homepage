/**
 * Start in Produktion: Astro-Server (Node standalone) laden und sofort einmal /health aufrufen,
 * damit Migrationen, Matrix-Bot und Hintergrundjobs beim Start und nicht erst bei der ersten Anfrage laufen.
 */
process.env.HOST ??= '0.0.0.0';
process.env.PORT ??= '4321';

await import('./dist/server/entry.mjs');

const url = `http://127.0.0.1:${process.env.PORT}/health`;
for (let i = 0; i < 30; i++) {
  try {
    const res = await fetch(url);
    if (res.ok) break;
  } catch {
    // Server startet noch
  }
  await new Promise((r) => setTimeout(r, 500));
}
