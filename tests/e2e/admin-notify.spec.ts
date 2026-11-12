import { expect, test } from '@playwright/test';

import { codeFor, futureDate, serverLog as log } from './helpers';

test('Raum-AG stellt eine Benachrichtigung ein und bekommt neue Anfragen', async ({ page }) => {
  await page.goto('/admin/login');
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await page.goto('/admin/benachrichtigungen');

  // ungültiges Ziel
  await page.getByRole('radio', { name: /Rocket\.Chat/ }).check();
  await page.getByLabel('Ziel', { exact: true }).fill('raum ag');
  await page.getByRole('button', { name: 'Ziel anlegen' }).click();
  await expect(page.getByText('Bitte #channel, @person oder eine Raum-ID angeben.')).toBeVisible();

  // gültiges E-Mail-Ziel, auch für unbestätigte Formulare
  await page.getByRole('radio', { name: /^E-Mail/ }).check();
  await page.getByLabel('Ziel', { exact: true }).fill('raum-ag@example.org');
  await page.getByLabel(/Formular ausgefüllt, Code noch nicht eingegeben/).check();
  await page.getByRole('button', { name: 'Ziel anlegen' }).click();
  await expect(page.getByText(/E-Mail-Ziel angelegt/)).toBeVisible();
  await page.getByRole('button', { name: 'Test senden' }).click();
  await expect(page.getByText(/Test „gesendet“/)).toBeVisible();
  expect(log()).toContain('[Raum-AG] Test der Raum-AG-Benachrichtigung');

  // Anfrage stellen
  await page.goto(`/buchen/angaben?raum=viertelkueche&datum=${futureDate(30)}&von=10:00&bis=12:00`);
  await page.getByLabel('Dein Name').fill('Bea');
  await page.getByLabel('Was hast du vor?').fill('Kochkurs für Kinder');
  await page.getByLabel('Wie viele Personen ungefähr?').fill('8');
  await page.getByLabel('privat').check();
  await page.getByLabel(/Hausregeln/).check();
  await page.getByRole('button', { name: 'Weiter: Bestätigen' }).click();
  await page.getByPlaceholder('E-Mail-Adresse').fill('bea@example.org');
  await page.getByRole('button', { name: 'Code schicken' }).click();
  await expect.poll(log).toContain('[Raum-AG] Formular ausgefüllt, Code noch offen: Viertelküche');
  expect(log()).not.toContain('[Raum-AG] Neue Anfrage: Viertelküche');

  await page.getByLabel('6-stelliger Code').fill(codeFor('bea@example.org'));
  await page.getByRole('button', { name: 'Anfrage abschicken' }).click();
  await expect(page.getByText('vorläufig reserviert')).toBeVisible();
  await expect.poll(log).toContain('[Raum-AG] Neue Anfrage: Viertelküche');
  // Meldung enthält keine Kontaktdaten der buchenden Person
  const mail = log().split('\n').find((l) => l.includes('[Raum-AG] Neue Anfrage: Viertelküche'))!;
  expect(mail).toContain('"to":"raum-ag@example.org"');
  expect(mail).toContain('/admin/buchung/');
  expect(mail).not.toContain('bea@example.org');

  // pausieren: keine Meldung mehr
  await page.goto('/admin/benachrichtigungen');
  await page.getByRole('button', { name: 'Pausieren' }).click();
  await expect(page.getByText('pausiert', { exact: true })).toBeVisible();
});

test.describe('E-Mail-Adresse geschützt', () => {
  test('im HTML nie im Klartext, mit JavaScript als Link', async ({ page, request }) => {
    for (const path of ['/', '/kontakt', '/impressum', '/wohnen', '/ueber-uns']) {
      const html = await (await request.get(path)).text();
      expect(html, path).not.toMatch(/hallo@treibhausdonaufeld\.at/);
    }
    await page.goto('/kontakt');
    const link = page.locator('main a.eml').first();
    await expect(link).toHaveAttribute('href', 'mailto:hallo@treibhausdonaufeld.at');
    await expect(link).toHaveText('hallo@treibhausdonaufeld.at');
  });

  test('ohne JavaScript lesbar', async ({ browser }) => {
    const ctx = await browser.newContext({ javaScriptEnabled: false });
    const page = await ctx.newPage();
    await page.goto('/wohnen');
    await expect(page.locator('main a.eml').first()).toHaveText('hallo (at) treibhausdonaufeld.at');
    await ctx.close();
  });
});
