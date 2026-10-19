import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { CellEdit } from '$lib/table/model';
import { AMPLICON_GRID_COLUMNS, AMPLICON_OWNERS } from './columns';
import type { AmpliconModel } from './model';
import { rememberStudies, resolve } from './resolve';
import { partitionConflicts } from '../edits';
import { applyEdits, normalizeTube, slotOf } from './routing';
import type { AmpliconPrep } from './state';
import { demoPrep, modelOf } from './testing/demo';
import type { Demo } from '../mock/mock';

/** Apply edits to one sheet as the page does: route, then let the remember-effect run. */
function edit(prep: AmpliconPrep, demo: Demo, sheetKey: string, edits: CellEdit[]): AmpliconModel {
  const sheet = modelOf(prep, demo).sheets.find((s) => s.key === sheetKey)!;
  applyEdits(prep, sheet, edits);
  rememberStudies(prep, resolve(prep, demo.registry));
  return modelOf(prep, demo);
}

/** A well's row in whichever sheet holds it now, by study and 384-well ID. */
const rowAt = (m: AmpliconModel, sheetKey: string, well384: string) =>
  m.sheets.find((s) => s.key === sheetKey)?.built.find((b) => b.row.well_id_384 === well384)?.row;
const allText = (m: AmpliconModel) => m.sheets.map((s) => s.text).join('\n---\n');

describe('normalizeTube', () => {
  it('reads the sheet\'s zero-stripped code as the same tube', () => {
    expect(normalizeTube('363155982', '0363155982')).toBeNull();
    expect(normalizeTube(' 0363155982 ', '0363155982')).toBeNull();
  });
  it('pads a shorter numeric code to the scanned width, and keeps anything else as typed', () => {
    expect(normalizeTube('123', '0363155982')).toBe('0000000123');
    expect(normalizeTube('365107000', '')).toBe('0365107000'); // a cleared tube restored
    expect(normalizeTube('X-1', '0363155982')).toBe('X-1');
  });
});

