// The study's Samples tab: stored metadata through the shared grid. Every value must sit
// under its own field's header, whichever fields are shown.

import { cell, expect, test, text } from './fixtures';

const field = (value: unknown) => ({ display_name: '', description: null, data_type: 'text', value });
const biosample = (n: number, global: Record<string, unknown>, local: Record<string, unknown>) => ({
  biosample_idx: n,
  biosample_accession: null,
  ena_sample_accession: null,
  export_entity_id: `QB${n}`,
  metadata_checklist: null,
  global_metadata: Object.fromEntries(Object.entries(global).map(([k, v]) => [k, field(v)])),
  local_metadata: Object.fromEntries(Object.entries(local).map(([k, v]) => [k, field(v)])),
  retired: false
});
const SAMPLES = [
  biosample(1, { host_common_name: 'human', ph: '7' }, { diet: 'vegan' }),
  biosample(2, { host_common_name: 'mouse', ph: '=1+1' }, { diet: 'chow' })
];

test.beforeEach(async ({ page, errors }) => {
  void errors;
  // routes added later are matched first, so these answer before the fixture's 404s
  await page.route('**/_env/**/study/7/biosample/list-idxs', (r) => r.fulfill({ json: { idxs: [1, 2] } }));
  await page.route(/\/study\/7\/biosample\/(\d+)$/, (r) => {
    const n = Number(r.request().url().match(/(\d+)$/)![1]);
    return r.fulfill({ json: SAMPLES[n - 1] });
  });
  await page.route(/\/study\/7$/, (r) => r.fulfill({ json: { title: 'Gut study' } }));
  await page.goto('/studies/7');
  await page.getByRole('button', { name: /^Samples/ }).click();
  await expect(page.locator('.qiita-sheet tbody tr')).toHaveCount(2);
});

/** Each header's text → its column index, and the cell texts of one row by header. */
async function rowByHeader(page: import('@playwright/test').Page, y: number) {
  const headers = await page
    .locator('.qiita-sheet thead tr:first-child td[data-x]')
    .evaluateAll((tds) => tds.map((t) => [t.textContent?.trim().toLowerCase() ?? '', Number(t.getAttribute('data-x'))] as const));
  const out: Record<string, string> = {};
  for (const [h, x] of headers) if (h) out[h] = await text(cell(page, x, y));
  return out;
}

test('every value stays under its own header when local fields are hidden and shown again', async ({ page }) => {
  const before = await rowByHeader(page, 1);
  expect(Object.values(before)).toEqual(expect.arrayContaining(['QB2', 'mouse', 'chow']));
  const toggle = page.getByRole('switch', { name: 'Show local metadata' });

  await toggle.click();
  const hidden = await rowByHeader(page, 1);
  expect(Object.keys(hidden).some((h) => h.includes('diet'))).toBe(false);
  expect(Object.values(hidden)).not.toContain('chow');
  for (const [h, v] of Object.entries(hidden)) expect(v, h).toBe(before[h]);

  await toggle.click();
  expect(await rowByHeader(page, 1)).toEqual(before);
});

test('a stored value starting with "=" shows as written', async ({ page }) => {
  expect(Object.values(await rowByHeader(page, 1))).toContain('=1+1');
});
