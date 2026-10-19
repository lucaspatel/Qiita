import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { toTsv } from '$lib/table/model';
import { AMPLICON_GRID_COLUMNS } from './columns';
import { planLoad } from '../edits';
import { describeLoad, diffLoaded } from '../load';
import { applyEdits, slotOf } from './routing';
import { rememberStudies, resolve } from './resolve';
import { demoPrep, modelOf } from './testing/demo';

const cols = AMPLICON_GRID_COLUMNS;
const KEY = 'well_id_384';
const tsv = (rows: Record<string, string>[]) => toTsv({ columns: cols, rows });

describe('diffLoaded', () => {
  it('finds nothing to change in the file just downloaded, for every sheet', () => {
    const { prep, demo } = demoPrep();
    for (const s of modelOf(prep, demo).sheets) {
      const rows = s.built.map((b) => b.row);
      const r = diffLoaded(rows, s.text, cols, KEY);
      expect(r.edits).toEqual([]);
      expect([r.refused, r.unmatched, r.duplicated, r.ragged, r.lockedDiffers]).toEqual([undefined, [], [], [], []]);
    }
  });

  it('reads the same file with Windows line endings and a byte-order mark', () => {
    const { prep, demo } = demoPrep();
    const s = modelOf(prep, demo).sheets[1];
    expect(diffLoaded(s.built.map((b) => b.row), '﻿' + s.text.replace(/\n/g, '\r\n') + '\r\n', cols, KEY).edits).toEqual([]);
  });

  it('turns exactly the changed cells into edits, matched by well even when rows are reordered', () => {
    const { prep, demo } = demoPrep();
    const s = modelOf(prep, demo).sheets[0];
    const rows = s.built.map((b) => ({ ...b.row }) as Record<string, string>);
    rows[7].runid = 'R7';
    rows[9].barcode = 'AAAACCCCGGGG';
    const r = diffLoaded(s.built.map((b) => b.row), tsv([...rows].reverse()), cols, KEY);
    expect(r.edits).toEqual([
      { row: 9, column: 'barcode', value: 'AAAACCCCGGGG' },
      { row: 7, column: 'runid', value: 'R7' }
    ]);
  });

  it('refuses a file it cannot match: no well column, a repeated header, an empty file', () => {
    const rows = demoPrep().prep && modelOf(demoPrep().prep, demoPrep().demo).sheets[0].built.map((b) => b.row);
    expect(diffLoaded(rows, 'sample_name\tbarcode\nx\ty', cols, KEY).refused).toMatch(/no well_id_384 column/);
    expect(diffLoaded(rows, 'well_id_384\twell_id_384\nA1\tA1', cols, KEY).refused).toMatch(/twice: well_id_384/);
    expect(diffLoaded(rows, '', cols, KEY).refused).toBe('the file is empty');
  });

  it('skips and reports rows it cannot place: unknown wells, repeated wells, no well, wrong cell count', () => {
    const { prep, demo } = demoPrep();
    const s = modelOf(prep, demo).sheets[1];
    const base = s.built.map((b) => b.row);
    const text = [
      'well_id_384\trunid',
      'Z99\tA', // no such well
      `${base[0].well_id_384}\tB`,
      `${base[0].well_id_384}\tC`, // repeated
      '\tD', // no well
      `${base[1].well_id_384}\tE\textra` // ragged
    ].join('\n');
    const r = diffLoaded(base, text, cols, KEY);
    expect(r.edits).toEqual([]);
    expect(r.unmatched).toEqual(['Z99']);
    expect(r.duplicated).toEqual([base[0].well_id_384]);
    expect(r.unkeyed).toBe(1);
    expect(r.ragged).toEqual([6]);
  });

  it('leaves a column the file lacks as it is, and reports a changed locked column instead of applying it', () => {
    const { prep, demo } = demoPrep();
    const s = modelOf(prep, demo).sheets[1];
    const base = s.built.map((b) => b.row);
    const r = diffLoaded(base, `well_id_384\tprimer\n${base[0].well_id_384}\tACGT`, cols, KEY);
    expect(r.edits).toEqual([]);
    expect(r.lockedDiffers).toEqual(['primer']);
    expect(describeLoad('f.txt', r)).toMatch(/Not applied, as these are set on the steps: primer\./);
  });
});

describe('a load, routed', () => {
  it('applies a file edited anywhere back to the same sheet', () => {
    const base = demoPrep();
    const editable = cols.filter((c) => !c.locked && c.name !== 'TubeCode').map((c) => c.name);
    const sheet0 = modelOf(base.prep, base.demo).sheets[0];
    fc.assert(
      fc.property(fc.nat(sheet0.built.length - 1), fc.constantFrom(...editable), fc.stringMatching(/^[A-Za-z0-9_.-]{1,10}$/), (row, column, value) => {
        const { prep, demo } = demoPrep();
        const s = modelOf(prep, demo).sheets[0];
        const rows = s.built.map((b) => ({ ...b.row }) as Record<string, string>);
        const r = diffLoaded(s.built.map((b) => b.row), tsv(rows.map((x, i) => (i === row ? { ...x, [column]: value } : x))), cols, KEY);
        const { edits, conflicts } = planLoad(r, (e) => slotOf(prep, s, e));
        // A shared column (a plate, study or run fact) changed on one row only is a file
        // that disagrees with itself: held back, not applied.
        if (conflicts.length) {
          expect(edits).toEqual([]);
          return;
        }
        applyEdits(prep, s, edits);
        rememberStudies(prep, resolve(prep, demo.registry));
        const after = modelOf(prep, demo).sheets[0].built[row].row as Record<string, string>;
        expect(after[column]).toBe(value);
      }),
      { numRuns: 200 }
    );
  });

  it('holds back a plate fact the file sets on one row of a plate but not the others', () => {
    const { prep, demo } = demoPrep();
    const s = modelOf(prep, demo).sheets[0];
    const rows = s.built.map((b) => ({ ...b.row }) as Record<string, string>);
    rows[0].extractionkit_lot = 'NEW';
    const r = diffLoaded(s.built.map((b) => b.row), tsv(rows), cols, KEY);
    expect(r.edits).toEqual([{ row: 0, column: 'extractionkit_lot', value: 'NEW' }]);
    const plan = planLoad(r, (e) => slotOf(prep, s, e));
    expect(plan.edits).toEqual([]);
    expect(plan.conflicts.map((c) => [c.column, c.values.sort()])).toEqual([['extractionkit_lot', ['NEW', s.built[1].row.extractionkit_lot].sort()]]);
    expect(describeLoad('f.txt', r, plan.edits.length, plan.conflicts)).toMatch(/Loaded f.txt: 0 cells changed\. Not applied: extractionkit_lot is shared across rows/);
  });

  it('applies a plate fact the file changes on every row of the plate', () => {
    const { prep, demo } = demoPrep();
    const s = modelOf(prep, demo).sheets[0];
    const plate = s.built[0].well.r;
    const rows = s.built.map((b) => ({ ...b.row, ...(b.well.r === plate ? { extractionkit_lot: 'NEW' } : {}) }) as Record<string, string>);
    const plan = planLoad(diffLoaded(s.built.map((b) => b.row), tsv(rows), cols, KEY), (e) => slotOf(prep, s, e));
    expect(plan.conflicts).toEqual([]);
    applyEdits(prep, s, plan.edits);
    expect(modelOf(prep, demo).sheets[0].built.filter((b) => b.well.r === plate).every((b) => b.row.extractionkit_lot === 'NEW')).toBe(true);
  });
});
