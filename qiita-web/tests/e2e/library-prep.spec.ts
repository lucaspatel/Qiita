// The library-prep flow in a browser: the steps and the raw sample sheet are two views
// of one prep, so every edit in one must show in the other, every problem must show in
// both, and nothing the tech does in the sheet — typing, pasting, sorting, undoing,
// loading a file — may lose or misplace a value. The pure logic is unit-tested beside
// it (src/lib/features/library-prep); these tests check the wiring a tech touches.

import { readFileSync } from 'node:fs';
import { cell, columnsOf, demoPrep, expect, openSheet, paste, studyTab, test, text, typeInto } from './fixtures';

test.beforeEach(async ({ page, errors }) => {
  void errors; // installs the API stubs and the page-error check
  await demoPrep(page);
});

test('the sheet is read-only until unlocked, and loading a file needs it unlocked', async ({ page }) => {
  await openSheet(page, { unlock: false });
  const col = await columnsOf(page);
  const before = await text(cell(page, col.runid, 0));
  await cell(page, col.runid, 0).dblclick();
  await page.keyboard.type('X');
  await page.keyboard.press('Enter');
  await expect(cell(page, col.runid, 0)).toHaveText(before);
  await expect(page.locator('input[type=file][disabled]')).toHaveCount(1);
});

test('a plate fact typed in the sheet is that plate\'s: every row of it, and the Details step', async ({ page }) => {
  await openSheet(page);
  const col = await columnsOf(page);
  await typeInto(page, col.extractionkit_lot, 0, 'LOT-FROM-SHEET');
  // rows 0..95 are the first plate in the IBD sheet; the second plate is untouched
  await expect(cell(page, col.extractionkit_lot, 95)).toHaveText('LOT-FROM-SHEET');
  await expect(cell(page, col.extractionkit_lot, 96)).not.toHaveText('LOT-FROM-SHEET');
  await page.getByRole('button', { name: /Back to steps/ }).click();
  await page.getByRole('button', { name: 'Next: Details' }).click();
  const values = await page.locator('input').evaluateAll((ins) => ins.map((i) => (i as HTMLInputElement).value));
  expect(values).toContain('LOT-FROM-SHEET');
});

test('a run fact set on the Details step shows on every row of every sheet', async ({ page }) => {
  await page.getByRole('button', { name: 'Next: Details' }).click();
  await page.locator('#run-date').fill('2026-12-01');
  await openSheet(page, { unlock: false });
  const col = await columnsOf(page);
  await expect(cell(page, col.run_date, 0)).toHaveText('2026-12-01');
  await expect(cell(page, col.run_date, 191)).toHaveText('2026-12-01');
  await studyTab(page, 'Infant gut').click();
  await expect(cell(page, col.run_date, 0)).toHaveText('2026-12-01');
});

test('a bad tube code is flagged in both views and blocks the Plates step until undone', async ({ page }) => {
  await openSheet(page);
  const col = await columnsOf(page);
  const original = await text(cell(page, col.TubeCode, 1));
  await typeInto(page, col.TubeCode, 1, '1234567890');
  await expect(cell(page, col.TubeCode, 1)).toHaveAttribute('title', 'not in Qiita-miint');
  await expect(page.getByRole('region', { name: 'Things to fix' })).toContainText('TubeCode · not in Qiita-miint');
  await page.getByRole('button', { name: /Back to steps/ }).click();
  await expect(page.getByRole('button', { name: /^Next:/ })).toBeDisabled();
  // The fix is typed rather than undone (undo has its own test): the original code, as
  // the sheet shows it, is the same tube.
  await openSheet(page);
  await typeInto(page, col.TubeCode, 1, original);
  await expect(cell(page, col.TubeCode, 1)).toHaveText(original);
  await page.getByRole('button', { name: /Back to steps/ }).click();
  await expect(page.getByRole('button', { name: /^Next:/ })).toBeEnabled();
});

