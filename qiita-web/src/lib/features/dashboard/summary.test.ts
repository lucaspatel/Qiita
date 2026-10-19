import { describe, expect, it } from 'vitest';
import type { StudySummary, WorkTicket } from '$lib/api';
import fc from 'fast-check';
import { pageOf, recentTickets, sharedWithMe, stats } from './summary';

const NOW = Date.parse('2026-10-18T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

const ticket = (n: number, state: WorkTicket['state'], updated: string) =>
  ({ work_ticket_idx: n, state, updated_at: updated, created_at: updated }) as WorkTicket;
const study = (n: number, access_via: StudySummary['access_via'], granted_at: string | null = null) =>
  ({ study_idx: n, title: `S${n}`, access_via, granted_at }) as StudySummary;

describe('stats', () => {
  it('counts running tickets, failures in the last week, and owned and shared studies', () => {
    const tickets = [
      ticket(1, 'processing', daysAgo(0)),
      ticket(2, 'queued', daysAgo(30)),
      ticket(3, 'failed', daysAgo(2)),
      ticket(4, 'failed', daysAgo(8)),
      ticket(5, 'completed', daysAgo(1))
    ];
    const studies = [study(1, 'owner'), study(2, 'grant'), study(3, 'grant'), study(4, 'public')];
    expect(stats(tickets, studies, NOW)).toEqual({ running: 2, failedThisWeek: 1, ownStudies: 1, sharedStudies: 2 });
  });
});

describe('recentTickets', () => {
  it('puts running tickets first, then the latest changes', () => {
    const tickets = [ticket(1, 'completed', daysAgo(0)), ticket(2, 'pending', daysAgo(5)), ticket(3, 'failed', daysAgo(1))];
    expect(recentTickets(tickets, 3).map((t) => t.work_ticket_idx)).toEqual([2, 1, 3]);
    expect(recentTickets(tickets, 1)).toHaveLength(1);
  });
});

describe('sharedWithMe', () => {
  it('lists only grants, most recently shared first', () => {
    const studies = [study(9, 'grant', daysAgo(10)), study(8, 'owner'), study(7, 'grant', daysAgo(1)), study(6, 'public')];
    expect(sharedWithMe(studies, 5).map((s) => s.study_idx)).toEqual([7, 9]);
  });

  it('keeps the list order when the server sends no grant times', () => {
    const studies = [study(9, 'grant'), study(7, 'grant'), study(5, 'grant')];
    expect(sharedWithMe(studies, 2).map((s) => s.study_idx)).toEqual([9, 7]);
  });
});

describe('pageOf', () => {
  it('slices one page and says which rows it shows', () => {
    const items = Array.from({ length: 19 }, (_, i) => i);
    expect(pageOf(items, 0, 8)).toEqual({ items: [0, 1, 2, 3, 4, 5, 6, 7], page: 0, pages: 3, from: 1, to: 8 });
    expect(pageOf(items, 2, 8)).toMatchObject({ items: [16, 17, 18], from: 17, to: 19 });
  });

  it('clamps a page past the end to the last page, and an empty list to page one of one', () => {
    expect(pageOf([1, 2, 3], 9, 2)).toMatchObject({ items: [3], page: 1, pages: 2 });
    expect(pageOf([], 4, 8)).toEqual({ items: [], page: 0, pages: 1, from: 0, to: 0 });
  });

  it('walking every page visits each item once, in order', () => {
    fc.assert(
      fc.property(fc.array(fc.integer()), fc.integer({ min: 1, max: 10 }), (items, size) => {
        const { pages } = pageOf(items, 0, size);
        const seen = Array.from({ length: pages }, (_, p) => pageOf(items, p, size).items).flat();
        expect(seen).toEqual(items);
      })
    );
  });
});
