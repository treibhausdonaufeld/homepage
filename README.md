# treibhausdonaufeld.at

Neue Website des Wohnprojekts Treibhaus Donaufeld, Simone-Veil-Gasse 7, 1210 Wien – mit Infos fürs Viertel und Buchung von Viertelsaal und Viertelküche.

- [`docs/implementierungsplan.md`](docs/implementierungsplan.md) – Technik, Architektur, Datenmodell und Phasen der Umsetzung
- [`design/`](design/) – Designentwürfe, Farben, Logo und Briefing

Eine Astro-Anwendung (Node-Adapter) mit SQLite: Inhaltsseiten werden beim Build gerendert, Startseite, Termine, Buchung, Admin-Bereich und Kalender-Feeds laufen auf dem Server. Webserver, Buchungslogik, Matrix-Bot und Hintergrundjobs teilen sich einen Prozess.

## Schnellstart

### Mit Docker

```bash
docker compose up --build
```

Dann <http://localhost:4321> öffnen. Ohne weitere Konfiguration:

- Mails und Matrix-Nachrichten werden **nicht verschickt**, sondern ins Log geschrieben (`docker compose logs -f web`) – dort steht auch der Bestätigungscode.
- Der Admin-Bereich <http://localhost:4321/admin> hat einen Entwicklungs-Login ohne Authentik (`DEV_ADMIN_LOGIN=true`).
- Beim ersten Start werden die Räume, die Nachtruhe (22–8 Uhr) als Sperrzeit und der Samstagstreff als Serie angelegt.

### Ohne Docker

Node 22 nötig.

```bash
npm install
```

```bash
npm run dev
```

Die Datenbank liegt dann in `./data/treibhaus.db`.

### Tests

```bash
npm test
```

```bash
npm run build && npm run test:e2e
```

`npm test` prüft die Buchungslogik (Vitest), `test:e2e` den Buchungsablauf im Browser (Playwright): Anfrage, Code, Freigabe durch die Raum-AG, öffentlicher Termin, Storno, Formularfehler und „Zeit gerade vergeben“.

## Betrieb

### Container

Das Image wird bei jedem Push auf `main` und bei Tags `v*` von GitHub Actions gebaut und nach `ghcr.io/treibhausdonaufeld/homepage` geschoben ([Workflow](.github/workflows/container.yml)). Vorher laufen Typprüfung, Unit- und Browser-Tests. Pull Requests werden nur gebaut, nicht veröffentlicht.

| Tag | Bedeutung |
| --- | --- |
| `latest`, `main` | letzter Stand von `main` |
| `1.2.3`, `1.2` | Release-Tags `v1.2.3` |
| `sha-abc1234` | ein bestimmter Commit |

Auf dem Server:

```bash
cp .env.example .env
```

`.env` ausfüllen (mindestens `PUBLIC_URL`, `HMAC_SECRET`, `SESSION_SECRET`, `DEV_ADMIN_LOGIN=false`), dann:

```bash
docker compose pull web && docker compose --profile proxy --profile backup up -d
```

- **Genau eine Instanz:** Wegen SQLite läuft die App nie doppelt. Bei Updates wird der Container ersetzt (in Kubernetes: 1 Replica, Strategie `Recreate`).
- **Daten:** alles im Volume `/data` – `treibhaus.db` (WAL-Modus), `matrix-bot.json` (Sync-Stand und DM-Räume des Bots) und nächtliche Snapshots in `/data/backup` (7 Stück, `VACUUM INTO`).
- **Migrationen** laufen beim Start automatisch (`drizzle/`). Neue Migration nach Schemaänderung: `npm run db:generate`.
- **Caddy** (Profil `proxy`, [`deploy/Caddyfile`](deploy/Caddyfile)) macht TLS, Kompression und Header. Die App setzt selbst CSP, HSTS (bei https) und weitere Sicherheits-Header.
- **Backup:** Litestream (Profil `backup`, [`deploy/litestream.yml`](deploy/litestream.yml)) spiegelt die Datenbank laufend nach S3/MinIO. Wiederherstellen (App vorher stoppen):

  ```bash
  docker compose run --rm litestream restore -o /data/treibhaus.db /data/treibhaus.db
  ```

  Die Wiederherstellung bitte vor dem Start einmal üben.
