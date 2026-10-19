// The long-read flow's run-prep sheet: the same two-views-of-one-prep contract as the
// amplicon sheet (library-prep.spec.ts), over the pool, the protocol details and the run.

import { readFileSync } from 'node:fs';
import { cell, columnsOf, expect, openSheet, test, text, typeInto } from './fixtures';

test.beforeEach(async ({ page, errors }) => {
  void errors;
  await page.goto('/library-prep');
  await page.selectOption('#protocol', 'long_read_amplicon');
  await page.locator('#primers').selectOption({ index: 1 });
  await page.getByRole('button', { name: /^Next:/ }).click();
  await page.getByRole('button', { name: 'use the demo pool' }).click();
  await expect(page.getByText('8 samples', { exact: false }).first()).toBeVisible();
});

test('a sample ID typed in the sheet renames the sample in the pool', async ({ page }) => {
  await openSheet(page);
  const col = await columnsOf(page);
  await typeInto(page, col.unique_sample_ID, 2, 'GUT.99');
  await page.getByRole('button', { name: /Back to steps/ }).click();
  // the hidden sheet panel holds the name too; the pool list is the visible one
  await expect(page.getByText('GUT.99').filter({ visible: true })).toHaveCount(1);
});

test('a primer set on the Details step shows on every row, and a sheet edit to it shows on Details', async ({ page }) => {
  await page.getByRole('button', { name: /^Next:/ }).click(); // Barcodes
  await page.getByRole('button', { name: /^Next:/ }).click(); // Details
  const umi = page.getByLabel('UMI pattern');
  await umi.fill('NNNNYRNNNN');
  await openSheet(page);
  const col = await columnsOf(page);
  await expect(cell(page, col.PCR1_primer_fwd_UMI, 0)).toHaveText('NNNNYRNNNN');
  await expect(cell(page, col.PCR1_primer_rev_UMI, 7)).toHaveText('NNNNYRNNNN');
  await typeInto(page, col.PCR1_primer_fwd_UMI, 3, 'NNNYRNNN');
  await page.getByRole('button', { name: /Back to steps/ }).click();
  await expect(umi).toHaveValue('NNNYRNNN');
});

test('a bench value stays on its sample; a shared method value goes on every row', async ({ page }) => {
  await openSheet(page);
  const col = await columnsOf(page);
  await typeInto(page, col.PCR2_Conc_ng_uL, 4, '12.5');
  await typeInto(page, col.PCR1_annealing, 0, '57 C');
  await expect(cell(page, col.PCR2_Conc_ng_uL, 4)).toHaveText('12.5');
  await expect(cell(page, col.PCR2_Conc_ng_uL, 5)).toHaveText('');
  await expect(cell(page, col.PCR1_annealing, 7)).toHaveText('57 C');
});

test('loading the downloaded file changes nothing; an edited one is applied', async ({ page }) => {
  await openSheet(page);
  const col = await columnsOf(page);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download', exact: true }).click()]);
  const original = readFileSync((await download.path())!, 'utf8');
  const load = (name: string, body: string) => page.locator('input[type=file]').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(body) });
  await load('same.txt', original);
  await expect(page.getByText('Loaded same.txt: 0 cells changed.')).toBeVisible();
  const lines = original.split('\n');
  const at = lines[0].split('\t').indexOf('PCR2_Conc_ng_uL');
  const edited = lines.map((l, i) => (i === 3 ? l.split('\t').map((c, j) => (j === at ? '9.9' : c)).join('\t') : l));
  await load('edited.txt', edited.join('\n'));
  await expect(page.getByText('Loaded edited.txt: 1 cell changed.')).toBeVisible();
  await expect(cell(page, col.PCR2_Conc_ng_uL, 2)).toHaveText('9.9');
  expect(await text(cell(page, col.PCR2_Conc_ng_uL, 1))).toBe('');
});

test('a resumed draft brings back the sheet\'s edits', async ({ page }) => {
  await openSheet(page);
  const col = await columnsOf(page);
  await typeInto(page, col.PCR2_Conc_ng_uL, 1, '7.5');
  await page.reload();
  await page.getByRole('button', { name: 'Resume' }).first().click();
  await openSheet(page, { unlock: false });
  await expect(cell(page, col.PCR2_Conc_ng_uL, 1)).toHaveText('7.5');
});
