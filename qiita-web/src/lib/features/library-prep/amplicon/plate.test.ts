import { describe, expect, it } from 'vitest';
import { COLS_384, ROWS_384, WELLS_96, positionOf, to384 } from './plate';

describe('to384', () => {
  it('maps four 96-well plates onto every 384 well exactly once', () => {
    const seen = new Set(['1', '2', '3', '4'].flatMap((q) => WELLS_96.map((w) => to384(q, w))));
    expect(seen.size).toBe(384);
    expect([...seen].every((w) => ROWS_384.includes(w[0]) && COLS_384.includes(Number(w.slice(1))))).toBe(true);
  });

  it("follows metapool's interleave: 1 odd/odd, 2 odd/even, 3 even/odd, 4 even/even", () => {
    expect(['1', '2', '3', '4'].map((q) => to384(q, 'A1'))).toEqual(['A1', 'A2', 'B1', 'B2']);
    expect(to384('4', 'H12')).toBe('P24');
  });

  it('is undone by positionOf', () => {
    for (const q of ['1', '2', '3', '4']) for (const w of WELLS_96) expect(positionOf(w, to384(q, w))).toBe(q);
  });
});
