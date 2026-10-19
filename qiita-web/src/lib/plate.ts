// Microplate geometry: the 96-well racks and 384-well plates the lab uses. Shared by
// the plate drawing (ui/PlateMap) and the library-prep logic.

export const ROWS_96 = 'ABCDEFGH'.split('');
export const COLS_96 = Array.from({ length: 12 }, (_, i) => i + 1);
export const ROWS_384 = 'ABCDEFGHIJKLMNOP'.split('');
export const COLS_384 = Array.from({ length: 24 }, (_, i) => i + 1);
/** Row-major (A1, A2, … H12): the order a sheet lists a plate's wells in. */
export const WELLS_96 = ROWS_96.flatMap((r) => COLS_96.map((c) => `${r}${c}`));
