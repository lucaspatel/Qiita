// Shared setup for the browser tests: a signed-in session with every API call
// answered here, and helpers that drive the library-prep flow the way a tech does.

import { test as base, expect, type Locator, type Page } from '@playwright/test';

export const test = base.extend<{ errors: string[] }>({
  errors: async ({ page }, use) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(() => {
      for (const k of ['qiita_token', 'qiita_token:custom']) localStorage.setItem(k, 'test-token');
    });
    await page.route('**/_env/**', (route) => {
      const url = route.request().url();
      if (url.includes('/auth/whoami'))
        return route.fulfill({ json: { kind: 'human', principal_idx: 1, email: 'tech@example.org', system_role: 'system_admin', scopes: [], profile_complete: true } });
      if (url.includes('/prep-protocol')) return route.fulfill({ json: [] });
      return route.fulfill({ status: 404, json: { detail: `no test response for ${url}` } });
    });
    await use(errors);
    // Every test fails on an uncaught page error, whatever else it checks.
    expect(errors, 'uncaught page errors').toEqual([]);
  }
});
export { expect };

/** Start an amplicon prep from the demo box and settle it, ending on the Plates step
 *  with every rack placed and nothing left to fix. */
export async function demoPrep(page: Page) {
  await page.goto('/library-prep');
  await page.selectOption('#protocol', 'short_read_amplicon');
  await page.locator('#primers').selectOption({ index: 1 });
  await page.getByRole('button', { name: /^Next:/ }).click();
  for (let i = 0; i < 4; i++) {
    await page.getByRole('button', { name: 'demo', exact: true }).first().click();
  }
  while (await page.getByRole('button', { name: 'Sample sheet only' }).count())
    await page.getByRole('button', { name: 'Sample sheet only' }).first().click();
  for (const sel of await page.locator('select[aria-label^="Blanks of"]').all()) await sel.selectOption('each');
  await expect(page.getByRole('button', { name: /^Next:/ })).toBeEnabled();
}

/** Open the raw sample sheet, unlocking it for editing unless told not to. */
export async function openSheet(page: Page, { unlock = true } = {}) {
  await page.getByRole('button', { name: 'View raw samplesheet' }).click();
  await expect(page.locator('.qiita-sheet:visible tbody tr').first()).toBeVisible();
  if (unlock) {
    await page.getByRole('button', { name: 'Unlock editing' }).click();
    await expect(page.getByRole('button', { name: 'Lock editing' })).toBeVisible();
    await expect(page.locator('.qiita-sheet:visible tbody tr').first()).toBeVisible();
  }
}

/** The sheet as the grid shows it: header names → column index (data-x). */
export async function columnsOf(page: Page): Promise<Record<string, number>> {
  const pairs = await page
    .locator('.qiita-sheet:visible thead tr:first-child td[data-x]')
    .evaluateAll((tds) => tds.map((t) => [t.textContent?.trim() ?? '', Number(t.getAttribute('data-x'))] as const));
  return Object.fromEntries(pairs);
}

export const cell = (page: Page, x: number, y: number): Locator => page.locator(`.qiita-sheet:visible td[data-x="${x}"][data-y="${y}"]`);
export const text = async (l: Locator) => ((await l.textContent()) ?? '').trim();

/** Type a value into a cell, replacing what is there. */
export async function typeInto(page: Page, x: number, y: number, value: string) {
  await cell(page, x, y).click();
  await page.keyboard.press('F2');
  // the editor opens asynchronously; keys sent before it has focus are lost
  await expect(cell(page, x, y).locator('input')).toBeFocused();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type(value);
  await page.keyboard.press('Enter');
}

/** Paste text at the selected cell, as the clipboard would. */
export async function paste(page: Page, value: string) {
  await page.evaluate((t) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', t);
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  }, value);
}

/** The study tab of the sheet view, by label. */
export const studyTab = (page: Page, label: string) => page.locator('nav[aria-label="Study sheets"] button', { hasText: label });
