import { describe, expect, it } from 'vitest';
import { removeRack, wellKey } from './state';
import { demoPrep, modelOf } from './testing/demo';

describe('removeRack', () => {
  it('renumbers everything keyed by rack index, and frees the rack\'s position', () => {
    const { prep } = demoPrep();
    prep.decisions[wellKey(2, 'A1')] = { exclude: true };
    prep.blankEdits[wellKey(3, 'B1')] = true;
    prep.decisions[wellKey(1, 'A1')] = { exclude: true };
    const at = prep.rackAt.indexOf(1);
    removeRack(prep, 1);
    expect(prep.racks.map((r) => r.rackId)).toEqual(['SC0005', 'SC0007', 'SC0008']);
    expect(prep.rackAt[at]).toBeNull();
    expect(prep.decisions).toEqual({ [wellKey(1, 'A1')]: { exclude: true } });
    expect(prep.blankEdits).toEqual({ [wellKey(2, 'B1')]: true });
    expect(Object.keys(prep.lastStudy).every((k) => Number(k.split(':')[0]) < 3)).toBe(true);
  });

  it('leaves the remaining racks\' sheets as they were', () => {
    const { prep, demo } = demoPrep();
    const before = modelOf(prep, demo).sheets.find((s) => s.key === 'other')!;
    removeRack(prep, 0);
    const after = modelOf(prep, demo).sheets.find((s) => s.key === 'other')!;
    expect(after.text).toBe(before.text);
  });
});
