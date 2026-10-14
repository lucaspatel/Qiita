// Thin typed client over the control-plane REST API.
//
// KEYSTONE (not yet wired): run `npm run gen:api` to generate
// `src/lib/api/schema.d.ts` from the live `/openapi.json`, then swap this
// hand-typed surface for `openapi-fetch` + those types so the UI can never
// drift from the API. For the POC we hand-type the three read endpoints a
// viewer can actually reach; everything goes through `get()` so the swap is
// mechanical.
import { auth } from './auth.svelte';

import { apiBase as BASE, cpOrigin as CP_ORIGIN } from './environment';


/**
 * Browser login via AuthRocket, reusing the CLI loopback flow: this SPA plays
 * the role of the CLI's local listener. Full-page nav to the CP's /auth/login
 * with cli=1&port=<our port>; after AuthRocket, /auth/handoff redirects the
 * browser back to http://127.0.0.1:<port>/?ot_code=<code>, which handleLoginReturn
 * redeems. Open the app at http://127.0.0.1:<port> so the origin matches the loopback.
 */
export function beginLogin(): void {
  const host = location.hostname;
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (isLocal) {
    // Seamless: the CP loops the one-time code back to 127.0.0.1:<port>, which
    // this SPA redeems on return.
    const port = location.port || '5173';
    location.href = `${CP_ORIGIN}/api/v1/auth/login?cli=1&port=${port}`;
  } else {
    // LAN/remote viewer: the CP's CLI loopback only ever targets 127.0.0.1, so it
    // can't return here. Use the browser login flow, which authenticates via
    // AuthRocket and then shows a PAT to copy into the "PAT" box.
    window.open(`${CP_ORIGIN}/api/v1/auth/login`, '_blank', 'noopener');
  }
}

