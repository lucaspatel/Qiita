import { describe, expect, it } from 'vitest';
import { AMPLICON_GRID_COLUMNS, AMPLICON_OWNERS } from './columns';
import { SHEET_COLUMNS } from './sampleSheet';

describe('column owners', () => {
  it('give every sheet column exactly one owner, and the grid every column in sheet order', () => {
    expect(Object.keys(AMPLICON_OWNERS)).toEqual([...SHEET_COLUMNS]);
    expect(AMPLICON_GRID_COLUMNS.map((c) => c.name)).toEqual([...SHEET_COLUMNS]);
  });

  it('send each column where the steps keep it', () => {
    const kinds = Object.fromEntries(Object.entries(AMPLICON_OWNERS).map(([c, o]) => [c, o.kind]));
    expect(kinds).toMatchObject({
      sample_name: 'row',
      barcode: 'row',
      primer_plate: 'primer_plate',
      extractionkit_lot: 'plate',
      sample_plate: 'plate',
      project_name: 'study',
      project_abbreviation: 'study',
      run_date: 'run',
      instrument_model: 'run',
      TubeCode: 'tube',
      well_id_384: 'locked',
      control_description: 'locked'
    });
  });
});
