// Plate geometry: the 96-well racks and the 384-well plate four of them are
// compressed onto (metapool's interleaved quadrants).

import { ROWS_96, ROWS_384 } from '$lib/plate';
export { COLS_96, COLS_384, ROWS_96, ROWS_384, WELLS_96 } from '$lib/plate';

/** metapool's interleaved 4-quadrant compression: position 1 takes odd rows/odd
 *  columns, 2 odd rows/even columns, 3 even rows/odd columns, 4 even/even. */
export function to384(position: string, well96: string): string {
  const r = ROWS_96.indexOf(well96[0]);
  const c = Number(well96.slice(1)) - 1;
  const q = Number(position);
  return `${ROWS_384[2 * r + (q >= 3 ? 1 : 0)]}${2 * c + (q % 2 === 0 ? 1 : 0) + 1}`;
}

/** Which quadrant a plate sits in, from one of its wells' 96 and 384 positions. */
export function positionOf(well96: string, well384: string): string {
  return ['1', '2', '3', '4'].find((q) => to384(q, well96) === well384) ?? '1';
}
