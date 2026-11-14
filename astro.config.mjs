// @ts-check
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import { satteri } from '@astrojs/markdown-satteri';
import { todoPlugin } from './src/lib/markdown/todo-plugin.mjs';
import { emailPlugin } from './src/lib/email-obfuscate.mjs';

// Inhaltsseiten werden vorgerendert (Standard), Buchung, Admin, Feeds und
// Startseite setzen `export const prerender = false` und laufen auf dem Server.
export default defineConfig({
  site: process.env.PUBLIC_URL || 'http://localhost:4321',
  output: 'static',
  adapter: node({ mode: 'standalone' }),
  trailingSlash: 'ignore',
  build: { inlineStylesheets: 'never', format: 'directory' },
  // Formulare nur von der eigenen Origin (CSRF-Schutz). allowedDomains ohne Hostname heißt:
  // Host-Header wird übernommen (z. B. hinter Caddy); absolute Links baut die App immer aus PUBLIC_URL.
  security: { checkOrigin: true, allowedDomains: [{ protocol: 'https' }, { protocol: 'http' }] },
  server: { host: true },
  i18n: {
    defaultLocale: 'de',
    locales: ['de', 'en'],
    routing: { prefixDefaultLocale: false },
  },
  // Kurz-URLs für QR-Codes
  redirects: {
    '/treff': '/angebote/nachbarschaftstreff',
    '/fahrrad': '/angebote/fahrradwerkstatt',
    '/naehen': '/angebote/naehwerkstatt',
    '/jonglieren': '/angebote/jongliertreffen',
    '/hallo': '/kontakt',
  },
  markdown: { processor: satteri({ hastPlugins: [todoPlugin, emailPlugin] }) },
  vite: {
    ssr: { external: ['better-sqlite3'] },
    // Skripte nie inline ins HTML: die CSP (src/middleware.ts) erlaubt nur Skripte von der eigenen Origin.
    build: { assetsInlineLimit: 0 },
  },
});