describe('applyEdits, by owner', () => {
  it('a plate column sets the plate: every row of that plate, no other plate', () => {
    const { prep, demo } = demoPrep();
    const before = modelOf(prep, demo);
    const ibd = before.sheets[0];
    const plateOfRow0 = ibd.built[0].well.r;
    const m = edit(prep, demo, '25060', [{ row: 0, column: 'extractionkit_lot', value: 'LOT-9' }]);
    for (const b of m.sheets.flatMap((s) => s.built))
      expect(b.row.extractionkit_lot === 'LOT-9').toBe(b.well.r === plateOfRow0);
    expect(prep.plateFacts[prep.racks[plateOfRow0].rackId].extractionkit_lot).toBe('LOT-9');
  });

  it('a study column sets that study only', () => {
    const { prep, demo } = demoPrep();
    const m = edit(prep, demo, '25071', [{ row: 0, column: 'project_abbreviation', value: 'INFX' }]);
    expect(m.sheets.find((s) => s.key === '25071')!.built.every((b) => b.row.project_abbreviation === 'INFX')).toBe(true);
    expect(m.sheets.find((s) => s.key === '25060')!.built.some((b) => b.row.project_abbreviation === 'INFX')).toBe(false);
    // the abbreviation names the study's blanks
    expect(m.sheets.find((s) => s.key === '25071')!.built.filter((b) => b.row.control_description).every((b) => b.row.sample_name.startsWith('BLANK.INFX.'))).toBe(true);
  });

  it('a run column sets the run: every row of every sheet', () => {
    const { prep, demo } = demoPrep();
    const m = edit(prep, demo, '25060', [{ row: 5, column: 'run_date', value: '2027-01-02' }]);
    expect(m.sheets.flatMap((s) => s.built).every((b) => b.row.run_date === '2027-01-02')).toBe(true);
    expect(m.sheets[0].fileName.startsWith('20270102_')).toBe(true);
  });

  it('the primer plate column moves the position\'s primer plate, and its barcodes with it', () => {
    const { prep, demo } = demoPrep();
    const before = modelOf(prep, demo).sheets[0].built[0];
    const m = edit(prep, demo, '25060', [{ row: 0, column: 'primer_plate', value: '7' }]);
    const after = m.sheets[0].built[0];
    expect(after.row.primer_plate).toBe('7');
    expect(after.row.barcode).not.toBe(before.row.barcode);
    expect(prep.primerAt[Number(before.well.position) - 1]).toBe('7');
  });

  it('a tube code goes to the scan and is re-resolved: unknown is flagged and stays in its sheet', () => {
    const { prep, demo } = demoPrep();
    const ibd = modelOf(prep, demo).sheets[0];
    const i = ibd.built.findIndex((b) => !b.row.control_description);
    const well = ibd.built[i].row.well_id_384;
    const m = edit(prep, demo, '25060', [{ row: i, column: 'TubeCode', value: '1234567890' }]);
    expect(rowAt(m, '25060', well)?.TubeCode).toBe('1234567890');
    expect(m.problemsBySheet[0].some((p) => p.at?.column === 'TubeCode' && p.message === 'not in Qiita-miint')).toBe(true);
    expect(m.resolved.needFix).toBe(1);
  });

  it('a tube code typed over a blank keeps the row in its sheet, flagged', () => {
    const { prep, demo } = demoPrep();
    const ibd = modelOf(prep, demo).sheets[0];
    const i = ibd.built.findIndex((b) => b.row.control_description);
    const well = ibd.built[i].row.well_id_384;
    const m = edit(prep, demo, '25060', [{ row: i, column: 'TubeCode', value: '1234567890' }]);
    expect(rowAt(m, '25060', well)).toBeDefined();
    expect(m.sheets[0].built).toHaveLength(ibd.built.length);
  });

  it('a locked column is not written', () => {
    const { prep, demo } = demoPrep();
    const before = allText(modelOf(prep, demo));
    const locked = AMPLICON_GRID_COLUMNS.filter((c) => c.locked).map((c) => c.name);
    expect(locked).toEqual(['primer', 'well_id_384', 'library_construction_protocol', 'linker', 'platform', 'run_center', 'pcr_primers', 'sequencing_meth', 'target_gene', 'target_subfragment', 'center_name', 'control_description', 'well_id_96']);
    const m = edit(prep, demo, '25060', locked.map((column) => ({ row: 0, column, value: 'X' })));
    expect(allText(m)).toBe(before);
  });

  it('a column with no other home is kept on the well, in that study\'s sheet only', () => {
    const { prep, demo } = demoPrep();
    const m = edit(prep, demo, '25060', [{ row: 3, column: 'runid', value: 'R-1' }]);
    expect(m.sheets[0].built.filter((b) => b.row.runid === 'R-1')).toHaveLength(1);
    expect(m.sheets[0].built[3].row.runid).toBe('R-1');
  });

  it('undoing a per-well edit stops pinning the value: it follows its sources again', () => {
    const { prep, demo } = demoPrep();
    const ibd = modelOf(prep, demo).sheets[0];
    const i = ibd.built.findIndex((b) => b.row.control_description);
    const name = ibd.built[i].row.sample_name;
    edit(prep, demo, '25060', [{ row: i, column: 'sample_name', value: 'RENAMED' }]);
    edit(prep, demo, '25060', [{ row: i, column: 'sample_name', value: name }]);
    const m = edit(prep, demo, '25060', [{ row: 0, column: 'project_abbreviation', value: 'IBDX' }]);
    expect(m.sheets[0].built[i].row.sample_name).toBe(name.replace('BLANK.IBD.', 'BLANK.IBDX.'));
  });
});

