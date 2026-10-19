// The long-read prep as one object, and its run-prep sheet as a view of it: the same
// design as the amplicon flow (amplicon/state, columns, routing), smaller. Each sheet
// column has an owner; an edit made in the sheet goes to it, and the sheet is rebuilt
// from the prep, so the Pool, Barcodes and Details steps and the sheet never disagree.

import { validate, type CellEdit, type GridColumn, type Problem } from '$lib/table/model';
import { DraftShapeError } from '../amplicon/persist';
import { LONGREAD_SPEC } from '../specs';
import { DEMO_RUN, PROTOCOL_KARST_5KB, poolProblems, type PoolSample, type Protocol, type RunFacts } from './longRead';
import {
  KARST_5KB_METHOD,
  LONGREAD_METHOD_COLUMNS,
  LONGREAD_RUN_COLUMNS,
  LONGREAD_SHEET_COLUMNS,
  emptyLongReadSheet,
  longReadFileName,
  longReadRows,
  longReadText,
  type LongReadRow
} from './longReadSheet';

export type LongReadPrep = {
  /** The pool, one sample per row of the sheet, in order. */
  pool: PoolSample[];
  details: Protocol;
  run: RunFacts;
  /** Values typed into the sheet for a column every row shares (the method, the run)
   *  that no step has a field for. */
  shared: Record<string, string>;
  /** Values typed into the sheet for one sample's own columns (the bench numbers), by
   *  its index in the pool. */
  perSample: Record<string, Record<string, string>>;
};

export function emptyLongRead(): LongReadPrep {
  return { pool: [], details: { ...PROTOCOL_KARST_5KB }, run: { ...DEMO_RUN }, shared: {}, perSample: {} };
}

/** Where an edit to each column goes. */
export type LongReadOwner =
  | { kind: 'sample'; field: 'sample_name' | 'barcode_id' }
  | { kind: 'details'; field: 'fwd_primer' | 'rev_primer' | 'umi_pattern' }
  | { kind: 'run'; field: 'instrument_model' | 'run_date' }
  | { kind: 'shared' }
  | { kind: 'perSample' };

const SPECIAL: Record<string, LongReadOwner> = {
  unique_sample_ID: { kind: 'sample', field: 'sample_name' },
  LP_barcodes_ID: { kind: 'sample', field: 'barcode_id' },
  PCR1_primer_fwd_locus_sequence: { kind: 'details', field: 'fwd_primer' },
  PCR1_primer_rev_locus: { kind: 'details', field: 'rev_primer' },
  PCR1_primer_fwd_UMI: { kind: 'details', field: 'umi_pattern' },
  PCR1_primer_rev_UMI: { kind: 'details', field: 'umi_pattern' },
  sequencing_instrument: { kind: 'run', field: 'instrument_model' },
  sequencing_date: { kind: 'run', field: 'run_date' }
};
const SHARED = new Set<string>([...LONGREAD_METHOD_COLUMNS, ...LONGREAD_RUN_COLUMNS]);

export const LONGREAD_OWNERS: Record<string, LongReadOwner> = Object.fromEntries(
  LONGREAD_SHEET_COLUMNS.map((c) => [c, SPECIAL[c] ?? (SHARED.has(c) ? { kind: 'shared' } : { kind: 'perSample' })])
);

const HINTS: Record<LongReadOwner['kind'], string> = {
  sample: 'This sample in the pool (the Pool and Barcodes steps)',
  details: 'The protocol, for every sample (the Details step)',
  run: 'The run, for every sample (the Details step)',
  shared: 'Shared by every sample',
  perSample: 'This sample only'
};

export const LONGREAD_GRID_COLUMNS: GridColumn[] = LONGREAD_SPEC.map((c) => ({ ...c, hint: c.hint ?? HINTS[LONGREAD_OWNERS[c.name].kind] }));

/** A sheet row, and the row the prep's steps alone would build (`base`): a typed value
 *  equal to `base` is no override. */
export type LongReadSheetRow = { row: LongReadRow; base: LongReadRow };

function rowsOf(prep: LongReadPrep, typed: boolean): LongReadRow[] {
  const sharedOf = (cols: readonly string[]) => (typed ? Object.fromEntries(Object.entries(prep.shared).filter(([k]) => cols.includes(k))) : {});
  const method = {
    ...KARST_5KB_METHOD,
    ...sharedOf(LONGREAD_METHOD_COLUMNS),
    PCR1_primer_fwd_locus_sequence: prep.details.fwd_primer,
    PCR1_primer_rev_locus: prep.details.rev_primer,
    PCR1_primer_fwd_UMI: prep.details.umi_pattern,
    PCR1_primer_rev_UMI: prep.details.umi_pattern
  };
  const run = { ...sharedOf(LONGREAD_RUN_COLUMNS), sequencing_instrument: prep.run.instrument_model, sequencing_date: prep.run.run_date };
  const samples = prep.pool.map((s, i) => ({
    ...(typed ? prep.perSample[String(i)] : {}),
    unique_sample_ID: s.sample_name,
    LP_barcodes_ID: s.barcode_id
  }));
  return longReadRows(samples, method, run);
}

