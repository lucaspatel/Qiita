// Batches of sheet edits, across flows. Several rows of a sheet can write one piece of
// state (every row of a plate writes its plate's lot; every row of a pool its method),
// so a batch that gives one such slot two values disagrees with itself. Applying it
// would keep whichever came last, silently; these hold the slot back and say so.

import type { CellEdit } from '$lib/table/model';
import type { LoadResult } from './load';

export type Conflict = { slot: string; column: string; values: string[] };

/** The piece of state an edit writes, as a key two edits share exactly when they write
 *  the same place; null for an edit that writes nothing. Each flow's routing has one. */
export type SlotOf = (edit: CellEdit) => string | null;

/** Split a batch into edits that agree and the slots they disagree about. */
export function partitionConflicts(edits: CellEdit[], slotOf: SlotOf): { ok: CellEdit[]; conflicts: Conflict[] } {
  const values = new Map<string, { column: string; values: Set<string> }>();
  for (const e of edits) {
    const slot = slotOf(e);
    if (!slot) continue;
    const entry = values.get(slot) ?? values.set(slot, { column: e.column, values: new Set() }).get(slot)!;
    entry.values.add(e.value);
  }
  const conflicts = [...values].filter(([, v]) => v.values.size > 1).map(([slot, v]) => ({ slot, column: v.column, values: [...v.values] }));
  const bad = new Set(conflicts.map((c) => c.slot));
  return { ok: edits.filter((e) => !bad.has(slotOf(e) ?? '')), conflicts };
}

/** The edits a load should apply: its changes, less any to a slot the file gives
 *  conflicting values for, judged over everything the file gives (LoadResult.given). */
export function planLoad(load: LoadResult, slotOf: SlotOf): { edits: CellEdit[]; conflicts: Conflict[] } {
  const { conflicts } = partitionConflicts(load.given, slotOf);
  const bad = new Set(conflicts.map((c) => c.slot));
  return { edits: load.edits.filter((e) => !bad.has(slotOf(e) ?? '')), conflicts };
}
