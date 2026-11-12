import fs from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { codeFor, futureDate } from './helpers';

async function fillRequest(page: Page, date: string, von: string, bis: string, email: string) {
  await page.goto('/buchen');
  await page.getByLabel(/Viertelsaal/).check();
  await page.getByRole('button', { name: 'Weiter: Zeit wählen' }).click();
  await page.goto(`/buchen/zeit?raum=viertelsaal&datum=${date}`);
  await page.locator('#von').selectOption(von);
  await page.locator('#bis').selectOption(bis);
  await page.getByRole('button', { name: 'Weiter: Angaben' }).click();
  await expect(page.getByText('Schritt 3 von 4')).toBeVisible();
  await page.getByLabel('Dein Name').fill('Amira K.');
  await page.getByLabel('Was hast du vor?').fill('Kleidertausch fürs Viertel');
  await page.getByLabel('Wie viele Personen ungefähr?').fill('30');
  await page.getByLabel('gemeinnützig / Initiative').check();
  await page.getByLabel(/Offen für alle/).check();
  await page.getByLabel(/Hausregeln/).check();
  await page.getByRole('button', { name: 'Weiter: Bestätigen' }).click();
  await expect(page.getByRole('heading', { name: 'Fast fertig!' })).toBeVisible();
  await page.getByPlaceholder('E-Mail-Adresse').fill(email);
  await page.getByRole('button', { name: 'Code schicken' }).click();
}

test('Formularfehler werden angezeigt', async ({ page }) => {
  await page.goto(`/buchen/angaben?raum=viertelsaal&datum=${futureDate(20)}&von=10:00&bis=12:00`);
  await page.getByLabel('Wie viele Personen ungefähr?').fill('80');
  await page.getByRole('button', { name: 'Weiter: Bestätigen' }).click();
  await expect(page.getByText(/Bitte prüf \d Angaben/)).toBeVisible();
  await expect(page.getByText(/Platz für ca. 60 Personen/)).toBeVisible();
  await expect(page.getByText('Bitte lies die Hausregeln und hak das Kästchen an.')).toBeVisible();
});

test('Anfrage, Code, Freigabe durch die Raum-AG, Storno', async ({ page }) => {
  const date = futureDate(14);
  await fillRequest(page, date, '10:00', '14:00', 'amira@example.org');
  await expect(page.getByRole('heading', { name: 'Schau in dein Postfach' })).toBeVisible();

  // falscher Code
  await page.getByLabel('6-stelliger Code').fill('000000');
  await page.getByRole('button', { name: 'Anfrage abschicken' }).click();
  const wrong = page.getByText(/Der Code stimmt nicht/);
  if (await wrong.count()) await expect(wrong).toBeVisible();

  await page.getByLabel(/Code/).first().fill(codeFor('amira@example.org'));
  await page.getByRole('button', { name: /Anfrage abschicken|Noch einmal versuchen/ }).click();
  await expect(page.getByRole('heading', { name: 'Danke! Deine Anfrage ist da.' })).toBeVisible();
  await expect(page.getByText('vorläufig reserviert')).toBeVisible();

  // Doppelbuchung wird verhindert
  await page.goto(`/buchen/zeit?raum=viertelsaal&datum=${date}`);
  await page.locator('#von').selectOption('12:00');
  await page.locator('#bis').selectOption('16:00');
  await page.getByRole('button', { name: 'Weiter: Angaben' }).click();
  await expect(page.getByText(/überschneidet sich/).first()).toBeVisible();

  // Raum-AG gibt frei
  await page.goto('/admin/login');
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page.getByRole('heading', { name: /Offene Anfragen/ })).toBeVisible();
  await page.getByPlaceholder('Notiz (wird mitgeschickt)').first().fill('Schlüssel beim Samstagstreff');
  await page.getByRole('button', { name: 'Annehmen' }).first().click();
  await expect(page.getByText(/angenommen/)).toBeVisible();

  // Bestätigung mit Verwaltungslink
  const log = fs.readFileSync('test-results/e2e/server.log', 'utf8');
  const manage = [...log.matchAll(/Buchung verwalten oder stornieren: (http\S+?)\\n/g)].at(-1)![1];
  await page.goto(manage);
  await expect(page.getByRole('heading', { name: /gehört dir/ })).toBeVisible();

  // öffentlich im Terminkalender
  await page.goto('/termine');
  await expect(page.getByText('Kleidertausch fürs Viertel').first()).toBeVisible();

  // Storno
  await page.goto(manage);
  await page.getByRole('link', { name: 'Buchung stornieren' }).click();
  await page.getByRole('button', { name: 'Ja, stornieren' }).click();
  await expect(page.getByRole('heading', { name: 'Storniert' })).toBeVisible();
});

test('Fall A: Zeit wird vergeben, während jemand das Formular ausfüllt', async ({ browser }) => {
  const date = futureDate(21);
  const a = await browser.newPage();
  const b = await browser.newPage();
  await fillRequest(a, date, '16:00', '18:00', 'a@example.org');
  const codeA = codeFor('a@example.org');
  await fillRequest(b, date, '16:00', '18:00', 'b@example.org');
  const codeB = codeFor('b@example.org');
  await b.getByLabel('6-stelliger Code').fill(codeB);
  await b.getByRole('button', { name: 'Anfrage abschicken' }).click();
  await expect(b.getByText('vorläufig reserviert')).toBeVisible();
  await a.getByLabel('6-stelliger Code').fill(codeA);
  await a.getByRole('button', { name: 'Anfrage abschicken' }).click();
  await expect(a.getByRole('heading', { name: 'Diese Zeit ist gerade vergeben worden' })).toBeVisible();
});
