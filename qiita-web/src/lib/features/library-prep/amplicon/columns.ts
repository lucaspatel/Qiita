// Where each amplicon pre-prep column's value comes from, so an edit made in the sheet
// lands on the state the rest of the library-prep flow reads. The sheet is a view of
// that state: a plate column edited on one row is the plate's fact (every row of the
// plate, and the Details step, follow); a run column is the run's; a TubeCode is the
// scan's. Only a column with no other home keeps its value on the row itself.

import type { GridColumn } from '$lib/table/model';
import { AMPLICON_SPEC } from '../specs';
import { PLATE_COLUMNS, PROTOCOL_16S, STUDY_COLUMNS, SHEET_COLUMNS, type SheetRow } from './sampleSheet';

export type ColumnOwner =
  | { kind: 'locked'; reason: string }
  | { kind: 'primer_plate' }
  | { kind: 'plate'; column: (typeof PLATE_COLUMNS)[number][0] }
  | { kind: 'study'; column: (typeof STUDY_COLUMNS)[number][0] }
  | { kind: 'run'; column: 'run_date' | 'instrument_model' | 'platemap_generation_date' }
  | { kind: 'tube' }
  | { kind: 'row' };

const RUN_COLUMNS = new Set(['run_date', 'instrument_model', 'platemap_generation_date']);
const PLATE = new Set<string>(PLATE_COLUMNS.map(([k]) => k));
const STUDY = new Set<string>(STUDY_COLUMNS.map(([k]) => k));

/** The owner of one sheet column. */
export function ownerOf(column: keyof SheetRow): ColumnOwner {
  if (column in PROTOCOL_16S) return { kind: 'locked', reason: 'Set by the 16S V4 protocol' };
  if (column === 'well_id_384' || column === 'well_id_96')
    return { kind: 'locked', reason: 'Set by the plate layout: move a rack on the Plates step' };
  if (column === 'control_description')
    return { kind: 'locked', reason: 'Set by marking a blank on the Plates step' };
  if (column === 'primer_plate') return { kind: 'primer_plate' };
  if (PLATE.has(column)) return { kind: 'plate', column: column as (typeof PLATE_COLUMNS)[number][0] };
  if (STUDY.has(column)) return { kind: 'study', column: column as (typeof STUDY_COLUMNS)[number][0] };
  if (RUN_COLUMNS.has(column)) return { kind: 'run', column: column as 'run_date' };
  if (column === 'TubeCode') return { kind: 'tube' };
  return { kind: 'row' };
}

/** Every column's owner, in sheet order. */
export const AMPLICON_OWNERS: Record<string, ColumnOwner> = Object.fromEntries(
  SHEET_COLUMNS.map((c) => [c, ownerOf(c)])
);

/** What a header hover says about where an edit goes. */
export function ownerHint(owner: ColumnOwner): string | undefined {
  switch (owner.kind) {
    case 'primer_plate':
      return 'Per plate: sets the primer plate for every well on this plate';
    case 'plate':
      return 'Per plate: sets this value for every well on this plate';
    case 'study':
      return 'Per study: sets this value for every row of this study';
    case 'run':
      return 'Per run: sets this value for every row';
    case 'tube':
      return 'The scanned tube in this well: a change is re-checked against Qiita-miint';
    default:
      return undefined;
  }
}

/** The amplicon sheet's columns as the grid shows them: the spec's rules, locked where
 *  the value is set elsewhere, and each column's owner as its hint. */
export const AMPLICON_GRID_COLUMNS: GridColumn[] = AMPLICON_SPEC.map((c) => {
  const owner = AMPLICON_OWNERS[c.name];
  return { ...c, locked: owner?.kind === 'locked' ? owner.reason : undefined, hint: c.hint ?? (owner ? ownerHint(owner) : undefined) };
});
