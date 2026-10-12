// Shared presentation helpers for work tickets (used by the list + detail views).
import type { ScopeTarget, WorkTicket, WorkTicketState } from './api';

/** The action's scope target, one-lined off its idx fields. */
export function scopeLabel(t: ScopeTarget): string {
  switch (t.kind) {
    case 'study_prep':
      return `study ${t.study_idx} · prep ${t.prep_idx}`;
    case 'reference':
      return `reference ${t.reference_idx}`;
    case 'prep_sample':
      return `prep_sample ${t.prep_sample_idx}`;
    case 'sequenced_pool':
      return `pool ${t.sequenced_pool_idx} · run ${t.sequencing_run_idx}`;
    case 'block':
      return `block ${t.block_idx}`;
    default:
      return JSON.stringify(t);
  }
}

/**
 * The public accession a ticket is about, when its action context names one —
 * e.g. a `download-ena-study` ticket's `ena_study_accession` — so a list row can
 * say "PRJEB12345" instead of only the pool/run idxs it was scoped to.
 */
export function ticketSubject(
  t: WorkTicket,
  referenceName: (idx: number) => string | null = () => null
): string | null {
  const acc = t.action_context?.ena_study_accession;
  if (typeof acc === 'string' && acc) return acc;
  // A profile is about the database it was run against.
  const db = t.action_context?.sylph_reference_idx;
  if (typeof db === 'number') return `sylph · ${referenceName(db) ?? `reference ${db}`}`;
  return null;
}

// Lifecycle → badge colors. The three terminal outcomes read distinctly
// (completed green, failed red, cancelled/no_data gray); live states amber/blue.
export const STATE_CLASS: Record<WorkTicketState, string> = {
  completed: 'bg-green-50 text-green-700 ring-green-600/20',
  processing: 'bg-blue-50 text-blue-700 ring-blue-600/20',
  queued: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  pending: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  failed: 'bg-red-50 text-red-700 ring-red-600/10',
  no_data: 'bg-gray-50 text-gray-600 ring-gray-500/10',
  cancelled: 'bg-gray-50 text-gray-600 ring-gray-500/10'
};

/** Local-time string, tolerant of a bad/absent timestamp. */
export function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** An action's name for people; the id when it has none here. */
const ACTION_LABEL: Record<string, string> = {
  'taxonomic-profile': 'Taxonomic profile',
  amplicon: 'Amplicon ASVs',
  'golay-demux': 'Golay demultiplex',
  'bcl-convert': 'BCL convert',
  'download-ena-study': 'ENA download',
  'fastq-to-parquet': 'FASTQ import',
  'read-mask': 'Read mask',
  'read-mask-block': 'Read mask (block)',
  align: 'Align',
  'align-denovo': 'Align to assembly',
  'long-read-assembly': 'Long-read assembly',
  'reference-add': 'Add reference',
  'host-reference-add': 'Add host reference'
};
export const actionLabel = (id: string) => ACTION_LABEL[id] ?? id;

/** How one action-context entry reads: a label, and a value that is text, a
 *  reference to resolve, a link, or a list/object to show folded. */
export type ContextField =
  | { key: string; label: string; kind: 'text'; text: string }
  | { key: string; label: string; kind: 'reference'; referenceIdx: number }
  | { key: string; label: string; kind: 'link'; text: string; href: string }
  | { key: string; label: string; kind: 'rows'; rows: Record<string, unknown>[] }
  | { key: string; label: string; kind: 'json'; value: unknown };

// Labels for keys whose name doesn't say it plainly.
const CONTEXT_LABEL: Record<string, string> = {
  sylph_reference_idx: 'Database',
  sortmerna_reference_idx: 'rRNA reference',
  trim: 'Trim length',
  min_ani: 'Min ANI',
  barcode_map: 'Barcodes',
  amplicon: 'Amplicon pool',
  ena_study_accession: 'ENA study'
};

const humanKey = (k: string) => {
  const s = k.replace(/_idx$/, '').replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** The action context as labelled fields, in the order the server sent them. */
export function contextFields(ctx: Record<string, unknown>): ContextField[] {
  return Object.entries(ctx).map(([key, v]): ContextField => {
    const label = CONTEXT_LABEL[key] ?? humanKey(key);
    if (key.endsWith('_reference_idx') && typeof v === 'number')
      return { key, label, kind: 'reference', referenceIdx: v };
    if (key.endsWith('_accession') && typeof v === 'string' && /^[A-Z]{3,5}\d+$/.test(v))
      return { key, label, kind: 'link', text: v, href: `https://www.ebi.ac.uk/ena/browser/view/${v}` };
    if (typeof v === 'boolean') return { key, label, kind: 'text', text: v ? 'Yes' : 'No' };
    if (typeof v === 'number') return { key, label, kind: 'text', text: v.toLocaleString() };
    if (typeof v === 'string') return { key, label, kind: 'text', text: v };
    if (v === null) return { key, label, kind: 'text', text: '—' };
    if (Array.isArray(v) && v.every((x) => typeof x === 'string' || typeof x === 'number'))
      return { key, label, kind: 'text', text: v.join(', ') };
    if (Array.isArray(v) && v.length && v.every((x) => x && typeof x === 'object' && !Array.isArray(x)))
      return { key, label, kind: 'rows', rows: v as Record<string, unknown>[] };
    return { key, label, kind: 'json', value: v };
  });
}

/** One step-log line, classified for display. A job's structured outcome line
 *  (`{"kind": "no_data", ...}`) becomes an outcome; level words colour the rest. */
export type LogLine =
  | { kind: 'outcome'; text: string; outcome: string; step?: string; reason: string }
  | { kind: 'line'; text: string; level: 'error' | 'warning' | 'info' };

export function classifyLog(text: string): LogLine[] {
  return text.split('\n').map((line): LogLine => {
    const t = line.trim();
    if (t.startsWith('{') && t.endsWith('}')) {
      try {
        const o = JSON.parse(t) as Record<string, unknown>;
        if (typeof o.kind === 'string' && typeof o.reason === 'string')
          return {
            kind: 'outcome',
            text: line,
            outcome: o.kind,
            step: typeof o.step_name === 'string' ? o.step_name : undefined,
            reason: o.reason
          };
      } catch {
        // Not JSON after all: an ordinary line.
      }
    }
    const level = /\b(ERROR|CRITICAL|Traceback|Error:|error:|Exception)\b/.test(line)
      ? 'error'
      : /\bWARN(ING)?\b/.test(line)
        ? 'warning'
        : 'info';
    return { kind: 'line', text: line, level };
  });
}

/** "3m 12s" between two timestamps; '' when either is unreadable. */
export function duration(fromIso: string, toIso: string): string {
  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}