- **Überwachung:** `GET /health` meldet Datenbank (bei Fehler 503), SMTP und Matrix. Logs sind JSON-Zeilen auf stdout.
- **Updates der Abhängigkeiten:** Renovate ([`renovate.json`](renovate.json)), wöchentlich.

### Konfiguration

Alle Werte über Umgebungsvariablen, Vorlage in [`.env.example`](.env.example), Standardwerte in [`src/lib/config.ts`](src/lib/config.ts).

| Variable | Wofür |
| --- | --- |
| `PUBLIC_URL` | öffentliche Adresse, für Links in Mails und Matrix (Pflicht in Produktion) |
| `HMAC_SECRET`, `SESSION_SECRET` | Geheimnisse für Codes/Links und Admin-Sessions (Pflicht, `openssl rand -base64 32`) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Mailversand über das SMTP des Hauses |
| `MATRIX_HOMESERVER`, `MATRIX_BOT_TOKEN` | Bot-Konto `@raeume:treibhausdonaufeld.at` |
| `MATRIX_HALLO_TOKEN` | Eigenes Konto für den Website-Chat (z. B. `@website:treibhausdonaufeld.at`); leer = Chat über `MATRIX_BOT_TOKEN` |
| `MATRIX_HALLO_ROOM`, `HALLO_CHAT`, `HALLO_CHAT_RETENTION_DAYS` | Raum für den Website-Chat „Sag hallo“ (Standard `#hallo:treibhausdonaufeld.at`), Chat an/aus (Standard an), Löschfrist in Tagen (Standard 30) |
| `ROCKETCHAT_URL`, `ROCKETCHAT_USER_ID`, `ROCKETCHAT_TOKEN` | Rocket.Chat-Bot für Meldungen an die Raum-AG (Channel wird im Admin eingestellt) |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_ADMIN_GROUP` | Login der Raum-AG über Authentik |
| `DEV_ADMIN_LOGIN` | Admin-Login ohne Authentik – nur lokal! In Produktion `false` |
| `LISTMONK_URL`, `LISTMONK_LIST_UUIDS` | Newsletter-Anmeldung über die öffentliche listmonk-API |
| `HOLD_HOURS`, `CODE_TTL_MINUTES`, `RETENTION_MONTHS`, `RESPONSE_TIME_TEXT`, `TRUST_AFTER_APPROVALS` | Platzhalter für Entscheidungen der Hausgemeinschaft |
| `TRUST_PROXY` | `X-Forwarded-For` für Rate-Limits verwenden (Standard: ja, hinter Caddy) |

**Authentik:** Anwendung als OAuth2/OpenID-Provider anlegen, Redirect-URI `https://treibhausdonaufeld.at/admin/callback`, Scopes `openid profile email` (das `profile`-Scope liefert `groups`). Zugriff hat, wer in der Gruppe `raum-ag` ist.

**Matrix:** Bot-Konto auf dem Hausserver anlegen und das Access-Token als `MATRIX_BOT_TOKEN` setzen. Der Bot legt mit Buchenden unverschlüsselte Direktnachrichten-Räume an und akzeptiert dort auch die Antwort mit dem Code. Räume für Meldungen an die Raum-AG werden im Admin eingestellt; der Bot tritt bei bzw. nimmt Einladungen in diese Räume an.

**Rocket.Chat:** Bot-Benutzer anlegen, unter „Mein Konto → Persönliche Zugangstoken“ ein Token erzeugen und User-ID und Token als `ROCKETCHAT_USER_ID` und `ROCKETCHAT_TOKEN` setzen. Der Bot muss Mitglied im Channel sein, den die Raum-AG im Admin einträgt.

## Inhalte pflegen

Texte und Bilder sind Markdown-Dateien im Repo. Alles mit Datum oder Belegung steht in der Datenbank und wird im Admin-Bereich gepflegt.

| Was | Wo |
| --- | --- |
| Angebote (Fahrradwerkstatt, Samstagstreff …) | `src/content/offers/*.md` |
| Raumbeschreibungen, Fotos, Preise | `src/content/rooms/*.md` |
| Partner | `src/content/partners/*.md` |
| Impressum, Datenschutz, Hausregeln, Wohnen, Soli, Foodcoop | `src/content/pages/*.md` |
| Startseite, Über uns, Mitmachen, Kontakt | `src/pages/*.astro` |
| Termine (auch Samstagstreff), Sperrzeiten, Kapazität, Pufferzeit, Auto-Freigabe | Admin-Bereich `/admin` |

