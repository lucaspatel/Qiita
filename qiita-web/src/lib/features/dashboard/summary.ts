// What the home page shows, from the caller's own tickets and readable studies: counts
// for the stats row, the tickets worth a look first, and the studies shared with them.

import type { StudySummary, WorkTicket, WorkTicketState } from '$lib/api';

const ACTIVE: ReadonlySet<WorkTicketState> = new Set(['pending', 'queued', 'processing']);
export const isActive = (t: Pick<WorkTicket, 'state'>) => ACTIVE.has(t.state);

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const time = (iso: string | null | undefined) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? -Infinity : t;
};

export type Stats = { running: number; failedThisWeek: number; ownStudies: number; sharedStudies: number };

export function stats(tickets: WorkTicket[], studies: StudySummary[], now: number): Stats {
  return {
    running: tickets.filter(isActive).length,
    failedThisWeek: tickets.filter((t) => t.state === 'failed' && now - time(t.updated_at) <= WEEK_MS).length,
    ownStudies: studies.filter((s) => s.access_via === 'owner').length,
    sharedStudies: studies.filter((s) => s.access_via === 'grant').length
  };
}

/** The tickets to look at first: running ones, then the rest, each newest change first. */
export function recentTickets<T extends WorkTicket>(tickets: T[], n = Infinity): T[] {
  return [...tickets]
    .sort((a, b) => Number(isActive(b)) - Number(isActive(a)) || time(b.updated_at) - time(a.updated_at))
    .slice(0, n);
}

export type Page<T> = { items: T[]; page: number; pages: number; from: number; to: number };

/** One page of `items`, `size` to a page; `page` is clamped, so a list that shrank on a
 *  reload shows its last page rather than an empty one. `from`/`to` count from 1. */
export function pageOf<T>(items: T[], page: number, size: number): Page<T> {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const p = Math.min(Math.max(0, Math.trunc(page)), pages - 1);
  const start = p * size;
  return {
    items: items.slice(start, start + size),
    page: p,
    pages,
    from: items.length ? start + 1 : 0,
    to: Math.min(items.length, start + size)
  };
}

/** Studies someone shared with the caller, most recently shared first. A server that
 *  doesn't send `granted_at` leaves them in the order it listed them. */
export function sharedWithMe(studies: StudySummary[], n: number): StudySummary[] {
  return studies
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.access_via === 'grant')
    .sort((a, b) => time(b.s.granted_at) - time(a.s.granted_at) || a.i - b.i)
    .slice(0, n)
    .map(({ s }) => s);
}