export type LongReadModel = {
  rows: LongReadSheetRow[];
  file: { name: string; text: string };
  /** Cell problems (the column rules) and the pool's own problems. */
  problems: Problem[];
};

export function deriveLongRead(prep: LongReadPrep): LongReadModel {
  const typed = rowsOf(prep, true);
  const base = rowsOf(prep, false);
  const rows = typed.map((row, i) => ({ row, base: base[i] }));
  const plain = typed as unknown as Record<string, string>[];
  return {
    rows,
    file: {
      name: longReadFileName({ ...KARST_5KB_METHOD, ...prep.shared }, { sequencing_instrument: prep.run.instrument_model, sequencing_date: prep.run.run_date }),
      text: prep.pool.length ? longReadText(typed) : emptyLongReadSheet()
    },
    problems: [
      ...validate({ columns: LONGREAD_GRID_COLUMNS, rows: plain }).map((i) => ({
        level: 'error' as const,
        message: i.message,
        at: { row: i.row, column: i.column, label: plain[i.row]?.unique_sample_ID, value: plain[i.row]?.[i.column] }
      })),
      ...poolProblems(prep.pool).map((message) => ({ level: 'error' as const, message }))
    ]
  };
}

/** The piece of state an edit writes (see edits.ts). */
export function slotOf(model: LongReadModel, edit: CellEdit): string | null {
  const owner = LONGREAD_OWNERS[edit.column];
  if (!owner || !model.rows[edit.row]) return null;
  switch (owner.kind) {
    case 'sample':
      return `sample:${edit.row}:${owner.field}`;
    case 'details':
      return `details:${owner.field}`;
    case 'run':
      return `run:${owner.field}`;
    case 'shared':
      return `shared:${edit.column}`;
    case 'perSample':
      return `perSample:${edit.row}:${edit.column}`;
  }
}

/** Apply a batch of sheet edits to the prep. Rows are by pool index. */
export function applyEdits(prep: LongReadPrep, model: LongReadModel, edits: CellEdit[]): void {
  for (const { row, column, value } of edits) {
    const owner = LONGREAD_OWNERS[column];
    const r = model.rows[row];
    if (!owner || !r || !prep.pool[row]) continue;
    const base = (r.base as Record<string, string>)[column];
    switch (owner.kind) {
      case 'sample':
        prep.pool[row][owner.field] = value;
        break;
      case 'details':
        prep.details[owner.field] = value;
        break;
      case 'run':
        prep.run[owner.field] = value;
        break;
      case 'shared':
        // A value equal to what the steps give is no override: dropping it lets the
        // column follow them again.
        if (value === base) delete prep.shared[column];
        else prep.shared[column] = value;
        break;
      case 'perSample': {
        const own = (prep.perSample[String(row)] ??= {});
        if (value === base) delete own[column];
        else own[column] = value;
        if (!Object.keys(own).length) delete prep.perSample[String(row)];
        break;
      }
    }
  }
}

/** A stored draft's long-read state, from the new shape (`longRead`) or the fields
 *  older drafts kept at the top level. A field the draft lacks starts as a new prep's;
 *  one in the wrong shape throws, naming it. */
export function restoreLongRead(draft: unknown): LongReadPrep {
  const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  const fail = (field: string, problem: string) => {
    throw new DraftShapeError(field, problem);
  };
  if (!isRecord(draft)) fail('the draft', 'is not an object');
  const d = draft as Record<string, unknown>;
  const src = isRecord(d.longRead) ? d.longRead : { pool: d.lrPool, details: d.lrDetails, run: d.lrRun };
  const prep = emptyLongRead();
  const strings = (v: unknown) => isRecord(v) && Object.values(v).every((x) => typeof x === 'string');
  if (src.pool !== undefined) {
    if (!Array.isArray(src.pool) || !src.pool.every((s) => isRecord(s) && typeof s.sample_name === 'string' && typeof s.barcode_id === 'string'))
      fail('pool', 'is not a list of samples');
    prep.pool = src.pool as PoolSample[];
  }
  if (src.details !== undefined) {
    if (!strings(src.details)) fail('details', 'is not a set of protocol facts');
    prep.details = { ...prep.details, ...(src.details as Protocol) };
  }
  if (src.run !== undefined) {
    if (!strings(src.run)) fail('run', 'is not a set of run facts');
    prep.run = { ...prep.run, ...(src.run as RunFacts) };
  }
  for (const field of ['shared', 'perSample'] as const) {
    const v = src[field];
    if (v === undefined) continue;
    if (field === 'shared' ? !strings(v) : !(isRecord(v) && Object.values(v).every(strings))) fail(field, 'has the wrong shape');
    (prep as Record<string, unknown>)[field] = v;
  }
  return prep;
}
