# Treibhaus Donaufeld — Homepage

Statische Website der Baugruppe **Treibhaus Donaufeld**, gebaut mit
[Astro](https://astro.build) und veröffentlicht über **GitHub Pages**.
Kein WordPress, kein Server — nur statische Dateien.

---

## Schnellstart (lokal)

Voraussetzung: [Node.js](https://nodejs.org) 18 oder neuer.

```bash
npm install      # Abhängigkeiten installieren
npm run dev      # Entwicklungsserver auf http://localhost:4321
npm run build    # Produktions-Build nach ./dist
npm run preview  # Build lokal ansehen
```

---

## Veröffentlichen über GitHub Pages

Die Seite wird automatisch gebaut und veröffentlicht, sobald du auf den
`main`-Branch pushst. Einmalige Einrichtung:

1. Code in das Repository `treibhausdonaufeld/homepage` pushen.
2. Auf GitHub: **Settings → Pages → Build and deployment → Source**
   auf **GitHub Actions** stellen.
3. Fertig. Jeder Push auf `main` löst den Workflow
   `.github/workflows/deploy.yml` aus, der die Seite baut und live stellt.

### Eigene Domain (treibhausdonaufeld.at)

Die Datei `public/CNAME` enthält bereits `treibhausdonaufeld.at`. Beim
DNS-Anbieter zusätzlich einrichten:

- vier `A`-Records für die Apex-Domain auf die GitHub-Pages-IPs
  (`185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`), **oder**
- alternativ `www` als `CNAME` auf `treibhausdonaufeld.github.io`.

Danach unter **Settings → Pages → Custom domain** die Domain eintragen und
„Enforce HTTPS“ aktivieren.

> Ohne eigene Domain (Adresse `…github.io/homepage`): siehe die Hinweise oben
> in `astro.config.mjs` (`base`/`site` anpassen, `public/CNAME` löschen).

---

## Newsletter (listmonk) einrichten

Das Anmeldeformular steht in `src/components/NewsletterForm.astro`.
Dort zwei Platzhalter ersetzen:

| Platzhalter        | Wert                                                         |
|--------------------|-------------------------------------------------------------|
| `__LISTMONK_URL__` | Basis-URL deiner listmonk-Installation, z. B. `https://list.treibhausdonaufeld.at` |
| `__LIST_UUID__`    | UUID der Liste (listmonk-Admin → **Lists** → Liste auswählen) |

Das Formular postet direkt an `…/subscription/form` deiner listmonk-Instanz –
kein Backend nötig, funktioniert daher auf GitHub Pages. listmonk zeigt nach
dem Absenden seine eigene Bestätigungsseite (Double-Opt-in).

> Den exakten Feld-Snippet findest du im listmonk-Admin unter der
> „Public subscription page“ der jeweiligen Liste.

---

## Inhalte pflegen

| Seite        | Datei                          |
|--------------|--------------------------------|
| Startseite   | `src/pages/index.astro`        |
| Projekt      | `src/pages/projekt.astro`      |
| Wir          | `src/pages/wir.astro`          |
| Info         | `src/pages/info.astro`         |
| Datenschutz  | `src/pages/datenschutz.astro`  |

Im Code an mehreren Stellen `<!-- TODO ... -->` und Platzhalter wie
`__KONTAKT_EMAIL__` — dort die restlichen Inhalte der alten Seite einfügen.

**Bilder:** Dateien nach `public/images/` legen und mit `/images/dateiname.jpg`
einbinden. Die Startseite nutzt aktuell eine selbstgezeichnete Greenhouse-Grafik
(`src/components/GreenhouseArt.astro`) – die kann bleiben oder durch ein Foto
ersetzt werden.

---

## Design anpassen

Alle Farben, Schriften und Abstände stehen als Variablen ganz oben in
`src/styles/global.css` (Abschnitt `:root`). Eine Farbe dort ändern wirkt
sich auf die ganze Seite aus.

Schriften (`Bricolage Grotesque` + `Hanken Grotesk`) werden über
[Fontsource](https://fontsource.org) selbst gehostet (kein Google-CDN-Aufruf,
DSGVO-freundlich). Tausch: Paket in `package.json` ändern und den Import oben
in `src/layouts/Base.astro` anpassen.

---

## Struktur

```
.
├─ .github/workflows/deploy.yml   # Build & Deploy nach GitHub Pages
├─ astro.config.mjs               # Domain-/Pfad-Konfiguration
├─ public/                        # statische Dateien (CNAME, Favicon, Bilder)
└─ src/
   ├─ components/                 # Header, Footer, Newsletter, Grafik
   ├─ layouts/Base.astro          # Grundgerüst (head, Schriften, Header/Footer)
   ├─ pages/                      # eine Datei pro Seite
   └─ styles/global.css           # Design-System (Farben, Typo, Komponenten)
```
