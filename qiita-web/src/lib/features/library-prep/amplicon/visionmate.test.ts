import { describe, expect, it } from 'vitest';
import { demoBox } from '../mock/mock';
import { parseVisionMate, toVisionMate } from './visionmate';

const HEADER = 'TubeCode\tLocationCell\tLocationColumn\tLocationRow\tRackID\tTime\tDate';

describe('parseVisionMate', () => {
  it('round-trips a rack through toVisionMate', () => {
    for (const rack of demoBox().racks) {
      const back = parseVisionMate(rack.fileName, toVisionMate(rack));
      expect(back.problems).toEqual([]);
      expect(back.tubes).toEqual(rack.tubes);
      expect(back.rackId).toBe(rack.rackId);
    }
  });

  it('pads tube codes to 10 digits, as a spreadsheet may have eaten the zeroes', () => {
    const rack = parseVisionMate('r.tsv', `${HEADER}\n363157924\tA1\t1\tA\tSC1\t1\t1`);
    expect(rack.tubes[0].tube).toBe('0363157924');
  });

  it('skips empty positions but refuses anything that is not a tube code', () => {
    const rack = parseVisionMate('r.tsv', `${HEADER}\nNo Read\tA1\t1\tA\tSC1\t1\t1\nABC\tA2\t2\tA\tSC1\t1\t1\n1\tA3\t3\tA\tSC1\t1\t1`);
    expect(rack.tubes.map((t) => t.well)).toEqual(['A3']);
    expect(rack.problems).toEqual(['A2: "ABC" is not a tube code']);
  });

  it('refuses a file that is not a VisionMate export, naming the missing columns', () => {
    expect(parseVisionMate('x.tsv', 'a\tb\n1\t2').problems[0]).toMatch(/not a VisionMate scan: no TubeCode/);
  });

  it('refuses a well off the rack, a row/column that disagrees with its well, and two racks in one file', () => {
    const rack = parseVisionMate(
      'r.tsv',
      `${HEADER}\n1\tZ9\t9\tZ\tSC1\t1\t1\n2\tA1\t2\tA\tSC1\t1\t1\n3\tA2\t2\tA\tSC2\t1\t1`
    );
    expect(rack.problems).toEqual([
      expect.stringMatching(/Z9 well is not on a 96-well rack/),
      'A1: its row and column say A2',
      'rows name 2 racks: SC1, SC2'
    ]);
  });

  it('reads Windows line endings and blank lines', () => {
    expect(parseVisionMate('r.tsv', `${HEADER}\r\n1\tA1\t1\tA\tSC1\t1\t1\r\n\r\n`).tubes).toHaveLength(1);
  });
});
