// A columnar structure held in memory, with validation — the one concept behind
// every tabular surface here: library-prep pre-prep files (short- and long-read),
// add-samples, the metadata viewer/editor, and the files a pre-flight is built from.
// The UI is an alternative view onto this: parse a TSV in, edit it live, validate it,
// serialize it back out. Keeping the model separate from any one screen is what lets
// those surfaces converge on a single editor rather than each reimplementing a grid.

/** One column's identity and rules. All rules are optional; a bare { name } column
 *  accepts anything. `validate` is the escape hatch for anything the flags can't say. */
export type ColumnSpec = {
  name: string;
  /** Header shown in the editor; defaults to `name`. */
  label?: string;
  /** Cell must be non-empty. */
  required?: boolean;
  /** Cell must be one of these (rendered as a dropdown); empty is still allowed
   *  unless `required`. */
  enum?: string[];
  /** Cell must match this when non-empty. */
  pattern?: RegExp;
  /** Non-empty values must be unique down the column. */
  unique?: boolean;
  /** Freeform note shown under the header. */
  hint?: string;
  /** Custom check: return an error message, or null when the cell is fine. */
  validate?: (value: string, row: Row, rows: Row[]) => string | null;
};

/** A column as an editable view shows it: a ColumnSpec, plus whether it can be typed
 *  into. `locked` is the reason it cannot (shown on hover), or absent when it can. */
export type GridColumn = ColumnSpec & { locked?: string; width?: number; scope?: 'global' | 'local' };

export type Row = Record<string, string>;
export type TableModel = { columns: ColumnSpec[]; rows: Row[] };

/** A problem with one cell: which row (0-based), which column, and why. */
export type CellIssue = { row: number; column: string; message: string };

/** One cell edit, by row index. Every change made through a table view — typing,
 *  paste, delete, fill, undo, a loaded file — is a batch of these, so whoever owns the
 *  rows decides where each value lives. */
export type CellEdit = { row: number; column: string; value: string };

/** One thing wrong with a table, from any validator. `at` places it on a cell; without
 *  it the problem is about the table as a whole. */
export type Problem = {
  level: 'error' | 'warning';
  message: string;
  at?: {
    /** Which of several tables (a study's sheet), when there are more than one. */
    sheet?: string;
    row: number;
    column: string;
    /** What names the row to a person: a sample name, not a row number. */
    label?: string;
    value?: string;
  };
};

/** A TSV whose header can't be read as columns: two columns share a name, so which
 *  one a row's value belongs to is ambiguous. */
export class TsvHeaderError extends Error {
  constructor(public readonly duplicates: string[]) {
    super(`the header names ${duplicates.length === 1 ? 'a column' : 'columns'} twice: ${duplicates.join(', ')}`);
    this.name = 'TsvHeaderError';
  }
}

/** A file's lines, with a byte-order mark and Windows/old-Mac line endings removed and
 *  trailing empty lines dropped. */
function tsvLines(text: string): string[] {
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** A file's header, each name trimmed. Throws TsvHeaderError on a repeated name. */
export function tsvHeader(text: string): string[] {
  const header = (tsvLines(text)[0] ?? '').split('\t').map((h) => h.trim());
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const h of header) if (h) (seen.has(h) ? dupes : seen).add(h);
  if (dupes.size) throw new TsvHeaderError([...dupes]);
  return header;
}

const col = (c: ColumnSpec): ColumnSpec => c;
export const columnsFromNames = (names: readonly string[]): ColumnSpec[] => names.map((name) => col({ name }));

/** A blank row with every column present as an empty string. */
export function emptyRow(columns: ColumnSpec[]): Row {
  return Object.fromEntries(columns.map((c) => [c.name, '']));
}

/** Split a TSV into a table. With `columns`, those drive the shape: each line's cells
 *  are read by the file's own header, then projected onto the spec's columns (missing
 *  → blank, unknown file columns dropped). Without `columns`, the header defines them. */
export function parseTsv(text: string, columns?: ColumnSpec[]): TableModel {
  const lines = tsvLines(text);
  if (!lines.length) return { columns: columns ?? [], rows: [] };
  const header = tsvHeader(text);
  const cols = columns ?? columnsFromNames(header);
  const rows: Row[] = lines.slice(1).map((line) => {
    const cells = line.split('\t');
    const byHeader: Row = {};
    header.forEach((h, i) => (byHeader[h] = cells[i] ?? ''));
    const row: Row = {};
    for (const c of cols) row[c.name] = byHeader[c.name] ?? '';
    return row;
  });
  return { columns: cols, rows };
}

/** Header names in the file but not in the spec — dropped by `parseTsv`, surfaced so
 *  a load can warn rather than silently lose columns. */
export function unknownColumns(text: string, columns: ColumnSpec[]): string[] {
  const header = tsvHeader(text);
  const known = new Set(columns.map((c) => c.name));
  return header.filter((h) => h && !known.has(h));
}

/** Serialize back to a TSV: the spec's column order as the header, a row per row. */
export function toTsv(table: TableModel): string {
  const header = table.columns.map((c) => c.name).join('\t');
  const body = table.rows.map((r) => table.columns.map((c) => r[c.name] ?? '').join('\t'));
  return [header, ...body].join('\n');
}

/** Every rule across every cell, in row-then-column order. */
export function validate(table: TableModel): CellIssue[] {
  const issues: CellIssue[] = [];
  // Precompute per-column value counts for `unique`.
  const counts = new Map<string, Map<string, number>>();
  for (const c of table.columns) {
    if (!c.unique) continue;
    const m = new Map<string, number>();
    for (const r of table.rows) {
      const v = (r[c.name] ?? '').trim();
      if (v) m.set(v, (m.get(v) ?? 0) + 1);
    }
    counts.set(c.name, m);
  }
  table.rows.forEach((row, i) => {
    for (const c of table.columns) {
      const raw = row[c.name] ?? '';
      const v = raw.trim();
      const add = (message: string) => issues.push({ row: i, column: c.name, message });
      if (c.required && !v) {
        add('required');
        continue; // an empty required cell: the other rules add nothing useful
      }
      if (!v) continue;
      if (c.enum && !c.enum.includes(v)) add(`not one of: ${c.enum.join(', ')}`);
      if (c.pattern && !c.pattern.test(v)) add('invalid format');
      if (c.unique && (counts.get(c.name)?.get(v) ?? 0) > 1) add('duplicate value');
      const custom = c.validate?.(raw, row, table.rows);
      if (custom) add(custom);
    }
  });
  return issues;
}

/** Issues indexed by `row:column`, for O(1) lookup while rendering cells. */
export function issueIndex(issues: CellIssue[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const it of issues) {
    const k = `${it.row}:${it.column}`;
    m.set(k, m.has(k) ? `${m.get(k)}; ${it.message}` : it.message);
  }
  return m;
}
