// Feature-table views: a feature table read a different way (today, filtered to a
// reference's ASVs) that the server computes on each read and never stores. The
// lineage draws each as a dashed node off the table it reads, and keeps the list in
// this browser so a view survives a reload.
//
// A convenience, like the plot prefs: storage can be absent or throw, and anything
// malformed is dropped. A view naming a reference that is gone fails its read with
// the server's refusal, shown on the node's panel.
import { scopedKey } from './environment';
import type { LineageGroup, LineageNode } from './api';

export type TableView = {
  /** The lineage node id the view reads (a product node's). */
  from: string;
  /** The reference whose ASVs the table is filtered to, and its display name. */
  filterReferenceIdx: number;
  label: string;
};

const VIEW_PREFIX = 'view:';
export const isViewId = (id: string) => id.startsWith(VIEW_PREFIX);
export const viewId = (v: TableView) => `${VIEW_PREFIX}${v.from}@${v.filterReferenceIdx}`;

const key = (studyIdx: number, protocol: string) =>
  scopedKey(`qiita-web:table-views:${studyIdx}:${protocol}`);

const wellFormed = (v: unknown): v is TableView => {
  const o = v as Record<string, unknown>;
  return (
    !!o &&
    typeof o.from === 'string' &&
    typeof o.label === 'string' &&
    typeof o.filterReferenceIdx === 'number' &&
    Number.isInteger(o.filterReferenceIdx) &&
    o.filterReferenceIdx > 0
  );
};

export function loadViews(studyIdx: number, protocol: string): TableView[] {
  try {
    const raw = localStorage.getItem(key(studyIdx, protocol));
    if (!raw) return [];
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) throw new Error('not a list');
    return v.filter(wellFormed);
  } catch {
    saveViews(studyIdx, protocol, []);
    return [];
  }
}

export function saveViews(studyIdx: number, protocol: string, views: TableView[]): void {
  try {
    if (views.length) localStorage.setItem(key(studyIdx, protocol), JSON.stringify(views));
    else localStorage.removeItem(key(studyIdx, protocol));
  } catch {
    // Storage unavailable: the views last as long as the page.
  }
}

/** `g` with each view as a product node off the one it reads (and each sample's
 *  cell there copied from that node). A view whose node is gone is left out. */
export function withViews(g: LineageGroup, views: TableView[]): LineageGroup {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const live = views.filter((v) => byId.get(v.from)?.kind === 'product');
  if (!live.length) return g;
  const nodes: LineageNode[] = live.map((v) => ({
    ...byId.get(v.from)!,
    id: viewId(v),
    label: 'Feature table',
    detail: `filtered to ${v.label}`
  }));
  return {
    ...g,
    nodes: [...g.nodes, ...nodes],
    edges: [...g.edges, ...live.map((v) => ({ source: v.from, target: viewId(v) }))],
    samples: g.samples.map((s) => {
      const cells = { ...s.cells };
      for (const v of live) if (s.cells[v.from]) cells[viewId(v)] = s.cells[v.from];
      return { ...s, cells };
    })
  };
}