/** True when the seamless loopback login can return to this origin. */
export function loginIsSeamless(): boolean {
  const h = location.hostname;
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

export type Ok<T> = { ok: true; status: number; data: T };
export type Err = { ok: false; status: number; detail: string };
export type ApiResult<T> = Ok<T> | Err;

// fetch has no default timeout; cap every request so a dead backend fails fast.
const REQUEST_TIMEOUT_MS = 10_000;

function networkErr(e: unknown): Err {
  const timedOut = e instanceof DOMException && e.name === 'TimeoutError';
  return {
    ok: false,
    status: 0,
    detail: timedOut
      ? `request timed out after ${REQUEST_TIMEOUT_MS / 1000}s — backend unreachable?`
      : `network error: ${String(e)}`
  };
}

async function send<T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: {
        ...(auth.isSet ? { Authorization: `Bearer ${auth.token}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (e) {
    return networkErr(e);
  }
  if (res.status === 204) return { ok: true, status: 204, data: undefined as T };
  const b: unknown = await res.json().catch(() => ({}));
  if (res.ok) return { ok: true, status: res.status, data: b as T };
  const detail =
    b && typeof b === 'object' && 'detail' in b ? String((b as { detail: unknown }).detail) : res.statusText;
  return { ok: false, status: res.status, detail };
}

async function get<T>(path: string): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      headers: auth.isSet ? { Authorization: `Bearer ${auth.token}` } : {},
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (e) {
    return networkErr(e);
  }
  const body: unknown = await res.json().catch(() => ({}));
  if (res.ok) return { ok: true, status: res.status, data: body as T };
  const detail =
    body && typeof body === 'object' && 'detail' in body
      ? String((body as { detail: unknown }).detail)
      : res.statusText;
  return { ok: false, status: res.status, detail };
}

/** A POST whose response body is binary (an Arrow IPC stream), not JSON. */
async function postArrow(path: string, body: unknown, timeoutMs = 60_000): Promise<ApiResult<ArrayBuffer>> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method: 'POST',
      headers: {
        ...(auth.isSet ? { Authorization: `Bearer ${auth.token}` } : {}),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (e) {
    return networkErr(e);
  }
  if (res.ok) return { ok: true, status: res.status, data: await res.arrayBuffer() };
  const b: unknown = await res.json().catch(() => ({}));
  const detail =
    b && typeof b === 'object' && 'detail' in b ? String((b as { detail: unknown }).detail) : res.statusText;
  return { ok: false, status: res.status, detail };
}

/** Which runs (amplicon runs or taxonomic profiles, all of one method), over which
 *  samples (exactly one of study_idx / prep_sample_idx). */
export type FeatureTableRequest = {
  processing_idx: number[];
  study_idx?: number;
  prep_sample_idx?: number[];
  /** A read-time filter: `greengenes2` keeps the ASVs Greengenes2 places. */
  feature_filter?: 'greengenes2';
};

/** What a table's values are: reads counted per feature, or a percent of the sample. */
export type FeatureTableValueKind = 'count' | 'relative_abundance';

/** One column of a run feature table: a processed sample. */
export type FeatureTableSample = {
  /** The column name: the biosample's deposited accession, else the QM. */
  sample: string;
  export_id: string;
  /** The biosample's public name (accession, else QB): the metadata join key. */
  biosample: string;
  processing_idx: number;
};

export type FeatureTableSamples = {
  /** The runs' method (`amplicon`, `taxonomic-profile`). */
  method: string;
  value_kind: FeatureTableValueKind;
  samples: FeatureTableSample[];
};

export type Whoami = {
  kind: string;
  principal_idx: number;
  email: string;
  system_role: string;
  scopes: string[];
  profile_complete: boolean;
};

export type IdxList = { idxs: number[]; truncated?: boolean };

export type Reference = {
  reference_idx: number;
  name: string;
  version: string;
  kind: string;
  status: string;
  is_host: boolean;
  created_by_idx: number;
  created_at: string;
};

export type ReferenceIndex = {
  reference_index_idx: number;
  reference_idx: number;
  index_type: string;
  fs_path: string;
  params: Record<string, unknown>;
  created_at: string;
  shard_id: number | null;
};

export type ReferenceExclusion = {
  feature_idx: number;
  genome_idx: number | null;
  reason: string | null;
  source: string | null;
  source_id: string | null;
  accession: string | null;
  direct_block: boolean;
  via_genome: boolean;
  excluded_at: string | null;
};

export type PrepProtocol = {
  prep_protocol_idx: number;
  name: string;
  description: string | null;
  retired: boolean;
};

export type MetaField = {
  display_name: string;
  description: string | null;
  data_type: string;
  value: unknown; // scalar, or { kind: 'missing_reason', ... } for absent values
};

export type Biosample = {
  biosample_idx: number;
  biosample_accession: string | null;
  ena_sample_accession: string | null;
  /** Qiita's public biosample handle (QB<n>), minted when the biosample is created. */
  export_entity_id: string;
  metadata_checklist: { idx: number; name: string } | null;
  global_metadata: Record<string, MetaField>;
  /** The study's own fields (every column a global field does not take). */
  local_metadata: Record<string, MetaField>;
  retired: boolean;
};

/** Redeem the one-time ot_code from the loopback for the PAT plaintext. */
export async function cliExchange(otCode: string): Promise<ApiResult<{ token: string }>> {
  let res: Response;
  try {
    res = await fetch(BASE + '/auth/cli-exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ot_code: otCode }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (e) {
    return networkErr(e);
  }
  const body: unknown = await res.json().catch(() => ({}));
  if (res.ok) return { ok: true, status: res.status, data: body as { token: string } };
  const detail =
    body && typeof body === 'object' && 'detail' in body
      ? String((body as { detail: unknown }).detail)
      : res.statusText;
  return { ok: false, status: res.status, detail };
}

export type UserProfile = {
  principal_idx: number;
  display_name: string;
  email: string;
  affiliation: string;
  address: string;
  phone: string;
  orcid: string | null;
  receive_processing_emails: boolean;
  profile_complete: boolean;
  created_at: string;
  updated_at: string;
};

export type UserUpdate = {
  affiliation?: string;
  address?: string;
  phone?: string;
  orcid?: string | null;
  receive_processing_emails?: boolean;
};

export type ApiToken = {
  token_idx: number;
  label: string;
  scopes: string[];
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
};

// A work ticket's scope target — the resource the action is about. Discriminated
// on `kind`; render generically off the idx fields.
export type ScopeTarget =
  | { kind: 'study_prep'; study_idx: number; prep_idx: number }
  | { kind: 'reference'; reference_idx: number }
  | { kind: 'prep_sample'; prep_sample_idx: number }
  | { kind: 'sequenced_pool'; sequenced_pool_idx: number; sequencing_run_idx: number }
  | { kind: 'block'; block_idx: number };

export type WorkTicketState =
  | 'pending'
  | 'queued'
  | 'processing'
  | 'completed'
  | 'no_data'
  | 'failed'
  | 'cancelled';

export type WorkTicket = {
  work_ticket_idx: number;
  action_id: string;
  action_version: string;
  originator_principal_idx: number;
  scope_target: ScopeTarget;
  shard_id: number | null;
  mask_idx: number | null;
  action_context: Record<string, unknown>;
  state: WorkTicketState;
  retry_count: number;
  max_retries: number;
  failure_type: 'retriable' | 'permanent' | null;
  failure_stage: 'submission' | 'step_run' | 'finalize' | null;
  failure_step_name: string | null;
  failure_reason: string | null;
  transient_reason: string | null;
  transient_since: string | null;
  created_at: string;
  updated_at: string;
};

/** A ticket plus a snapshot of its current step's compute placement (list view). */
export type WorkTicketSummary = WorkTicket & {
  current_step_index: number | null;
  current_step_name: string | null;
  compute_target: 'slurm' | 'local' | 'control_plane' | null;
  slurm_job_id: number | null;
  step_state: 'submitting' | 'submitted' | 'running' | 'completed' | 'failed' | null;
  read_outcome: Record<string, unknown> | null;
};

export type WorkTicketListResponse = {
  tickets: WorkTicketSummary[];
  count: number;
  truncated: boolean;
};

export type WorkTicketStepLogs = {
  work_ticket_idx: number;
  step_index: number;
  attempt: number;
  step_name: string;
  stdout: string;
  stderr: string;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
};

export type StudyAccessionField = 'bioproject_accession' | 'ena_study_accession';

export type Tier = 'public' | 'viewer' | 'member' | 'admin';

/** One row of GET /study — a study the caller may read, and why. */
export type StudySummary = {
  study_idx: number;
  title: string;
  alias: string | null;
  bioproject_accession: string | null;
  ena_study_accession: string | null;
  default_tier: Tier;
  caller_tier: Tier;
  access_via: 'owner' | 'grant' | 'public' | 'role';
  updated_at: string;
};

export type StudySummaryList = { studies: StudySummary[]; next_after_study_idx: number | null };

/** Response of POST /study/lookup-by-accession: accession → study_idx + unresolved. */
export type StudyLookupResponse = {
  resolved: Record<string, number>;
  missing: string[];
};

export type AccessTier = 'public' | 'viewer' | 'member' | 'admin';

/** One row of a study's access list (GET /study/{idx}/access). */
export type StudyAccessRow = {
  study_idx: number;
  principal_idx: number;
  email: string | null;
  access_tier: AccessTier;
  granted_by_idx: number | null;
  granted_at: string;
};

// --- Study create + bulk biosample import (the wetlab front door) ---
export type StudyCreate = {
  title: string;
  alias?: string | null;
  description?: string | null;
  bioproject_accession?: string | null;
  ena_study_accession?: string | null;
};

/** One biosample row for the bulk importer — mirrors BiosampleImportRequest. */
export type BiosampleRow = {
  owner_idx: number;
  owner_biosample_id_field_name: string;
  owner_biosample_id_value: string;
  metadata?: Record<string, string>;
  matrix_tube_id?: string | null;
  metadata_checklist_name?: string | null;
};

/** A study's biosample field (GET /study/{idx}/biosample-field). */
export type BiosampleStudyField = {
  biosample_study_field_idx: number;
  biosample_global_field_idx: number | null;
  display_name: string;
  data_type: string;
  unique_in_study: boolean;
  required: boolean;
  description: string | null;
};

export type BiosampleImported = {
  biosample_idx: number;
  /** The QB<n> minted for the new biosample. */
  export_entity_id: string;
  owner_id_biosample_study_field_idx: number;
  owner_id_biosample_study_field_created: boolean;
};

export type BulkImportResult = { results: BiosampleImported[] };

export type Deployment = { name: string | null };

// A sequenced pool a study's samples sit in (GET /study/{idx}/sequenced-pool).
export type StudySequencedPool = {
  sequenced_pool_idx: number;
  sequencing_run_idx: number;
  run_preflight_filename: string | null;
  instrument_model: string | null;
  sample_count: number;
  created_at: string;
};
export type StudySequencedPoolList = {
  study_idx: number;
  sequenced_pool: StudySequencedPool[];
  count: number;
  truncated: boolean;
};

// --- long-read lineage inputs (GET /processing, /mask-definition, /assembly/.../membership) ---

/** One processing RUN — identity = hash of {workflow, version, params}. For
 *  long-read-assembly, params carries mask_idx + assembler (the lineage link). */
export type Processing = {
  processing_idx: number;
  workflow: string;
  version: string;
  params: Record<string, unknown>; // { mask_idx, assembler, ... }
  status: string;
};
export type ProcessingList = { processing: Processing[]; count: number; truncated: boolean };

/** A read-mask identity (host-filter / lima / syndna config). */
export type MaskDefinition = {
  mask_idx: number;
  host_filter_enabled: boolean;
  lima_enabled: boolean;
  syndna_enabled: boolean;
};

/** One contig of an assembly run, tagged by kind/bin. completeness/contamination
 *  are CheckM (MAGs only) — mocked in the shim; real data is Flight-only. */
export type AssemblyMembershipRow = {
  kind: 'MAG' | 'LCG' | 'UNBINNED';
  bin_id: string | null;
  feature_idx: number;
  completeness: number | null;
  contamination: number | null;
};
export type AssemblyMembership = {
  prep_sample_idx: number;
  processing_idx: number;
  membership: AssemblyMembershipRow[];
  count: number;
  truncated: boolean;
};

// Study lineage (`GET /study/{idx}/lineage`): every sample's provenance, one DAG
// per prep protocol, laid out client-side. A stage node counts every sample of
// its group ('not_started' where it has no record); a product node counts only
// the samples it contains.
export type LineageState =
  | 'completed'
  | 'no_data'
  | 'pending'
  | 'processing'
  | 'failed'
  | 'invalidated'
  | 'not_started';
export type LineageNode = {
  id: string;
  kind: 'run' | 'reads' | 'mask' | 'processing' | 'product';
  /** What the node is ("Reads", "ASVs"); `detail` is what produced it. */
  label: string;
  detail: string | null;
  action_id: string | null;
  processing_idx: number | null;
  mask_idx: number | null;
  counts: Partial<Record<LineageState, number>>;
  /** What a sample's `value` at this node measures (e.g. "ASVs"). */
  value_label: string | null;
};
export type LineageEdge = { source: string; target: string };
export type LineageCell = { state: LineageState; value: number | null };
export type LineageSample = {
  prep_sample_idx: number;
  /** For fetching the sample's metadata; never displayed. */
  biosample_idx: number;
  /** The biosample's accession where it has one, else its QB. */
  label: string;
  label_source: 'biosample_accession' | 'ena_sample_accession' | 'export_entity_id';
  sequencing_run_idx: number | null;
  sequenced_pool_idx: number | null;
  /** node id -> state there; a node absent here is 'not_started'. */
  cells: Record<string, LineageCell>;
};
export type LineageGroup = {
  prep_protocol: string;
  nodes: LineageNode[];
  edges: LineageEdge[];
  samples: LineageSample[];
};
export type StudyLineage = { study_idx: number; groups: LineageGroup[] };

// --- ENA/INSDC study import (admin-only; a batch driver that spawns download tickets) ---

// Per-item lifecycle; `done` is computed on read (never stored), and one bad
// accession fails only its own item.
export type BatchItemState =
  | 'pending'
  | 'resolving'
  | 'registered'
  | 'downloading'
  | 'done'
  | 'failed';

export type EnaRunOutcome = {
  run_accession: string;
  // registered | skipped_already_present | excluded | flagged_unavailable |
  // held_not_downloaded | failed
  status: string;
  failure_reason: string | null;
};

export type EnaImportItem = {
  ena_study_accession: string;
  state: BatchItemState;
  study_idx: number | null; // set once registered
  failure_reason: string | null;
  download_work_ticket_idxs: number[];
  ena_runs: EnaRunOutcome[];
};

export type EnaImportBatch = {
  ena_import_batch_idx: number;
  items: EnaImportItem[];
};

export const api = {
  whoami: () => get<Whoami>('/auth/whoami'),
  /** The control plane's self-reported deployment name; unauthenticated. */
  deployment: () => get<Deployment>('/deployment'),
  getProfile: () => get<UserProfile>('/user/me'),
  updateProfile: (body: UserUpdate) => send<UserProfile>('PATCH', '/user/me', body),
  listTokens: () => get<ApiToken[]>('/auth/token'),
  revokeToken: (idx: number) => send<void>('DELETE', `/auth/token/${idx}`),
  /** Loaded reference databases + artifact sequence sets. Needs reference:read. */
  references: () => get<Reference[]>('/reference'),
  reference: (idx: number) => get<Reference>(`/reference/${idx}`),
  referenceIndices: (idx: number) => get<ReferenceIndex[]>(`/reference/${idx}/index`),
  referenceExclusions: (idx: number) => get<ReferenceExclusion[]>(`/reference/${idx}/exclusion`),
  referenceGenomeMap: (idx: number) =>
    get<{ reference_idx: number; entries: unknown[]; count?: number }>(`/reference/${idx}/genome-map`),
  /** Library-prep protocols (config catalog). */
  prepProtocols: () => get<PrepProtocol[]>('/prep-protocol'),
  /** The study record (title/owner/accessions). Needs tier >= member. */
  studyRecord: (studyIdx: number) => get<Record<string, unknown>>(`/study/${studyIdx}`),
  /** Create a study. Needs study:write + a complete profile. */
  createStudy: (body: StudyCreate) => send<Record<string, unknown>>('POST', '/study', body),
  /** The study's biosample fields, global-linked and local. */
  biosampleFields: (studyIdx: number) => get<BiosampleStudyField[]>(`/study/${studyIdx}/biosample-field`),
  /** Bulk-import a plate's biosamples in one all-or-nothing call. Needs ADMIN on the study. */
  bulkImportBiosamples: (studyIdx: number, rows: BiosampleRow[]) =>
    send<BulkImportResult>('POST', `/study/${studyIdx}/biosample/bulk`, { rows }),
  /** Resolve study accession(s) → study_idx. Needs study:read scope. */
  /** Studies the caller may read, newest first (405 on a server that predates the route). */
  studies: (q: { q?: string; min_tier?: Tier; after_study_idx?: number; limit?: number } = {}) => {
    const p = new URLSearchParams();
    if (q.q) p.set('q', q.q);
    if (q.min_tier) p.set('min_tier', q.min_tier);
    if (q.after_study_idx) p.set('after_study_idx', String(q.after_study_idx));
    if (q.limit) p.set('limit', String(q.limit));
    const qs = p.toString();
    return get<StudySummaryList>(`/study${qs ? `?${qs}` : ''}`);
  },
  lookupStudyByAccession: (accessions: string[], field: StudyAccessionField = 'bioproject_accession') =>
    send<StudyLookupResponse>('POST', '/study/lookup-by-accession', {
      accessions,
      accession_field: field
    }),
  /** Who can see a study + at what tier. Needs member+ on the study (else 403). */
  studyAccess: (studyIdx: number) => get<StudyAccessRow[]>(`/study/${studyIdx}/access`),
  /** Sample idx set for a study. Needs tier >= viewer. */
  sequencedIdxs: (studyIdx: number) =>
    get<IdxList>(`/study/${studyIdx}/sequenced-sample/list-idxs`),
  /** The distinct sequenced pools a study's samples sit in. Needs tier >= viewer.
   *  404/405 on a server predating the endpoint — treat as "unsupported". */
  studyPools: (studyIdx: number) =>
    get<StudySequencedPoolList>(`/study/${studyIdx}/sequenced-pool`),
  /** Every sample's provenance in the study, one DAG per prep protocol.
   *  404/405 on a server predating the endpoint — treat as "unsupported". */
  studyLineage: (studyIdx: number) => get<StudyLineage>(`/study/${studyIdx}/lineage`),
  /** (mock) Kick off a sample's next processing step; the lineage reflects it on refetch. */
  processSample: (studyIdx: number, prepSampleIdx: number) =>
    send<{ prep_sample_idx: number; state: string }>(
      'POST',
      `/study/${studyIdx}/sample/${prepSampleIdx}/process`,
      {}
    ),
  biosampleIdxs: (studyIdx: number) =>
    get<IdxList>(`/study/${studyIdx}/biosample/list-idxs`),
  /** One biosample incl. its global_metadata values. Readable at viewer tier. */
  biosample: (idx: number) => get<Biosample>(`/biosample/${idx}`),
  /** A run feature table's columns, with its method and value kind. */
  featureTableSamples: (body: FeatureTableRequest) =>
    send<FeatureTableSamples>('POST', '/feature-table/samples', body),
  /** Its values, sparse COO (sample, feature, value), as an Arrow IPC stream. */
  featureTableValues: (body: FeatureTableRequest) => postArrow('/feature-table/values', body),
  /** Its features (feature, sequence, length; sequence null for a profile), as Arrow IPC. */
  featureTableFeatures: (body: FeatureTableRequest) => postArrow('/feature-table/features', body),
  /** A biosample as one study sees it: global fields plus the study's own (local_metadata). */
  studyBiosample: (studyIdx: number, idx: number) =>
    get<Biosample>(`/study/${studyIdx}/biosample/${idx}`),
  /** Your work tickets (own by default; wet_lab_admin+ sees all with all=true). */
  tickets: (
    q: {
      state?: string;
      active?: boolean;
      all?: boolean;
      limit?: number;
      prep_sample_idx?: number;
      sequenced_pool_idx?: number;
    } = {}
  ) => {
    const p = new URLSearchParams();
    if (q.state) p.set('state', q.state);
    if (q.active) p.set('active', 'true');
    if (q.all) p.set('all', 'true');
    if (q.limit) p.set('limit', String(q.limit));
    if (q.prep_sample_idx) p.set('prep_sample_idx', String(q.prep_sample_idx));
    if (q.sequenced_pool_idx) p.set('sequenced_pool_idx', String(q.sequenced_pool_idx));
    const qs = p.toString();
    return get<WorkTicketListResponse>(`/work-ticket${qs ? `?${qs}` : ''}`);
  },
  /** The prep_samples in a pool. Needs tier >= viewer. */
  poolSamples: (run: number, pool: number) =>
    get<IdxList>(`/sequencing-run/${run}/sequenced-pool/${pool}/sequenced-sample/list-idxs`),
  /** Processing runs over a prep_sample (long-read-assembly). */
  processing: (prepSampleIdx: number) =>
    get<ProcessingList>(`/processing?prep_sample_idx=${prepSampleIdx}`),
  /** A read-mask identity by idx. */
  maskDefinition: (idx: number) => get<MaskDefinition>(`/mask-definition/${idx}`),
  /** An assembly run's contigs (by kind/bin) for a prep_sample. */
  assemblyMembership: (prepSampleIdx: number, processingIdx: number) =>
    get<AssemblyMembership>(`/assembly/${prepSampleIdx}/${processingIdx}/membership`),
  ticket: (idx: number) => get<WorkTicket>(`/work-ticket/${idx}`),
  ticketLogs: (idx: number, step: number, opts: { attempt?: number; tailLines?: number } = {}) => {
    const p = new URLSearchParams();
    if (opts.attempt != null) p.set('attempt', String(opts.attempt));
    if (opts.tailLines != null) p.set('tail_lines', String(opts.tailLines));
    const qs = p.toString();
    return get<WorkTicketStepLogs>(`/work-ticket/${idx}/step/${step}/logs${qs ? `?${qs}` : ''}`);
  },
  /** Restart a FAILED ticket in place (202); 409 when it isn't redrivable. */
  runWorkTicket: (idx: number) =>
    send<{ work_ticket_idx: number; state: WorkTicketState }>('POST', `/work-ticket/${idx}/run`),
  /** Submit a single workflow → mints a work ticket (202) or errors (4xx) immediately. */
  submitWorkTicket: (body: WorkTicketCreateRequest) =>
    send<{ work_ticket_idx: number; state: WorkTicketState }>('POST', '/work-ticket', body),
  /** Bundled "Amplicon run": upload a preflight + run id; the server provisions
   *  from the preflight and chains golay-demux → amplicon. (Needs a server-side
   *  preflight-ingest endpoint; demoed against the shim today.) */
  submitAmpliconRun: (body: AmpliconRunRequest) =>
    send<{ tickets: { work_ticket_idx: number; action_id: string; state: string }[] }>(
      'POST',
      '/amplicon-run',
      body
    ),
  /** Submit a batch INSDC/ENA study import (wet_lab_admin+). 202 with the batch
   *  handle and one `pending` item per accession. */
  submitEnaImport: (accessions: string[]) =>
    send<EnaImportBatch>('POST', '/ena-import-batch', { accessions }),
  /** Read a batch's current per-item state. There is no list endpoint — poll this
   *  (Refresh) by the idx submit handed back. */
  enaImportStatus: (idx: number) => get<EnaImportBatch>(`/ena-import-batch/${idx}`)
};

/** Bundled amplicon-run submit (run id + base64 preflight + knobs). */
export type AmpliconRunRequest = {
  instrument_run_id: string;
  run_preflight_blob: string; // base64
  prep_protocol_idx: number;
  sortmerna_reference_idx: number;
  trim: number;
};

/** Body for POST /work-ticket — mirrors WorkTicketCreateRequest. */
export type WorkTicketCreateRequest = {
  action_id: string;
  action_version: string;
  scope_target: ScopeTarget;
  action_context?: Record<string, unknown>;
  force?: boolean;
};
