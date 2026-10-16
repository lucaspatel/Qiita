// In-progress library preps, cached in the browser so a prep survives a refresh
// and several can be worked in parallel. Each draft is one localStorage entry
// `<ns>:<id>` holding { meta, snapshot }: meta is the cheap summary the main-page
// list renders; snapshot is the full wizard state. A prep is scratch until it is
// submitted — on submit the draft is deleted (the server's run/pool become the
// truth, and are content-addressed, so a stale resumed draft re-submits to the
// same entities).

import { scopedKey } from '$lib/environment';

const NS = scopedKey('qiita-web:library-prep:draft');
const keyOf = (id: string) => `${NS}:${id}`;

export type DraftMeta = {
  id: string;
  protocol: string;
  label: string;
  step: number;
  updatedAt: number;
};
type Stored = { meta: DraftMeta; snapshot: unknown };

export function newDraftId(): string {
  return crypto?.randomUUID?.() ?? `d${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

/** Every stored draft's summary, newest first. */
export function listDrafts(): DraftMeta[] {
  const out: DraftMeta[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(`${NS}:`)) continue;
      const v = JSON.parse(localStorage.getItem(k) ?? 'null') as Stored | null;
      if (v?.meta?.id) out.push(v.meta);
    }
  } catch {
    // Storage unavailable: no drafts to list.
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The full wizard snapshot for a draft, or null if it's gone/unreadable. */
export function loadDraft(id: string): unknown | null {
  try {
    const v = JSON.parse(localStorage.getItem(keyOf(id)) ?? 'null') as Stored | null;
    return v?.snapshot ?? null;
  } catch {
    return null;
  }
}

export function saveDraft(meta: DraftMeta, snapshot: unknown): void {
  try {
    localStorage.setItem(keyOf(meta.id), JSON.stringify({ meta, snapshot }));
  } catch {
    // Storage unavailable or full: the prep just won't survive a refresh.
  }
}

export function deleteDraft(id: string): void {
  try {
    localStorage.removeItem(keyOf(id));
  } catch {
    // ignore
  }
}
