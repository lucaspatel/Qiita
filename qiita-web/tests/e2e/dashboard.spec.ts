// The home page: the caller's jobs, a page at a time, and their studies (recently opened
// or shared with them), each card on its own read, so one failing read leaves the rest of
// the page working.

import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

const now = Date.now();
const ago = (days: number) => new Date(now - days * 86_400_000).toISOString();
const ticket = (n: number, state: string, updated: string, extra: Record<string, unknown> = {}) => ({
  work_ticket_idx: n,
  action_id: 'taxonomic-profile',
  action_version: '1',
  originator_principal_idx: 1,
  scope_target: { kind: 'prep_sample', prep_sample_idx: n },
  action_context: {},
  state,
  failure_step_name: null,
  created_at: updated,
  updated_at: updated,
  ...extra
});
const study = (n: number, title: string, access_via: string, granted_at: string | null = null) => ({
  study_idx: n,
  title,
  access_via,
  caller_tier: access_via === 'owner' ? 'admin' : 'viewer',
  granted_at
});

/** Answer the two reads; the returned `status` can be changed to fail them later. */
async function stub(page: Page, status = { tickets: 200, studies: 200 }, extraTickets = 0) {
  const tickets = [
    ticket(1, 'completed', ago(0)),
    ticket(2, 'processing', ago(3)),
    ticket(3, 'failed', ago(1), { failure_step_name: 'align' }),
    ...Array.from({ length: extraTickets }, (_, i) => ticket(100 + i, 'completed', ago(2 + i)))
  ];
  await page.route(/\/work-ticket(\?|$)/, (r) =>
    status.tickets === 200
      ? r.fulfill({ json: { tickets, count: tickets.length, truncated: false } })
      : r.fulfill({ status: status.tickets, json: { detail: 'down' } })
  );
  await page.route(/\/study\?/, (r) =>
    status.studies === 200
      ? r.fulfill({
          json: {
            studies: [study(30, 'Older share', 'grant', ago(20)), study(20, 'Mine', 'owner'), study(10, 'Newest share', 'grant', ago(1))],
            next_after_study_idx: null
          }
        })
      : r.fulfill({ status: status.studies, json: { detail: 'down' } })
  );
  return status;
}

test('shows the jobs, running first, and the studies shared most recently first', async ({ page, errors }) => {
  void errors;
  await stub(page);
  await page.goto('/');
  const glance = page.getByLabel('At a glance');
  await expect(glance.getByText('Running jobs').locator('..')).toContainText('1');
  await expect(glance.getByText('Failed this week').locator('..')).toContainText('1');
  await expect(glance.getByText('Shared with you').locator('..')).toContainText('2');
  const jobs = page.getByRole('list', { name: 'Your jobs' }).getByRole('listitem');
  await expect(jobs.first()).toContainText('processing');
  await expect(page.getByRole('list', { name: 'Your jobs' })).toContainText('failed at align');
  const shared = page.getByRole('list', { name: 'Shared with you' }).getByRole('link');
  await expect(shared).toHaveText(['Newest share', 'Older share']);
});

test('a failing read empties only its own card, and Retry reloads it', async ({ page, errors }) => {
  void errors;
  const status = await stub(page, { tickets: 503, studies: 200 });
  await page.goto('/');
  await expect(page.getByText("Couldn't load: HTTP 503")).toBeVisible();
  await expect(page.getByRole('list', { name: 'Shared with you' })).toContainText('Newest share');
  status.tickets = 200;
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByRole('list', { name: 'Your jobs' })).toContainText('failed at align');
});

test('a new user sees where to start instead of empty cards', async ({ page, errors }) => {
  void errors;
  await page.route(/\/work-ticket(\?|$)/, (r) => r.fulfill({ json: { tickets: [], count: 0, truncated: false } }));
  await page.route(/\/study\?/, (r) => r.fulfill({ json: { studies: [], next_after_study_idx: null } }));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Where to start' })).toBeVisible();
});

test('jobs past the first page are a click away, and the page buttons stop at the ends', async ({ page, errors }) => {
  void errors;
  await stub(page, undefined, 17); // 20 jobs: pages of 8, 8 and 4
  await page.goto('/');
  const jobs = page.getByRole('list', { name: 'Your jobs' }).getByRole('listitem');
  const pages = page.getByRole('navigation', { name: 'Jobs pages' });
  await expect(jobs).toHaveCount(8);
  await expect(jobs.first()).toContainText('processing');
  await expect(pages).toContainText('1–8 of 20');
  await expect(pages.getByRole('button', { name: 'Previous' })).toBeDisabled();
  await pages.getByRole('button', { name: 'Next' }).click();
  await pages.getByRole('button', { name: 'Next' }).click();
  await expect(jobs).toHaveCount(4);
  await expect(pages).toContainText('17–20 of 20');
  await expect(pages.getByRole('button', { name: 'Next' })).toBeDisabled();
});

test('recently opened and shared studies are two tabs of one card', async ({ page, errors }) => {
  void errors;
  await page.addInitScript((r) => {
    for (const k of ['qiita_recent_studies', 'qiita_recent_studies:custom']) localStorage.setItem(k, r);
  }, JSON.stringify([{ idx: 20, accessible: true, biosampleCount: null, lastOpened: now }]));
  await stub(page);
  await page.goto('/');
  const tabs = page.getByRole('navigation', { name: 'Studies' });
  await expect(page.getByRole('list', { name: 'Recently opened' })).toContainText('Mine');
  await expect(page.getByRole('list', { name: 'Shared with you' })).toHaveCount(0);
  await tabs.getByRole('button', { name: /Shared/ }).click();
  await expect(page.getByRole('list', { name: 'Shared with you' }).getByRole('link')).toHaveText(['Newest share', 'Older share']);
  await expect(page.getByRole('list', { name: 'Recently opened' })).toHaveCount(0);
});

test('the catalogs are off the sidebar and reached from Home', async ({ page, errors }) => {
  void errors;
  await stub(page);
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Jobs', exact: true }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'References', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Reference databases/ })).toHaveAttribute('href', '/references');
  await expect(page.getByRole('link', { name: /Prep protocols/ })).toHaveAttribute('href', '/prep-protocols');
});
