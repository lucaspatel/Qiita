// Open and query a run-preflight SQLite file entirely in the browser (sql.js /
// WASM), the way the `qiita` CLI opens a local preflight before submitting it —
// no server call, so the service-account-only GET is irrelevant. The preflight a
// pool stores on the server is never fetched here; this works on a local .db.

import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';

let sqlPromise: Promise<SqlJsStatic> | null = null;
const sql = () => (sqlPromise ??= initSqlJs({ locateFile: () => wasmUrl }));

export type QueryResult = { columns: string[]; rows: unknown[][] };
export type TableInfo = { name: string; rows: number };

/** Open a preflight blob as an in-memory SQLite database. */
export async function openPreflight(bytes: Uint8Array): Promise<Database> {
  const SQL = await sql();
  return new SQL.Database(bytes);
}

/** The schema version stamped by run_preflight (PRAGMA user_version). */
export function schemaVersion(db: Database): number {
  const r = db.exec('PRAGMA user_version');
  return (r[0]?.values[0]?.[0] as number) ?? 0;
}

/** Every table with its row count, in name order (views excluded). */
export function tables(db: Database): TableInfo[] {
  const r = db.exec(
    "SELECT name FROM sqlite_master WHERE type = 'table'" +
      " AND name NOT LIKE 'sqlite_%' ORDER BY name"
  );
  const names = (r[0]?.values ?? []).map((v) => String(v[0]));
  return names.map((name) => {
    const c = db.exec(`SELECT count(*) FROM "${name}"`);
    return { name, rows: (c[0]?.values[0]?.[0] as number) ?? 0 };
  });
}

/** Run one statement and return its first result set (columns + rows). A write
 *  (UPDATE/INSERT/DELETE) returns the rows it affected via RETURNING, or empty. */
export function run(db: Database, text: string): QueryResult {
  const res = db.exec(text);
  const first = res[0];
  if (!first) return { columns: [], rows: [] };
  return { columns: first.columns, rows: first.values };
}

/** Rows affected by the last write, for feedback after an edit. */
export function changes(db: Database): number {
  const r = db.exec('SELECT changes()');
  return (r[0]?.values[0]?.[0] as number) ?? 0;
}

// --- schema introspection (the relations viewer) -----------------------------

export type Column = { name: string; type: string; notnull: boolean; pk: boolean; dflt: string | null };
/** A foreign key: this table's `from` column references `table`.`to`. */
export type ForeignKey = { from: string; table: string; to: string };
export type Relation = { from: string; fromCol: string; to: string; toCol: string };

export function columns(db: Database, table: string): Column[] {
  const r = db.exec(`PRAGMA table_info("${table}")`);
  return (r[0]?.values ?? []).map((v) => ({
    name: String(v[1]),
    type: String(v[2] || ''),
    notnull: Number(v[3]) === 1,
    dflt: v[4] === null ? null : String(v[4]),
    pk: Number(v[5]) > 0
  }));
}

export function foreignKeys(db: Database, table: string): ForeignKey[] {
  const r = db.exec(`PRAGMA foreign_key_list("${table}")`);
  // columns: id, seq, table, from, to, on_update, on_delete, match
  return (r[0]?.values ?? []).map((v) => ({
    from: String(v[3]),
    table: String(v[2]),
    to: v[4] === null ? 'rowid' : String(v[4])
  }));
}

/** Every FK edge across the schema, for the referenced-by direction. */
export function allRelations(db: Database): Relation[] {
  const out: Relation[] = [];
  for (const { name } of tables(db))
    for (const fk of foreignKeys(db, name)) out.push({ from: name, fromCol: fk.from, to: fk.table, toCol: fk.to });
  return out;
}

export function viewNames(db: Database): string[] {
  const r = db.exec("SELECT name FROM sqlite_master WHERE type = 'view' ORDER BY name");
  return (r[0]?.values ?? []).map((v) => String(v[0]));
}

/** The CREATE statement for a table or view, as stored. */
export function objectSql(db: Database, name: string): string {
  const r = db.exec(`SELECT sql FROM sqlite_master WHERE name = '${name.replace(/'/g, "''")}'`);
  return String(r[0]?.values[0]?.[0] ?? '');
}

/** Serialize the (possibly edited) database back to bytes, to export or submit. */
export function exportBytes(db: Database): Uint8Array {
  return db.export();
}
