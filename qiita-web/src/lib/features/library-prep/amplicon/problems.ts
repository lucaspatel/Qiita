// Everything wrong with an amplicon prep, as Problems: per-cell problems for each
// sheet (the column rules, plus what resolution knows about each well's tube), and
// the problems the steps raise that aren't about one cell.

import { validate, type GridColumn, type Problem, type Row } from '$lib/table/model';
import { problemOf, type Resolved } from './resolve';
import type { AmpliconSheet } from './sheets';

/** A problem on one cell, named the way a person finds the row. */
export function cellProblem(sheet: string, rows: Row[], row: number, column: string, message: string, label: string): Problem {
  return { level: 'error', message, at: { sheet, row, column, label: rows[row]?.[label], value: rows[row]?.[column] } };
}

/** One sheet's cell problems: the column rules, and a tube Qiita-miint can't place or
 *  that was scanned twice — so a fix made on the steps or in the sheet clears it in
 *  both. */
export function sheetProblems(sheet: AmpliconSheet, columns: GridColumn[], resolved: Resolved): Problem[] {
  const rows = sheet.built.map((b) => b.row);
  const out = validate({ columns, rows }).map((i) => cellProblem(sheet.key, rows, i.row, i.column, i.message, 'sample_name'));
  sheet.built.forEach((b, i) => {
    const cell = resolved.cells[b.well.r]?.[b.well.well96]?.cell;
    const problem = cell ? problemOf(cell) : '';
    if (problem) out.push(cellProblem(sheet.key, rows, i, 'TubeCode', problem, 'sample_name'));
  });
  return out;
}

/** Problems that aren't about one cell, as the steps raise them. */
export function generalProblems(errors: string[], warnings: string[] = []): Problem[] {
  return [
    ...errors.map((message) => ({ level: 'error' as const, message })),
    ...warnings.map((message) => ({ level: 'warning' as const, message }))
  ];
}
