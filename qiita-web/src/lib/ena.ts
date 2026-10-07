// Client-side INSDC accession handling for the ENA-import workflow.
//
// A TS mirror of qiita-common/src/qiita_common/ena_accession.py so the UI rejects
// a bad accession with the same message the CLI/route would, BEFORE any POST — the
// route 422s the WHOLE batch on a single malformed accession, so catching it here
// turns a lost submission into inline feedback. The prefix sets are exactly the
// Python side's; keep the two in step if miint's ENAParser grows a prefix.

export const STUDY_PREFIXES = ['PRJNA', 'PRJEB', 'PRJDB', 'ERP', 'SRP', 'DRP'] as const;

const KINDS: Record<string, readonly string[]> = {
  study: STUDY_PREFIXES,
  sample: ['SAMN', 'SAME', 'SAMD'],
  run: ['SRR', 'ERR', 'DRR'],
  experiment: ['SRX', 'ERX', 'DRX']
};

function detectKind(accession: string): string | null {
  const c = accession.trim();
  if (!c) return null;
  for (const [kind, prefixes] of Object.entries(KINDS))
    if (prefixes.some((p) => c.startsWith(p))) return kind;
  return null;
}

/** `null` if `accession` is a well-formed INSDC *study* accession, else a message
 *  naming why — including a well-formed accession of the wrong kind. */
export function studyAccessionError(accession: string): string | null {
  const c = accession.trim();
  if (!c) return 'empty accession';
  const kind = detectKind(c);
  if (kind === null)
    return `'${accession}' does not match a known INSDC accession prefix (study expects ${STUDY_PREFIXES.join('/')})`;
  if (kind !== 'study')
    return `'${accession}' is a ${kind} accession, not a study accession (expected ${STUDY_PREFIXES.join('/')})`;
  return null;
}

export type ParsedAccessions = { accessions: string[]; errors: string[] };

/** Parse pasted text or an uploaded file into study accessions, mirroring the
 *  CLI's `--from-file` contract: one accession per line, blank lines and whole-line
 *  `#` comments skipped, a line carrying a trailing comment / comma / more than one
 *  token refused by line number. Survivors are study-validated and de-duplicated
 *  order-preserving (as the batch driver does). */
export function parseAccessionText(text: string): ParsedAccessions {
  const accessions: string[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    const n = i + 1;
    if (!line || line.startsWith('#')) return;
    if (/[\s,#]/.test(line)) {
      errors.push(`line ${n}: one accession per line — no whitespace, comma, or trailing comment`);
      return;
    }
    const err = studyAccessionError(line);
    if (err) {
      errors.push(`line ${n}: ${err}`);
      return;
    }
    if (seen.has(line)) return;
    seen.add(line);
    accessions.push(line);
  });
  return { accessions, errors };
}

// --- badge colours, in the same vocabulary the Jobs table uses (tickets.ts) ---

// Batch-item lifecycle: pending -> resolving -> registered -> downloading -> done,
// with failed off any step. Terminal states read distinctly (done green, failed
// red); live states blue; not-yet-started amber.
export const BATCH_STATE_CLASS: Record<string, string> = {
  pending: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  resolving: 'bg-blue-50 text-blue-700 ring-blue-600/20',
  registered: 'bg-blue-50 text-blue-700 ring-blue-600/20',
  downloading: 'bg-blue-50 text-blue-700 ring-blue-600/20',
  done: 'bg-green-50 text-green-700 ring-green-600/20',
  failed: 'bg-red-50 text-red-700 ring-red-600/10'
};

// Per-run outcome: a registered run is a win; skipped/excluded are neutral; a held
// run flags amber; a failed run is red.
export const RUN_STATUS_CLASS: Record<string, string> = {
  registered: 'bg-green-50 text-green-700 ring-green-600/20',
  skipped_already_present: 'bg-gray-50 text-gray-600 ring-gray-500/10',
  excluded: 'bg-gray-50 text-gray-600 ring-gray-500/10',
  held_not_downloaded: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  flagged_unavailable: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  failed: 'bg-red-50 text-red-700 ring-red-600/10'
};

export function badgeClass(map: Record<string, string>, key: string): string {
  return map[key] ?? 'bg-gray-50 text-gray-600 ring-gray-500/10';
}

/** Terminal batch-item states — what a watch loop treats as "stop polling". */
export function isTerminal(state: string): boolean {
  return state === 'done' || state === 'failed';
}