test('undo reverses a sheet edit, including one that changed a whole plate', async ({ page }) => {
  await openSheet(page);
  const col = await columnsOf(page);
  const before = await text(cell(page, col.extractionkit_lot, 50));
  await typeInto(page, col.extractionkit_lot, 0, 'LOT-X');
  await expect(cell(page, col.extractionkit_lot, 50)).toHaveText('LOT-X');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(cell(page, col.extractionkit_lot, 50)).toHaveText(before);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(cell(page, col.extractionkit_lot, 50)).toHaveText('LOT-X');
  await page.keyboard.press('ControlOrMeta+z');
  await page.keyboard.press('Control+y');
  await expect(cell(page, col.extractionkit_lot, 50)).toHaveText('LOT-X');
});

test('a pasted block lands cell for cell; a bad value is listed and its chip finds it on its own tab', async ({ page }) => {
  await openSheet(page);
  const col = await columnsOf(page);
  await cell(page, col.barcode, 3).click();
  await paste(page, 'ACGTACGTACGT\nNOTABARCODE');
  await expect(cell(page, col.barcode, 3)).toHaveText('ACGTACGTACGT');
  await expect(cell(page, col.barcode, 4)).toHaveText('NOTABARCODE');
  await expect(cell(page, col.barcode, 4)).toHaveAttribute('title', 'invalid format');
  const sample = await text(cell(page, col.sample_name, 4));
  await studyTab(page, 'Infant gut').click();
  await page.getByRole('region', { name: 'Things to fix' }).getByRole('button', { name: new RegExp(sample) }).click();
  await expect(studyTab(page, 'IBD')).toHaveAttribute('aria-current', 'page');
  await expect(cell(page, col.barcode, 4)).toHaveClass(/highlight-selected/);
});

test('an edit made after sorting lands on the row it was typed in', async ({ page }) => {
  await openSheet(page);
  const col = await columnsOf(page);
  // sort by sample name, descending (jspreadsheet sorts on a header double-click)
  const header = page.locator(`.qiita-sheet:visible thead tr:first-child td[data-x="${col.sample_name}"]`);
  await header.dblclick();
  await header.dblclick();
  const shownFirst = await text(cell(page, col.sample_name, 0));
  await typeInto(page, col.runid, 0, 'RUN-AFTER-SORT');
  // the value is on the sample it was typed against, wherever that row now sits
  const rows = await page.locator('.qiita-sheet:visible tbody tr').evaluateAll((trs, [xName, xRun]) =>
    trs.map((tr) => [tr.querySelector(`td[data-x="${xName}"]`)?.textContent?.trim(), tr.querySelector(`td[data-x="${xRun}"]`)?.textContent?.trim()]), [col.sample_name, col.runid]);
  const tagged = rows.filter(([, run]) => run === 'RUN-AFTER-SORT').map(([name]) => name);
  expect(tagged).toEqual([shownFirst]);
});

test('one value pasted onto a selected range fills it, as in a spreadsheet', async ({ page }) => {
  await openSheet(page);
  const col = await columnsOf(page);
  await cell(page, col.runid, 0).click();
  for (let i = 0; i < 9; i++) await page.keyboard.press('Shift+ArrowDown');
  await paste(page, 'P');
  for (const y of [0, 4, 9]) await expect(cell(page, col.runid, y)).toHaveText('P');
  await expect(cell(page, col.runid, 10)).toHaveText('');
});

test('select-all, then typing or pasting, cannot touch the hidden row keys', async ({ page }) => {
  await openSheet(page);
  const col = await columnsOf(page);
  const wells = async () => page.locator(`.qiita-sheet:visible tbody td[data-x="${col.well_id_384}"]`).allTextContents();
  const before = await wells();
  await cell(page, col.runid, 0).click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Z');
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+a');
  await paste(page, 'P');
  // the rows are still the same wells, in order: no key was rewritten, so an edit
  // still reaches the row it is typed in
  expect(await wells()).toEqual(before);
  await typeInto(page, col.runid, 5, 'STILL-ROUTED');
  await expect(cell(page, col.runid, 5)).toHaveText('STILL-ROUTED');
});

