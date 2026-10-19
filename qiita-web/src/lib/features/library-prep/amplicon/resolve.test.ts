import { describe, expect, it } from 'vitest';
import { blankStudies, mixedRacks, problemOf, resolve } from './resolve';
import { EACH, OTHER, wellKey } from './state';
import { demoPrep } from './testing/demo';

describe('resolve', () => {
  it('as scanned: the made-up study\'s tubes are unknown until kept sheet-only', () => {
    const { prep, demo } = demoPrep({ settle: false });
    const r = resolve(prep, demo.registry);
    expect(r.unknown.length).toBe(88 + 94);
    expect(r.studyKeys).toEqual(['25060', '25071']);
    prep.sheetOnly.SC0007 = prep.sheetOnly.SC0008 = true;
    const kept = resolve(prep, demo.registry);
    expect(kept.unknown).toEqual([]);
    expect(kept.studyKeys).toEqual(['25060', '25071', OTHER]);
  });

  it('a tube scanned twice is a duplicate in both wells, until one is left out', () => {
    const { prep, demo } = demoPrep();
    prep.racks[1].tubes[0].tube = prep.racks[0].tubes[5].tube;
    const r = resolve(prep, demo.registry);
    expect(r.dupes.map((x) => `${x.r}:${x.well}`)).toEqual(['0:' + prep.racks[0].tubes[5].well, '1:' + prep.racks[1].tubes[0].well]);
    expect(problemOf(r.dupes[0].cell)).toMatch(/the same tube is also at SC0006/);
    prep.decisions[wellKey(1, prep.racks[1].tubes[0].well)] = { exclude: true };
    expect(resolve(prep, demo.registry).dupes).toEqual([]);
  });

  it('a tube in several studies waits for a choice, then joins the chosen study', () => {
    const { prep, demo } = demoPrep();
    const tube = prep.racks[0].tubes[10].tube;
    const registry = new Map(demo.registry).set(tube, { kind: 'multi', qb: 'QB1', studies: [25060, 25071] });
    const well = prep.racks[0].tubes[10].well;
    expect(resolve(prep, registry).multi).toHaveLength(1);
    prep.decisions[wellKey(0, well)] = { primary: 25071 };
    const r = resolve(prep, registry);
    expect(r.multi).toEqual([]);
    expect(r.cells[0][well].cell).toEqual({ state: 'sample', study: '25071', qb: 'QB1' });
  });

  it('a sample marked as a blank is a blank', () => {
    const { prep, demo } = demoPrep();
    const well = prep.racks[0].tubes.find((t) => demo.registry.get(t.tube)?.kind === 'ok')!.well;
    prep.blankEdits[wellKey(0, well)] = true;
    expect(resolve(prep, demo.registry).cells[0][well].cell.state).toBe('blank');
  });

  it('sends a mixed rack\'s blanks where the tech says: one study, each, or none until asked', () => {
    const { prep, demo } = demoPrep();
    const r = resolve(prep, demo.registry);
    const mixed = mixedRacks(prep, r);
    expect(mixed.map((i) => prep.racks[i].rackId)).toEqual(['SC0007']);
    const at = mixed[0];
    expect(blankStudies(prep, r, at)).toEqual(['25071', OTHER]);
    prep.blanksTo.SC0007 = '25071';
    expect(blankStudies(prep, r, at)).toEqual(['25071']);
    delete prep.blanksTo.SC0007;
    expect(blankStudies(prep, r, at)).toEqual([]);
    prep.blanksTo.SC0007 = EACH;
    expect(blankStudies(prep, r, 0)).toEqual(['25060']); // a one-study rack ignores it
  });
});
