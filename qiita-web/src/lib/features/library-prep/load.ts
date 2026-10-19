// Loading a prep file into a sheet: the loaded rows are matched to the sheet's by a key
// column (the amplicon sheet's 384-well ID, the long-read sheet's sample ID), and only
// the cells that differ become edits, which go through the same routing as typing. So
// loading the file just downloaded changes nothing, and a corrected file changes
// exactly what was corrected.

import { parseTsv, tsvHeader, unknownColumns, type CellEdit, type GridColumn, type Row } from '$lib/table/model';

export type LoadResult = {
  /** The cells that differ from the sheet: what loading changes. */
  edits: CellEdit[];
  /** Every editable cell the file gives a value for, changed or not. Conflicts are
   *  judged over these: a file that sets one plate's lot to A on one row and leaves it
   *  as it is on another disagrees with itself, though only one of the two differs. */
  given: CellEdit[];
  /** Why nothing could be applied, when the file can't be matched at all. */
  refused?: string;
  /** Keys the file names that the sheet doesn't have; their rows are skipped. */
  unmatched: string[];
  /** Keys the file names more than once; which row is meant is ambiguous, so all of
   *  them are skipped. */
  duplicated: string[];
  /** Rows with no key; skipped. */
  unkeyed: number;
  /** Rows whose cell count differs from the header's: a value may be in the wrong
   *  column, so the row is skipped. Line numbers, 1-based, counting the header. */
  ragged: number[];
  /** Header names the sheet has no column for; their values are ignored. */
  ignoredColumns: string[];
  /** Locked columns whose loaded value differs from the sheet's: not applied (they are
   *  set elsewhere), reported so a correction is not silently lost. */
  lockedDiffers: string[];
};

/** Compare a loaded file with the sheet's current rows. Never throws on file content: a
 *  file that can't be matched comes back `refused` with no edits. */
export function diffLoaded(current: Row[], text: string, columns: GridColumn[], key: string): LoadResult {
  const result: LoadResult = { edits: [], given: [], unmatched: [], duplicated: [], unkeyed: 0, ragged: [], ignoredColumns: [], lockedDiffers: [] };
  let header: string[];
  try {
    header = tsvHeader(text);
  } catch (e) {
    return { ...result, refused: (e as Error).message };
  }
  if (!header.some((h) => h)) return { ...result, refused: 'the file is empty' };
  if (!header.includes(key)) return { ...result, refused: `the file has no ${key} column to match its rows by` };
  result.ignoredColumns = unknownColumns(text, columns);

  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  const width = lines[0].split('\t').length;
  const raggedLines = new Set<number>();
  lines.slice(1).forEach((line, i) => {
    if (line.split('\t').length !== width) raggedLines.add(i);
  });
  result.ragged = [...raggedLines].map((i) => i + 2);

  const loaded = parseTsv(text, columns).rows;
  const count = new Map<string, number>();
  for (const row of loaded) {
    const k = row[key]?.trim();
    if (k) count.set(k, (count.get(k) ?? 0) + 1);
  }
  result.duplicated = [...count].filter(([, n]) => n > 1).map(([k]) => k);
  const at = new Map(current.map((r, i) => [r[key], i]));
  const known = new Set(header);

  loaded.forEach((row, li) => {
    if (raggedLines.has(li)) return;
    const k = row[key]?.trim();
    if (!k) {
      result.unkeyed++;
      return;
    }
    if ((count.get(k) ?? 0) > 1) return;
    const i = at.get(k);
    if (i === undefined) {
      result.unmatched.push(k);
      return;
    }
    for (const c of columns) {
      // A column the file doesn't have is left as it is, not blanked.
      if (!known.has(c.name)) continue;
      const value = row[c.name] ?? '';
      if (!c.locked) result.given.push({ row: i, column: c.name, value });
      if (value === (current[i][c.name] ?? '')) continue;
      if (c.locked) {
        if (!result.lockedDiffers.includes(c.name)) result.lockedDiffers.push(c.name);
        continue;
      }
      result.edits.push({ row: i, column: c.name, value });
    }
  });
  return result;
}

/** One line a person can read about what a load did. */
export function describeLoad(
  fileName: string,
  r: LoadResult,
  applied: number = r.edits.length,
  conflicts: { column: string; values: string[] }[] = [],
  key = 'key'
): string {
  if (r.refused) return `Couldn't load ${fileName}: ${r.refused}. Nothing was changed.`;
  const parts = [`Loaded ${fileName}: ${applied} ${applied === 1 ? 'cell' : 'cells'} changed.`];
  for (const c of conflicts)
    parts.push(`Not applied: ${c.column} is shared across rows but the file gives it ${c.values.length} values (${c.values.map((v) => `"${v}"`).join(', ')}).`);
  if (r.unmatched.length) parts.push(`${r.unmatched.length} row(s) name a ${key} this sheet doesn't have (${r.unmatched.slice(0, 3).join(', ')}${r.unmatched.length > 3 ? ', …' : ''}) and were skipped.`);
  if (r.duplicated.length) parts.push(`Rows naming one ${key} more than once were skipped: ${r.duplicated.join(', ')}.`);
  if (r.unkeyed) parts.push(`${r.unkeyed} row(s) with no ${key} were skipped.`);
  if (r.ragged.length) parts.push(`Line(s) ${r.ragged.slice(0, 5).join(', ')}${r.ragged.length > 5 ? ', …' : ''} have the wrong number of cells and were skipped.`);
  if (r.lockedDiffers.length) parts.push(`Not applied, as these are set on the steps: ${r.lockedDiffers.join(', ')}.`);
  if (r.ignoredColumns.length) parts.push(`Ignored ${r.ignoredColumns.length} unrecognized column(s): ${r.ignoredColumns.join(', ')}.`);
  return parts.join(' ');
}