test('loading the downloaded file changes nothing; a corrected one updates the steps; a self-contradicting one is held back', async ({ page }) => {
  await openSheet(page);
  const col = await columnsOf(page);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download', exact: true }).click()]);
  const original = readFileSync((await download.path())!, 'utf8');
  const load = async (name: string, body: string) => {
    await page.locator('input[type=file]').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(body) });
  };

  await load('same.txt', original);
  await expect(page.getByText('Loaded same.txt: 0 cells changed.')).toBeVisible();

  const lines = original.split('\n');
  const header = lines[0].split('\t');
  const at = (name: string) => header.indexOf(name);
  const edited = lines.map((line, i) => {
    if (i === 0) return line;
    const cells = line.split('\t');
    if (i === 1) cells[at('runid')] = 'R-LOADED';
    if (i <= 96) cells[at('water_lot')] = 'WATER-LOADED'; // the whole first plate
    return cells.join('\t');
  });
  await load('fixed.txt', edited.join('\n'));
  await expect(page.getByText(/Loaded fixed\.txt: 97 cells changed\./)).toBeVisible();
  await expect(cell(page, col.runid, 0)).toHaveText('R-LOADED');
  await expect(cell(page, col.water_lot, 95)).toHaveText('WATER-LOADED');

  const contradicting = edited.map((line, i) => (i === 2 ? line.replace('WATER-LOADED', 'WATER-OTHER') : line));
  await load('mixed.txt', contradicting.join('\n'));
  await expect(page.getByText(/Not applied: water_lot is shared across rows but the file gives it 2 values/)).toBeVisible();
  await expect(cell(page, col.water_lot, 1)).toHaveText('WATER-LOADED');

  await page.getByRole('button', { name: /Back to steps/ }).click();
  await page.getByRole('button', { name: 'Next: Details' }).click();
  const values = await page.locator('input').evaluateAll((ins) => ins.map((i) => (i as HTMLInputElement).value));
  expect(values).toContain('WATER-LOADED');
});

test('a resumed draft brings back the layout and the sheet\'s edits', async ({ page }) => {
  await page.getByLabel('Primer plate for plate 4').selectOption('5');
  await openSheet(page);
  const col = await columnsOf(page);
  await typeInto(page, col.runid, 2, 'R-SAVED');
  await page.reload();
  await page.getByRole('button', { name: 'Resume' }).first().click();
  await expect(page.getByLabel('Primer plate for plate 4')).toHaveValue('5');
  await openSheet(page, { unlock: false });
  await expect(cell(page, col.runid, 2)).toHaveText('R-SAVED');
});

test('undo survives locking, switching study tabs, and going back to the steps', async ({ page }) => {
  await openSheet(page);
  const col = await columnsOf(page);
  const original = await text(cell(page, col.runid, 0));
  const undoOnIbd = async () => {
    await cell(page, col.sample_name, 0).click(); // focus the IBD grid
    await page.keyboard.press('ControlOrMeta+z');
    await expect(cell(page, col.runid, 0)).toHaveText(original);
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expect(cell(page, col.runid, 0)).toHaveText('R-1');
  };
  await typeInto(page, col.runid, 0, 'R-1');

  await page.getByRole('button', { name: 'Lock editing' }).click();
  await page.getByRole('button', { name: 'Unlock editing' }).click();
  await undoOnIbd();

  await studyTab(page, 'Infant gut').click();
  await studyTab(page, 'IBD').click();
  await undoOnIbd();

  await page.getByRole('button', { name: /Back to steps/ }).click();
  await page.getByRole('button', { name: 'View raw samplesheet' }).click();
  await page.getByRole('button', { name: 'Unlock editing' }).click();
  await undoOnIbd();
});

test('a value starting with "=" is text, never a formula: a loaded file cannot run code', async ({ page }) => {
  await openSheet(page);
  const col = await columnsOf(page);
  // jspreadsheet's formula engine hands a formula to `new Function`, so a cell could
  // run any script in the app's origin (with the signed-in user's token).
  const payload = '=[]["filter"]["constructor"]("window.__pwned=1")()';
  await typeInto(page, col.runid, 0, payload);
  await expect(cell(page, col.runid, 0)).toHaveText(payload);
  await typeInto(page, col.water_lot, 0, '=1+1');
  await expect(cell(page, col.water_lot, 0)).toHaveText('=1+1');
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
});
