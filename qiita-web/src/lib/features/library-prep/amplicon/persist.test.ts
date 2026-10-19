import { describe, expect, it } from 'vitest';
import { applyEdits } from './routing';
import { DraftShapeError, restoreAmplicon } from './persist';
import { emptyAmplicon } from './state';
import { demoPrep, modelOf } from './testing/demo';

/** What a draft goes through: JSON in browser storage. */
const throughStorage = <T>(x: T): unknown => JSON.parse(JSON.stringify(x));

describe('restoreAmplicon', () => {
  it('restores a saved prep exactly: the same state, and the same sheets', () => {
    const { prep, demo } = demoPrep();
    const sheet = modelOf(prep, demo).sheets[0];
    applyEdits(prep, sheet, [
      { row: 0, column: 'runid', value: 'R1' },
      { row: 0, column: 'primer_plate', value: '9' },
      { row: 3, column: 'extractionkit_lot', value: 'LOT' }
    ]);
    prep.blanksTo.SC0007 = '25071';
    const back = restoreAmplicon(throughStorage({ amplicon: prep, step: 2 }));
    expect(back).toEqual(prep);
    expect(modelOf(back, demo).sheets.map((s) => s.text)).toEqual(modelOf(prep, demo).sheets.map((s) => s.text));
  });

  it('keeps the layout a draft saved: positions, primer plates and where blanks go', () => {
    const { prep } = demoPrep();
    prep.rackAt = [3, 2, 1, 0];
    prep.primerAt = ['4', '3', '2', '1'];
    prep.blanksTo = { SC0007: 'other' };
    const back = restoreAmplicon(throughStorage({ amplicon: prep }));
    expect([back.rackAt, back.primerAt, back.blanksTo]).toEqual([[3, 2, 1, 0], ['4', '3', '2', '1'], { SC0007: 'other' }]);
  });

  it('reads a draft saved before the prep was one object, and one-study lastStudy entries', () => {
    const { prep } = demoPrep();
    const legacy = { racks: prep.racks, plateFacts: prep.plateFacts, studyFacts: prep.studyFacts, run: prep.run, lastStudy: { '0:A1': '25060' } };
    const back = restoreAmplicon(throughStorage(legacy));
    expect(back.racks).toEqual(prep.racks);
    expect(back.lastStudy).toEqual({ '0:A1': ['25060'] });
    expect(back.rackAt).toEqual(emptyAmplicon().rackAt);
  });

  it('refuses a damaged draft, naming the field', () => {
    const { prep } = demoPrep();
    const bad = (over: object) => () => restoreAmplicon(throughStorage({ amplicon: { ...prep, ...over } }));
    expect(bad({ racks: 'x' })).toThrow(DraftShapeError);
    expect(bad({ racks: [{ rackId: 1 }] })).toThrow(/racks\[0\] is not a rack scan/);
    expect(bad({ rackAt: [0, 1, 2, 99] })).toThrow(/rackAt is not 4 positions/);
    expect(bad({ primerAt: ['1'] })).toThrow(/primerAt is not 4 primer plates/);
    expect(bad({ plateFacts: { SC0005: { lot: 3 } } })).toThrow(/plateFacts\.SC0005 has the wrong shape/);
    expect(bad({ run: [] })).toThrow(/run is not a set of run facts/);
    expect(() => restoreAmplicon('nope')).toThrow(/the draft is not an object/);
  });
});