**Im Browser:** Decap CMS unter `/cms` bearbeitet dieselben Markdown-Dateien und legt Änderungen als Pull Request an. Dafür braucht es noch einen Login – entweder eine GitHub-OAuth-App mit kleinem OAuth-Proxy (`base_url` in [`public/cms/config.yml`](public/cms/config.yml)) oder einen eigenen Gitea. Das ist eine offene Entscheidung.

**Offene Punkte** schreibt man als `[TODO: …]` oder `[prüfen]` in den Text – sie erscheinen auf der Website gelb markiert.

Inhaltsänderungen brauchen einen neuen Build (ein paar Minuten bis zum neuen Image). Buchungen und Termine sind sofort sichtbar.

**Termin anlegen:** im Admin-Bereich unter „Intern buchen“ mit „Öffentlich im Terminkalender zeigen“, Kategorie und Angebot. Serien (z. B. wöchentlich) sind möglich.

## Admin-Bereich `/admin`

- **Anfragen:** vorläufige Anfragen annehmen oder ablehnen, mit Notiz an die Person. Jede Entscheidung steht mit Namen im Protokoll.
- **Kalender:** Wochenansicht aller Räume mit Buchungen und Sperrzeiten.
- **Intern buchen:** Buchungen des Hauses, sofort bestätigt. Mit „Vorrang“ werden überschneidende Anfragen storniert und die Betroffenen benachrichtigt (Notiz Pflicht).
- **Sperrzeiten:** einmalig oder wiederkehrend (z. B. Nachtruhe täglich 22–8 Uhr), für einen oder alle Räume.
- **Kalender-Abos:** externe Kalender (iCal-Adresse, bei Nextcloud der Freigabe-Link mit `?export`), alle 15 Minuten und beim Start abgerufen. Je Abo einstellbar: Termine öffentlich auf der Website zeigen (Startseite, `/termine`, iCal-Feed) und/oder Räume sperren. Passt der **Ort** eines Termins zu den Stichwörtern eines Raums, ist der Raum in dieser Zeit plus Pufferzeit nicht buchbar und erscheint als „belegt“; mehrere Räume in einem Ort sind möglich („Viertelsaal + Viertelküche“). Groß/klein und ä/ae spielen keine Rolle. Bei Abos, die nicht öffentlich sind, sehen Gäste nur „Termin im Haus“, nie den Titel. Schlägt ein Abruf fehl, gelten die zuletzt geladenen Termine weiter; der Fehler steht beim Abo. Die Vorschau zeigt, welche Räume die nächsten Termine sperren. Nicht-öffentliche Kalenderlinks gehören nicht ins Repository, sondern werden hier eingetragen.
- **Räume:** Kapazität, Pufferzeit, Auto-Freigabe, öffentlich buchbar, Stichwörter für den Ort in Kalender-Abos (leer = Raumname). Die „Werkstatt“ ist als Raum angelegt, aber nicht öffentlich buchbar – sie wird nur über Kalendertermine gesperrt.
- **Benachrichtigungen:** wohin die Raum-AG Meldungen bekommt – E-Mail-Adresse, Rocket.Chat-Channel oder Matrix-Raum, beliebig viele. Je Ziel wählbar, bei welchen Ereignissen: Anfrage abgeschickt (Kontakt bestätigt), automatisch freigegeben, storniert, Haltefrist abgelaufen, neue Idee, optional auch schon beim ausgefüllten Formular vor der Code-Eingabe (kann Spam sein). Mit „Test senden“ prüfen, ob es ankommt; der letzte Fehler steht beim Ziel. Hier steht nur das Ziel – Zugangsdaten kommen aus den Umgebungsvariablen. Meldungen enthalten keine Kontaktdaten der buchenden Person, nur einen Link in den Admin-Bereich.
- **Statistik & Export:** Nutzungsstunden pro Raum und Art, CSV- und iCal-Export.
- **Protokoll:** wer hat wann was gemacht.

## Chat „Sag hallo“ auf der Website