/** Every editable (column, row) of every sheet, as an fc arbitrary over the demo. */
function arbEdit(m: AmpliconModel) {
  const editable = AMPLICON_GRID_COLUMNS.filter((c) => !c.locked).map((c) => c.name);
  return fc
    .record({ s: fc.nat(m.sheets.length - 1), column: fc.constantFrom(...editable), value: fc.stringMatching(/^[A-Za-z0-9_.-]{0,12}$/) })
    .chain(({ s, column, value }) => fc.record({ s: fc.constant(s), column: fc.constant(column), value: fc.constant(value), row: fc.nat(m.sheets[s].built.length - 1) }));
}

describe('applyEdits, for any edit', () => {
  it('shows the value typed in the cell it was typed in (a tube code without its zeroes)', () => {
    const base = demoPrep();
    fc.assert(
      fc.property(arbEdit(modelOf(base.prep, base.demo)), ({ s, column, value, row }) => {
        const { prep, demo } = demoPrep();
        const sheet = modelOf(prep, demo).sheets[s];
        const well = sheet.built[row].row.well_id_384;
        const m = edit(prep, demo, sheet.key, [{ row, column, value }]);
        // A tube code change can move a well to another study's sheet (a sheet-only
        // rack takes any unknown tube), so the well is found wherever it now is.
        // Prefer the sheet it was typed in: a mixed rack's blank is in several.
        const after = rowAt(m, sheet.key, well) ?? m.sheets.map((x) => rowAt(m, x.key, well)).find(Boolean);
        expect(after).toBeDefined();
        const expected = AMPLICON_OWNERS[column].kind === 'tube' ? value.replace(/^0+/, '') || value : value;
        if (AMPLICON_OWNERS[column].kind === 'tube' && /^\d+$/.test(value) && value.replace(/^0+/, '') === '') return; // all zeroes: no tube code survives padding meaningfully
        expect((after as Record<string, string>)[column]).toBe(expected);
      }),
      { numRuns: 300 }
    );
  });

  it('is undone exactly by writing the old value back', () => {
    const base = demoPrep();
    fc.assert(
      fc.property(arbEdit(modelOf(base.prep, base.demo)), ({ s, column, value, row }) => {
        const { prep, demo } = demoPrep();
        const before = modelOf(prep, demo);
        const sheet = before.sheets[s];
        const old = (sheet.built[row].row as Record<string, string>)[column];
        edit(prep, demo, sheet.key, [{ row, column, value }]);
        // the row may have moved sheets; find it again by well
        const well = sheet.built[row].row.well_id_384;
        const now = modelOf(prep, demo);
        // Prefer the sheet it was in: a mixed rack's blank is in several studies' sheets.
        const holds = (x: (typeof now.sheets)[number]) => x.built.some((b) => b.row.well_id_384 === well && b.well.r === sheet.built[row].well.r);
        const where = now.sheets.find((x) => x.key === sheet.key && holds(x)) ?? now.sheets.find(holds)!;
        const at = where.built.findIndex((b) => b.row.well_id_384 === well);
        const m = edit(prep, demo, where.key, [{ row: at, column, value: old }]);
        expect(allText(m)).toBe(allText(before));
      }),
      { numRuns: 300 }
    );
  });
});

describe('partitionConflicts', () => {
  it('holds back a plate fact given two values in one batch, and lets the rest through', () => {
    const { prep, demo } = demoPrep();
    const sheet = modelOf(prep, demo).sheets[0];
    const { ok, conflicts } = partitionConflicts([
      { row: 0, column: 'extractionkit_lot', value: 'A' },
      { row: 1, column: 'extractionkit_lot', value: 'B' },
      { row: 2, column: 'runid', value: 'R' }
    ], (e) => slotOf(prep, sheet, e));
    expect(ok).toEqual([{ row: 2, column: 'runid', value: 'R' }]);
    expect(conflicts).toEqual([{ slot: expect.stringMatching(/^plate:/), column: 'extractionkit_lot', values: ['A', 'B'] }]);
  });
});
