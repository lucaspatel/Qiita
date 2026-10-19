import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Biosample, MetaField } from '$lib/api';
import { parseTsv } from '$lib/table/model';
import type { Issue, Review } from './review';
import { metadataColumns } from './samples';
import { metameqInput, placeReview, SAMPLE_NAME } from './validate';

const field = (value: unknown): MetaField => ({ display_name: '', description: null, data_type: 'text', value });

function sample(n: number, global: Record<string, unknown>, local: Record<string, unknown> = {}): Biosample {
  return {
    biosample_idx: n,
    biosample_accession: null,
    ena_sample_accession: null,
    export_entity_id: `QB${n}`,
    metadata_checklist: null,
    global_metadata: Object.fromEntries(Object.entries(global).map(([k, v]) => [k, field(v)])),
    local_metadata: Object.fromEntries(Object.entries(local).map(([k, v]) => [k, field(v)])),
    retired: false
  };
}

const issue = (sample: string, f: string, kind: Issue['kind'] = 'error', message = 'bad'): Issue => ({
  sample,
  field: f,
  value: null,
  kind,
  message,
  suggestions: []
});
const review = (issues: Issue[]): Review => ({
  processed: true,
  errors: [],
  issues,
  extension: null,
  summary: { cells: 0, samples: 0, rows: 0, fixable: 0 }
});

describe('metameqInput', () => {
  it('is one row per sample, in order, keyed by its public label', () => {
    const samples = [sample(1, { host: 'human' }), { ...sample(2, { host: 'mouse' }), biosample_accession: 'SAMN9' }];
    const input = metameqInput(samples, metadataColumns(samples));
    expect(input.headers).toEqual([SAMPLE_NAME, 'host']);
    expect(input.rows).toEqual([['QB1', 'human'], ['SAMN9', 'mouse']]);
  });

  it('writes missing values as empty and terms by their label', () => {
    const samples = [
      sample(1, { host: { kind: 'missing_reason', name: 'not collected' }, env: { kind: 'terminology_term', label: 'soil' }, ph: null })
    ];
    expect(metameqInput(samples, metadataColumns(samples)).rows[0]).toEqual(['QB1', 'not collected', 'soil', '']);
  });

  it('keeps every value in its own cell, whatever characters it holds', () => {
    // a value with a tab or a line break would otherwise move every later cell
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.string(), fc.string()), { minLength: 1, maxLength: 5 }), (pairs) => {
        const samples = pairs.map(([a, b], i) => sample(i + 1, { a, b }));
        const input = metameqInput(samples, metadataColumns(samples));
        const parsed = parseTsv(input.tsv);
        expect(parsed.rows).toHaveLength(samples.length);
        parsed.rows.forEach((row, i) => expect(row[SAMPLE_NAME]).toBe(`QB${i + 1}`));
      })
    );
  });
});

describe('placeReview', () => {
  const samples = [sample(1, { host: 'x', ph: '7' }), sample(2, { host: 'y', ph: 'z' })];
  const input = metameqInput(samples, metadataColumns(samples));

  it('puts each finding on its sample\'s row and its field\'s column', () => {
    const { issues, problems } = placeReview(review([issue('QB2', 'ph', 'error', 'not a number')]), input, 'accession');
    expect(issues.get('1:ph')).toBe('not a number');
    expect(problems).toEqual([{ level: 'error', message: 'not a number', at: { row: 1, column: 'ph', label: 'QB2', value: undefined } }]);
  });

  it('puts a sample_name finding on the grid\'s id column', () => {
    const { issues } = placeReview(review([issue('QB1', SAMPLE_NAME)]), input, 'accession');
    expect([...issues.keys()]).toEqual(['0:accession']);
  });

  it('keeps every finding on one cell', () => {
    const { issues, problems } = placeReview(review([issue('QB1', 'host', 'error', 'one'), issue('QB1', 'host', 'curation', 'two')]), input, 'accession');
    expect(issues.get('0:host')).toBe('one; two');
    expect(problems.map((p) => p.level)).toEqual(['error', 'warning']);
  });

  it('lists a finding on a field or sample not on the grid without a cell', () => {
    const { issues, problems } = placeReview(review([issue('QB1', 'country'), issue('QB9', 'host')]), input, 'accession');
    expect(issues.size).toBe(0);
    expect(problems.every((p) => !p.at)).toBe(true);
    expect(problems[0].message).toBe('country: bad');
  });
});