Gäste können ohne Matrix-Konto direkt auf der Website schreiben (Abschnitt „Sag hallo“ auf Start- und Kontaktseite). Der Matrix-Bot – ein eigenes Konto über `MATRIX_HALLO_TOKEN` (empfohlen, z. B. `@website:treibhausdonaufeld.at`), sonst der Buchungs-Bot über `MATRIX_BOT_TOKEN` – postet die erste Nachricht eines Gesprächs als neuen Beitrag in `MATRIX_HALLO_ROOM` (Standard `#hallo:treibhausdonaufeld.at`), jede weitere im **Thread** darunter. Wer im Thread antwortet (oder direkt auf eine Gast-Nachricht antwortet), dessen Antwort erscheint beim Gast auf der Website, mit Anzeigenamen. Auf dem Homeserver entstehen keine Gastkonten.

Einrichten:
1. Das Chat-Konto (`MATRIX_HALLO_TOKEN`) in `#hallo` einladen (bei öffentlichen Räumen tritt er selbst bei). Er braucht Schreibrecht, keine Admin-Rechte.
2. `#hallo` darf **nicht verschlüsselt** sein – der Bot kann keine Ende-zu-Ende-Verschlüsselung.
3. Fertig: Die Chat-Box erscheint, sobald der Bot verbunden und im Raum ist; sonst bleibt der Matrix-Knopf wie bisher.

Schutz und Moderation: Rate-Limits pro IP (15 Nachrichten / 10 Min., 60 / Tag, 3 neue Gespräche / Stunde), pro Gespräch (30 / Stunde) und für den ganzen Raum (200 / Stunde), ein unsichtbares Honigtopf-Feld gegen Bots, HTML wird maskiert, `@room` entschärft. Unerwünschte Nachrichten im Raum einfach löschen (redact). Abschalten mit `HALLO_CHAT=false`. Gespräche werden `HALLO_CHAT_RETENTION_DAYS` (Standard 30) Tage nach der letzten Nachricht gelöscht.

## Buchungsablauf

1. Raum wählen → 2. Zeit wählen (Tageszeitleiste, optional Serie) → 3. Angaben → 4. Bestätigungsweg (E-Mail oder Matrix) → Code eingeben oder Link klicken.
2. Erst dann blockiert die Anfrage den Raum (**vorläufig**, bis zur Haltefrist). Die Raum-AG bekommt eine Meldung über die im Admin eingestellten Kanäle.
3. Die Raum-AG nimmt an (**bestätigt**, Mail/Nachricht mit `.ics`, Zugangsinfos und Verwaltungslink) oder lehnt ab. Läuft die Haltefrist ab, wird die Anfrage **abgelaufen** und die Person bekommt Bescheid.
4. Über den Verwaltungslink `/b/<token>` kann die Person stornieren.

Doppelbuchungen verhindert eine SQLite-Transaktion (`BEGIN IMMEDIATE`) beim Absenden und noch einmal bei der Bestätigung. Pufferzeiten zählen bei der Prüfung mit, „Saal + Küche“ belegt beide Räume, Sperrzeiten gelten für alle betroffenen Räume. Serien werden nie automatisch freigegeben; belegte Einzeltermine einer Serie werden übersprungen und der Raum-AG angezeigt.

**Spamschutz ohne Captcha:** Honeypot-Feld, Mindestzeit zum Ausfüllen (signierter Zeitstempel), Rate-Limit pro IP und pro Kontakt, und die Raum-AG sieht nur Anfragen mit bestätigtem Kontakt.

**E-Mail-Adresse geschützt:** `hallo@treibhausdonaufeld.at` steht im HTML nie im Klartext. Die Komponente `src/components/Email.astro` (und für Markdown das Sätteri-Plugin in `src/lib/email-obfuscate.mjs`) gibt sie kodiert aus, `public/js/email.js` macht daraus den `mailto:`-Link. Ohne JavaScript steht lesbar „hallo (at) treibhausdonaufeld.at“ da. In Markdown einfach normal schreiben (`[hallo@…](mailto:hallo@…?subject=WG)` oder die nackte Adresse) – der Schutz passiert beim Build. Das hält einfache Adress-Sammler ab, nicht aber solche, die JavaScript ausführen; gegen Spam hilft vor allem der Filter des Mailservers.

**Datenschutz:** Codes, Links und Kontakt-Hashes werden nur als HMAC gespeichert. Unbestätigte Anfragen werden nach 24 Stunden gelöscht, Name, Kontakt und (nicht öffentlicher) Zweck X Monate nach dem Termin (`RETENTION_MONTHS`). Raum, Zeit, Art und Personenzahl bleiben für die Statistik. Keine Tracker, keine fremden Ressourcen (Kumbh Sans liegt im Projekt).

