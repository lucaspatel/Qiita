import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { partitionConflicts } from '../edits';
import { DraftShapeError } from '../amplicon/persist';
import { DEMO_POOL } from './longRead';
import { KARST_5KB_METHOD, LONGREAD_SHEET_COLUMNS, emptyLongReadSheet } from './longReadSheet';
import { LONGREAD_OWNERS, applyEdits, deriveLongRead, emptyLongRead, restoreLongRead, slotOf, type LongReadPrep } from './prep';

const demo = (): LongReadPrep => ({ ...emptyLongRead(), pool: DEMO_POOL.map((s) => ({ ...s })) });
const cellOf = (prep: LongReadPrep, row: number, column: string) => (deriveLongRead(prep).rows[row].row as Record<string, string>)[column];
const edit = (prep: LongReadPrep, row: number, column: string, value: string) => applyEdits(prep, deriveLongRead(prep), [{ row, column, value }]);

describe('the long-read sheet', () => {
  it('is a header alone before the pool is in', () => {
    expect(deriveLongRead(emptyLongRead()).file.text).toBe(emptyLongReadSheet());
  });

  it('has a row per sample: its ID and barcode, the method and run on every row', () => {
    const m = deriveLongRead(demo());
    expect(m.rows).toHaveLength(DEMO_POOL.length);
    expect(m.rows.map((r) => [r.row.unique_sample_ID, r.row.LP_barcodes_ID])).toEqual(DEMO_POOL.map((s) => [s.sample_name, s.barcode_id]));
    expect(m.rows.every((r) => r.row.PCR1_annealing === KARST_5KB_METHOD.PCR1_annealing && r.row.sequencing_instrument === 'Revio')).toBe(true);
    expect(m.file.text.split('\n')[0].split('\t')).toEqual([...LONGREAD_SHEET_COLUMNS]);
    expect(m.problems).toEqual([]);
  });

  it('gives every column exactly one owner', () => {
    expect(Object.keys(LONGREAD_OWNERS)).toEqual([...LONGREAD_SHEET_COLUMNS]);
  });
});

describe('applyEdits, by owner', () => {
  it('a sample ID or barcode changes that sample in the pool', () => {
    const prep = demo();
    edit(prep, 2, 'unique_sample_ID', 'GUT.99');
    edit(prep, 2, 'LP_barcodes_ID', 'bc2002');
    expect([prep.pool[2].sample_name, prep.pool[2].barcode_id]).toEqual(['GUT.99', 'bc2002']);
  });

  it('a primer, UMI or run column changes the details or the run, for every row', () => {
    const prep = demo();
    edit(prep, 0, 'PCR1_primer_fwd_UMI', 'NNNN');
    edit(prep, 0, 'sequencing_date', '2026-11-01');
    expect([prep.details.umi_pattern, prep.run.run_date]).toEqual(['NNNN', '2026-11-01']);
    const m = deriveLongRead(prep);
    expect(m.rows.every((r) => r.row.PCR1_primer_rev_UMI === 'NNNN' && r.row.sequencing_date === '2026-11-01')).toBe(true);
    expect(m.file.name).toBe('20261101_5Kb_Revio_run_prep.txt');
  });

  it('a method column with no step field is shared by every row, and stops being an override when set back', () => {
    const prep = demo();
    edit(prep, 3, 'PCR1_annealing', '57 ℃');
    expect(deriveLongRead(prep).rows.every((r) => r.row.PCR1_annealing === '57 ℃')).toBe(true);
    edit(prep, 0, 'PCR1_annealing', KARST_5KB_METHOD.PCR1_annealing);
    expect(prep.shared).toEqual({});
  });

  it('a bench column is that sample\'s alone', () => {
    const prep = demo();
    edit(prep, 4, 'PCR2_Conc_ng_uL', '12.5');
    const m = deriveLongRead(prep);
    expect(m.rows.map((r) => r.row.PCR2_Conc_ng_uL)).toEqual(['', '', '', '', '12.5', '', '', '']);
    edit(prep, 4, 'PCR2_Conc_ng_uL', '');
    expect(prep.perSample).toEqual({});
  });

  it('a sample ID made blank or repeated is flagged, not lost', () => {
    const prep = demo();
    edit(prep, 1, 'unique_sample_ID', 'GUT.01');
    edit(prep, 2, 'LP_barcodes_ID', '');
    const msgs = deriveLongRead(prep).problems.map((p) => `${p.at?.column ?? ''}:${p.message}`);
    expect(msgs).toContain('unique_sample_ID:duplicate value');
    expect(msgs).toContain('LP_barcodes_ID:required');
  });
});

describe('applyEdits, for any edit', () => {
  const arb = fc.record({
    row: fc.nat(DEMO_POOL.length - 1),
    column: fc.constantFrom(...LONGREAD_SHEET_COLUMNS),
    value: fc.stringMatching(/^[A-Za-z0-9_. -]{0,12}$/)
  });

  it('shows the value typed in the cell it was typed in', () => {
    fc.assert(
      fc.property(arb, ({ row, column, value }) => {
        const prep = demo();
        edit(prep, row, column, value);
        expect(cellOf(prep, row, column)).toBe(value);
      }),
      { numRuns: 300 }
    );
  });

  it('is undone exactly by writing the old value back', () => {
    fc.assert(
      fc.property(arb, ({ row, column, value }) => {
        const prep = demo();
        const before = deriveLongRead(prep).file.text;
        const old = cellOf(prep, row, column);
        edit(prep, row, column, value);
        edit(prep, row, column, old);
        expect(deriveLongRead(prep).file.text).toBe(before);
        expect([prep.shared, prep.perSample]).toEqual([{}, {}]);
      }),
      { numRuns: 300 }
    );
  });
});

describe('conflicts', () => {
  it('a shared column given two values in one batch is held back', () => {
    const prep = demo();
    const m = deriveLongRead(prep);
    const { ok, conflicts } = partitionConflicts(
      [
        { row: 0, column: 'PCR1_annealing', value: 'A' },
        { row: 1, column: 'PCR1_annealing', value: 'B' },
        { row: 2, column: 'PCR2_Conc_ng_uL', value: '3' }
      ],
      (e) => slotOf(m, e)
    );
    expect(ok).toEqual([{ row: 2, column: 'PCR2_Conc_ng_uL', value: '3' }]);
    expect(conflicts.map((c) => c.column)).toEqual(['PCR1_annealing']);
  });
});

describe('restoreLongRead', () => {
  const throughStorage = <T>(x: T): unknown => JSON.parse(JSON.stringify(x));

  it('restores a saved prep exactly', () => {
    const prep = demo();
    edit(prep, 0, 'PCR1_annealing', '57 ℃');
    edit(prep, 3, 'PCR2_Conc_ng_uL', '1');
    edit(prep, 1, 'sequencing_date', '2026-11-01');
    expect(restoreLongRead(throughStorage({ longRead: prep }))).toEqual(prep);
  });

  it('reads a draft from before the prep was one object', () => {
    const prep = demo();
    const back = restoreLongRead(throughStorage({ lrPool: prep.pool, lrDetails: prep.details, lrRun: prep.run }));
    expect(back).toEqual(prep);
  });

  it('refuses a damaged draft, naming the field', () => {
    expect(() => restoreLongRead({ longRead: { pool: 'x' } })).toThrow(DraftShapeError);
    expect(() => restoreLongRead({ longRead: { pool: [], perSample: { 0: 3 } } })).toThrow(/perSample has the wrong shape/);
  });
});
