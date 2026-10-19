import { describe, expect, it } from 'vitest';
import { demoBox } from '../mock/mock';
import { autoPlace, layoutProblems, placed, seedFacts } from './layout';
import { resolve } from './resolve';
import { emptyAmplicon } from './state';
import { demoPrep } from './testing/demo';

describe('autoPlace', () => {
  it('puts each rack at its default position, with the default primer plate', () => {
    const demo = demoBox();
    const prep = emptyAmplicon();
    prep.racks = demo.racks;
    expect(autoPlace(prep, demo.plates)).toBe(true);
    expect(placed(prep).map((p) => [prep.racks[p.r].rackId, p.position])).toEqual([
      ['SC0005', '1'],
      ['SC0007', '2'],
      ['SC0006', '3'],
      ['SC0008', '4']
    ]);
    expect(autoPlace(prep, demo.plates)).toBe(false); // nothing left to place
  });

  it('takes the first free position when the default is taken or unknown, and frees a removed rack\'s', () => {
    const demo = demoBox();
    const prep = emptyAmplicon();
    prep.racks = [demo.racks[2]];
    prep.rackAt = [null, null, null, null];
    autoPlace(prep, {});
    expect(prep.rackAt).toEqual([0, null, null, null]);
    prep.rackAt = [5, null, null, null]; // a rack that no longer exists
    autoPlace(prep, {});
    expect(prep.rackAt).toEqual([0, null, null, null]);
  });
});

describe('layoutProblems', () => {
  it('none for the settled demo', () => {
    const { prep, demo } = demoPrep();
    expect(layoutProblems(prep, resolve(prep, demo.registry))).toEqual([]);
  });

  it('names an unplaced rack, a rack in two positions, a primer plate used twice, unassigned blanks', () => {
    const { prep, demo } = demoPrep();
    prep.rackAt = [0, 0, 2, null];
    prep.primerAt = ['1', '1', '3', '4'];
    delete prep.blanksTo.SC0007;
    expect(layoutProblems(prep, resolve(prep, demo.registry))).toEqual([
      'A rack is in two positions',
      'Every rack needs a position',
      'A primer plate is used twice',
      "Say which study SC0007's blanks belong to"
    ]);
  });
});

describe('seedFacts', () => {
  it('never overwrites what the tech typed', () => {
    const { prep, demo } = demoPrep();
    prep.plateFacts.SC0005.water_lot = 'TYPED';
    prep.run.run_date = '2030-01-01';
    seedFacts(prep, { plates: demo.plates, studyFacts: demo.studyFacts, run: demo.run }, { plate: { water_lot: 'LAST' }, instrument_model: 'X' });
    expect(prep.plateFacts.SC0005.water_lot).toBe('TYPED');
    expect(prep.run.run_date).toBe('2030-01-01');
  });

  it('fills a rack it has no defaults for from the last prep, bar the per-plate identity', () => {
    const prep = emptyAmplicon();
    prep.racks = [{ fileName: 'x', rackId: 'NEW', tubes: [], problems: [] }];
    expect(seedFacts(prep, {}, { plate: { water_lot: 'LAST', sample_plate: 'P9' }, instrument_model: 'MiSeq' })).toBe(true);
    expect(prep.plateFacts.NEW.water_lot).toBe('LAST');
    expect(prep.plateFacts.NEW.sample_plate).toBe('');
    expect(prep.run.instrument_model).toBe('MiSeq');
  });
});