## Feeds und Kurz-URLs

- `/termine.ics` – alle öffentlichen Termine
- `/raeume/<raum>.ics` – anonyme Belegung eines Raums
- `/termine/<termin>.ics`, `/b/<token>.ics` – einzelne Termine
- `/buchen`, `/termine`, `/treff`, `/fahrrad`, `/naehen`, `/jonglieren`, `/hallo` – für QR-Codes

## Projektstruktur

```
├─ astro.config.mjs        Node-Adapter, i18n, Kurz-URLs, CSRF-Schutz
├─ server.mjs              Start in Produktion (Server + Warm-up für Bot und Jobs)
├─ drizzle/                Migrationen
├─ deploy/                 Caddyfile, Litestream
├─ public/                 Logos, Bilder, kleine Skripte (Dunkelmodus, Matrix-Warteseite), Decap CMS
├─ src/
│  ├─ content/             Angebote, Räume, Partner, Seiten (Markdown)
│  ├─ pages/               Seiten und Routen (buchen/, b/, admin/, termine/, raeume/, en/, health.ts …)
│  ├─ lib/
│  │  ├─ db/               Schema, Verbindung, Grunddaten
│  │  ├─ booking/          Zustände, Konflikte, Serien, Puffer, Formulare, Export
│  │  ├─ verify/           Codes, Tokens, Rate-Limit
│  │  ├─ notify/           Mail, Matrix-Bot, Texte
│  │  ├─ auth/             OIDC gegen Authentik, Session-Cookie
│  │  └─ ical/
│  ├─ jobs/                Haltefrist, Löschung, Aufräumen, Snapshot
│  ├─ components/ layouts/
│  └─ styles/tokens.css    Farben hell und dunkel aus dem Design
└─ tests/                  unit/ (Vitest), e2e/ (Playwright)
```

## Abweichungen vom Implementierungsplan

- **Astro 7 statt Astro 5** (mit Vite 8, Rust-Compiler und dem Markdown-Prozessor Sätteri). Die gelbe TODO-Markierung ist ein kleines Sätteri-Plugin ([`src/lib/markdown/todo-plugin.mjs`](src/lib/markdown/todo-plugin.mjs)). TypeScript bleibt auf 6, weil `astro check` TypeScript 7 noch nicht unterstützt.
- **Matrix ohne SDK:** Statt `matrix-bot-sdk` spricht ein kleiner Bot ([`src/lib/notify/matrix.ts`](src/lib/notify/matrix.ts)) direkt die Client-Server-API (Raum anlegen, Nachricht senden, Sync). Das spart native Krypto-Abhängigkeiten; Verschlüsselung war ohnehin nicht vorgesehen.
- **Formulare als normale POST-Formulare** statt Astro Actions. CSRF-Schutz über Astros Origin-Prüfung, Validierung mit Zod. Alles funktioniert ohne JavaScript.
- **Keine Svelte-Inseln:** Zeitwahl ist ein serverseitig gerendertes Formular mit Tageszeitleiste. JavaScript gibt es nur für den Dunkelmodus-Umschalter und die automatische Weiterleitung nach der Matrix-Bestätigung.
- **Bestätigungslink** öffnet eine Seite mit Knopf, statt sofort zu bestätigen – Mailprogramme rufen Links manchmal automatisch auf.
- **Verwaltungslink** wird aus dem Server-Geheimnis abgeleitet (in der Datenbank steht nur ein Hash), damit jede Nachricht ihn enthalten kann.
- **Karte:** vorerst eine Skizze (`public/images/karte.svg`), der OpenStreetMap-Ausschnitt ist noch offen.
- **Englisch:** Start, Räume, Buchung (Erklärung, Formular auf Deutsch) und Kontakt unter `/en/`.
- **Meldungen an die Raum-AG** gehen an Ziele, die im Admin eingestellt werden (E-Mail, Rocket.Chat, Matrix), statt an einen festen Raum aus `MATRIX_ADMIN_ROOM`. Neu dazu: Rocket.Chat (`ROCKETCHAT_*`).
- **Container-Plattform:** nur `linux/amd64`. Für ARM-Server im Workflow `platforms` erweitern.
