// Reconstructs a prep_sample's long-read processing DAG from existing REST reads.
// There is NO stored lineage/edge table — edges are DERIVED here exactly as a real
// client would: processing run → its params.mask_idx → the read-mask → the reads,
// and the run's membership → the MAG/LCG/unbinned contig classes → the feature table.
import { api, type WorkTicketSummary } from './api';

export type LineageStatus =
  | 'completed'
  | 'processing'
  | 'queued'
  | 'pending'
  | 'failed'
  | 'no_data';

export type LineageStep = { name: string; status: LineageStatus };

export type LineageNode = {
  id: string;
  kind: 'reads' | 'mask' | 'assembly' | 'mag' | 'lcg' | 'unbinned' | 'features';
  label: string;
  status: LineageStatus;
  detail?: string;
  steps?: LineageStep[]; // assembly only — its internal step chain
};

export type LineageEdge = { from: string; to: string };

export type LineageGraph = {
  prepSampleIdx: number;
  nodes: LineageNode[];
  edges: LineageEdge[];
};

export type LineageResult =
  | { ok: true; graph: LineageGraph }
  | { ok: false; unsupported: boolean; error: string };

// long-read-assembly's internal step chain (linear), for the expandable node.
export const ASSEMBLY_STEPS = [
  'assembly_run_config',
  'assemble',
  'assembly_coverage',
  'binning',
  'bin_refine',
  'checkm',
  'assembly_hash',
  'mint-features',
  'write-assembly-membership',
  'assembly_load',
  'register-files',
  'finalize-assembly-sample'
];

/** Normalize a work-ticket or step state to a lineage status. */
function norm(state: string | null | undefined): LineageStatus {
  switch (state) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'no_data':
      return 'no_data';
    case 'pending':
      return 'pending';
    case 'queued':
      return 'queued';
    case 'processing':
    case 'running':
    case 'submitting':
    case 'submitted':
      return 'processing';
    case 'cancelled':
      return 'no_data';
    default:
      return 'pending';
  }
}

/** Per-step statuses from the ticket's overall state + current/failed step. */
function stepStatuses(ticket: WorkTicketSummary | undefined): LineageStep[] {
  const overall = norm(ticket?.state);
  const marker = ticket?.failure_step_name ?? ticket?.current_step_name ?? null;
  const at = marker ? ASSEMBLY_STEPS.indexOf(marker) : -1;
  return ASSEMBLY_STEPS.map((name, i) => {
    if (overall === 'completed') return { name, status: 'completed' as LineageStatus };
    if (overall === 'no_data') return { name, status: 'no_data' as LineageStatus };
    if (at < 0) return { name, status: 'pending' as LineageStatus };
    if (i < at) return { name, status: 'completed' as LineageStatus };
    if (i === at) return { name, status: overall === 'failed' ? 'failed' : norm(ticket?.step_state) };
    return { name, status: 'pending' as LineageStatus };
  });
}

/** Leaf-node status: contigs exist only once the assembly completes. */
function leafStatus(assembly: LineageStatus): LineageStatus {
  if (assembly === 'completed') return 'completed';
  if (assembly === 'failed' || assembly === 'no_data') return 'no_data';
  return 'pending';
}

export async function buildLineage(prepSampleIdx: number): Promise<LineageResult> {
  const pr = await api.processing(prepSampleIdx);
  if (!pr.ok)
    return { ok: false, unsupported: pr.status === 404 || pr.status === 405, error: `HTTP ${pr.status} — ${pr.detail}` };

  const run = pr.data.processing[0];
  const nodes: LineageNode[] = [
    { id: 'reads', kind: 'reads', label: 'Reads', status: 'completed', detail: 'DuckLake read table' }
  ];
  const edges: LineageEdge[] = [];

  if (!run) {
    return { ok: true, graph: { prepSampleIdx, nodes, edges } };
  }

  // Edge glue: the run's params name the mask it was assembled from.
  const maskIdx = Number(run.params?.mask_idx);
  const assembler = String(run.params?.assembler ?? '—');

  // The assembly ticket drives the assembly node + step statuses.
  const tk = await api.tickets({ prep_sample_idx: prepSampleIdx });
  const ticket = tk.ok ? tk.data.tickets[0] : undefined;
  const assemblyStatus = ticket ? norm(ticket.state) : norm(run.status);

  // Mask node (optional detail from its config).
  if (Number.isFinite(maskIdx)) {
    const md = await api.maskDefinition(maskIdx);
    const cfg = md.ok
      ? [md.data.host_filter_enabled && 'host-filter', md.data.lima_enabled && 'lima', md.data.syndna_enabled && 'synDNA']
          .filter(Boolean)
          .join(' · ')
      : '';
    nodes.push({
      id: 'mask',
      kind: 'mask',
      label: 'Read mask',
      status: 'completed',
      detail: `#${maskIdx}${cfg ? ` · ${cfg}` : ''}`
    });
    edges.push({ from: 'reads', to: 'mask' });
  }
  const assemblyParent = Number.isFinite(maskIdx) ? 'mask' : 'reads';

  // Assembly node (expandable to its 11 steps).
  nodes.push({
    id: 'assembly',
    kind: 'assembly',
    label: `${run.workflow} ${run.version}`,
    status: assemblyStatus,
    detail: `${assembler} · processing #${run.processing_idx}`,
    steps: stepStatuses(ticket)
  });
  edges.push({ from: assemblyParent, to: 'assembly' });

  // Contig classes (counts from membership once the run completed).
  const mem = await api.assemblyMembership(prepSampleIdx, run.processing_idx);
  const rows = mem.ok ? mem.data.membership : [];
  const countOf = (kind: string) => rows.filter((r) => r.kind === kind).length;
  const leaf = leafStatus(assemblyStatus);
  const classes: { id: 'mag' | 'lcg' | 'unbinned'; label: string; kind: string }[] = [
    { id: 'mag', label: 'MAGs', kind: 'MAG' },
    { id: 'lcg', label: 'LCGs', kind: 'LCG' },
    { id: 'unbinned', label: 'Unbinned', kind: 'UNBINNED' }
  ];
  for (const c of classes) {
    const n = countOf(c.kind);
    nodes.push({
      id: c.id,
      kind: c.id,
      label: c.label,
      status: leaf,
      detail: leaf === 'completed' ? `${n} contig${n === 1 ? '' : 's'}` : undefined
    });
    edges.push({ from: 'assembly', to: c.id });
    edges.push({ from: c.id, to: 'features' });
  }

  // Feature table (the shared feature space the contigs minted into).
  nodes.push({
    id: 'features',
    kind: 'features',
    label: 'Feature table',
    status: leaf,
    detail: leaf === 'completed' ? `${rows.length} features` : undefined
  });

  return { ok: true, graph: { prepSampleIdx, nodes, edges } };
}
