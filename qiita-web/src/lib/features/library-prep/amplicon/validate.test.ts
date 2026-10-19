import { describe, expect, it } from 'vitest';
import { EMPTY_PLATE } from './layout';
import { barcodeProblems, validatePlates, validateRun, validateStudy } from './validate';

const plate = (over: Partial<typeof EMPTY_PLATE> = {}) => ({
  ...Object.fromEntries(Object.keys(EMPTY_PLATE).map((k) => [k, 'x'])),
  primer_plate: '1',
  sample_plate: 'Plate_1',
  primer_date: '2026-01-01',
  ...over
}) as typeof EMPTY_PLATE;

describe('validatePlates', () => {
  it('passes a complete plate', () => {
    expect(validatePlates([{ position: '1', facts: plate() }])).toEqual([]);
  });

  it('flags an empty fact, non-ASCII, a bad primer plate, and a repeat across plates', () => {
    const texts = validatePlates([
      { position: '1', facts: plate({ water_lot: ' ', mastermix_lot: 'lot µ', primer_plate: '11' }) },
      { position: '2', facts: plate({ primer_plate: '11' }) }
    ]).map((m) => `${m.level}: ${m.text}`);
    expect(texts).toContain('error: Position 1: water_lot is empty (write not_applicable)');
    expect(texts).toContain('error: Position 1: mastermix_lot has a non-ASCII character');
    expect(texts).toContain('error: Position 1: primer plate # "11" is not between 1 and 10');
    expect(texts).toContain('error: Sample plate "Plate_1" is used twice');
  });

  it('warns on an unusual primer plate and a future primer date', () => {
    const texts = validatePlates([{ position: '1', facts: plate({ primer_plate: '9', primer_date: '2999-01-01' }) }]).map((m) => m.level + ': ' + m.text);
    expect(texts).toEqual(['warning: Position 1: primer plate 9 is unusual; check it', 'warning: Position 1: primer date 2999-01-01 is in the future']);
  });
});

describe('validateStudy / validateRun', () => {
  const study = { project_name: 'IBD_15663', project_abbreviation: 'IBD', center_project_name: 'x', experiment_design_description: 'x' };
  it('requires a project name ending in the Qiita study ID and a safe abbreviation', () => {
    expect(validateStudy('IBD', study, {})).toEqual([]);
    expect(validateStudy('IBD', { ...study, project_name: 'IBD', project_abbreviation: 'I B' }, {})).toEqual([
      'IBD: project name must end in _<Qiita study ID>, like IBD_15663',
      'IBD: abbreviation may only use letters, digits, "." and "-"'
    ]);
  });
  it('requires a YYYY-MM-DD run date and ASCII', () => {
    expect(validateRun({ run_date: '2026-09-25', instrument_model: 'x' })).toEqual([]);
    expect(validateRun({ run_date: '20260925', instrument_model: 'é' })).toEqual(['Run date must be YYYY-MM-DD', 'Run: instrument_model has a non-ASCII character']);
  });
});

describe('barcodeProblems', () => {
  it('flags a missing barcode and two wells sharing one', () => {
    expect(
      barcodeProblems([
        { well384: 'A1', name: 'a', barcode: 'ACGTACGTACGT' },
        { well384: 'A2', name: 'b', barcode: 'ACGTACGTACGT' },
        { well384: 'A3', name: 'c', barcode: '' }
      ])
    ).toEqual(['1 wells have no barcode: A3', 'A2 and A1 share barcode ACGTACGTACGT']);
  });
});
