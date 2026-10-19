// metameq over a study's stored biosamples (not an upload): the samples shaped into the
// table metameq reads, and its findings placed back on the grid's cells. The caller runs
// metameq (the Pyodide worker) between the two; nothing here touches it, so both halves
// are tested in node.

import type { Biosample } from '$lib/api';
import { issueIndex, type Problem } from '$lib/table/model';
import type { IssueKind, Review } from './review';
import { cellText, sampleLabel, type Column } from './samples';

/** metameq keys every row by this column. */
export const SAMPLE_NAME = 'sample_name';

const LEVEL: Record<IssueKind, Problem['level']> = { error: 'error', type: 'warning', curation: 'warning' };

export type MetameqInput = { headers: string[]; rows: string[][]; tsv: string };

/** A value as one TSV cell: a tab or line break inside it would split the cell and
 *  shift every cell after it onto the wrong field. */
const asCell = (v: string) => v.replace(/[\t\r\n]+/g, ' ');

/** The samples as metameq's input: `sample_name` (each sample's public label), then
 *  one column per field, one row per sample in `samples` order, so row i is grid row i. */
export function metameqInput(samples: Biosample[], columns: Column[]): MetameqInput {
  const fields = columns.map((c) => c.key).filter((k) => k !== SAMPLE_NAME);
  const headers = [SAMPLE_NAME, ...fields];
  const rows = samples.map((s) => [sampleLabel(s), ...fields.map((k) => cellText(s, k))].map(asCell));
  const tsv = [headers, ...rows].map((cells) => cells.join('\t')).join('\n');
  return { headers, rows, tsv };
}

export type Placed = {
  /** `row:column` → message, for Sheet's `issues`. */
  issues: Map<string, string>;
  /** Every finding for ProblemList: on its cell, or table-level when its sample or
   *  field is not on the grid. */
  problems: Problem[];
};

/** metameq's findings on the grid. `idColumn` is the grid column holding the sample
 *  label, where a finding on `sample_name` belongs. Several findings on one cell are
 *  all kept. */
export function placeReview(review: Review, input: MetameqInput, idColumn: string): Placed {
  const rowOf = new Map(input.rows.map((cells, r) => [cells[0], r]));
  const fields = new Set(input.headers);
  const problems: Problem[] = review.issues.map((issue) => {
    const row = rowOf.get(issue.sample);
    const level = LEVEL[issue.kind];
    if (row === undefined || !fields.has(issue.field)) return { level, message: `${issue.field}: ${issue.message}` };
    const column = issue.field === SAMPLE_NAME ? idColumn : issue.field;
    return { level, message: issue.message, at: { row, column, label: issue.sample, value: issue.value ?? undefined } };
  });
  const issues = issueIndex(problems.flatMap((p) => (p.at ? [{ row: p.at.row, column: p.at.column, message: p.message }] : [])));
  return { issues, problems };
}
