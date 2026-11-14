import { createHash } from 'node:crypto';

/**
 * Läuft vor dem ersten Bild im <head>: markiert, dass JavaScript läuft (Menü auf dem Handy
 * zugeklappt) und setzt das gespeicherte Farbschema. Inline, damit nichts nachgeladen werden muss.
 * Die CSP in middleware.ts erlaubt genau dieses Skript über seinen Hash.
 */
export const HEAD_SCRIPT =
  "document.documentElement.classList.add('js');try{var t=localStorage.getItem('th-theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}";

export const HEAD_SCRIPT_HASH = `'sha256-${createHash('sha256').update(HEAD_SCRIPT).digest('base64')}'`;
