// Shared presentation helpers for work tickets (used by the list + detail views).
import type { ScopeTarget, WorkTicketState } from './api';

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
