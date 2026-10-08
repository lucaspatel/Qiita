// Client-side INSDC accession handling for the ENA-import workflow.
//
// A TS mirror of qiita-common/src/qiita_common/ena_accession.py so the UI rejects
// a bad accession with the same message the CLI/route would, BEFORE any POST — the
// route 422s the WHOLE batch on a single malformed accession, so catching it here
// turns a lost submission into inline feedback. The prefix sets are exactly the
// Python side's; keep the two in step if miint's ENAParser grows a prefix.

export const STUDY_PREFIXES = ['PRJNA', 'PRJEB', 'PRJDB', 'ERP', 'SRP', 'DRP'] as const;

// Mirrors ena_accession.py's `_ACCESSION_PATTERNS` — prefix + digits, full-match
// like the server (sample accessions may carry one letter); a looser check would
// pass an accession the batch route then 422s.
const KIND_PATTERNS: Record<string, RegExp> = {
  study: new RegExp(`^(?:${STUDY_PREFIXES.join('|')})[0-9]+$`),
  sample: /^(?:SAMN|SAME|SAMD)[A-Z]?[0-9]+$/,
  run: /^(?:SRR|ERR|DRR)[0-9]+$/,
  experiment: /^(?:SRX|ERX|DRX)[0-9]+$/
};

function detectKind(accession: string): string | null {
  const c = accession.trim();
  if (!c) return null;
  for (const [kind, pattern] of Object.entries(KIND_PATTERNS)) if (pattern.test(c)) return kind;
  return null;
}

/** `null` if `accession` is a well-formed INSDC *study* accession, else a message
 *  naming why — including a well-formed accession of the wrong kind. */
export function studyAccessionError(accession: string): string | null {
  const c = accession.trim();
  if (!c) return 'empty accession';
  const kind = detectKind(c);
  if (kind === null)
    return `'${accession}' is not a known INSDC accession (study expects a ${STUDY_PREFIXES.join('/')} prefix followed by digits, e.g. PRJEB11419)`;
  if (kind !== 'study')
    return `'${accession}' is a ${kind} accession, not a study accession (expected ${STUDY_PREFIXES.join('/')})`;
  return null;
}

export type ParsedAccessions = { accessions: string[]; errors: string[] };

/** Parse accessions, one per line (the CLI's `--from-file` contract): blanks and
 *  whole-line `#` comments skipped; a line with a comment/comma/extra token is
 *  refused by line number; survivors are validated and de-duplicated. */
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

// Badge colours, same palette as tickets.ts STATE_CLASS.
export const BATCH_STATE_CLASS: Record<string, string> = {
  pending: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  resolving: 'bg-blue-50 text-blue-700 ring-blue-600/20',
  registered: 'bg-blue-50 text-blue-700 ring-blue-600/20',
  downloading: 'bg-blue-50 text-blue-700 ring-blue-600/20',
  done: 'bg-green-50 text-green-700 ring-green-600/20',
  failed: 'bg-red-50 text-red-700 ring-red-600/10'
};

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
