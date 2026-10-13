<script lang="ts">
  // The study's processing lineage: one DAG per prep protocol, straight from
  // `GET /study/{idx}/lineage`. The server sends nodes, edges and every sample's
  // state at each node; this only lays the graph out (columns by depth from the
  // roots) and lists a clicked node's samples.
  import {
    api,
    type LineageGroup,
    type LineageNode,
    type LineageState,
    type StudyLineage
  } from '$lib/api';
  import Card from './Card.svelte';
  import DataTable from './DataTable.svelte';
  import { untrack } from 'svelte';
  import { labelHeader } from '$lib/samples';
  import ValueScatter from './ValueScatter.svelte';
  import PcoaPlot from './PcoaPlot.svelte';
  import Spinner from './Spinner.svelte';
  import { pyworker, type Pcoa, type Permanova } from '$lib/pyodide/pyodide.svelte';
  import FeatureTableGrid from './FeatureTableGrid.svelte';
  import Select from './Select.svelte';
  import { workflowsFor } from '$lib/nodeWorkflows';
  import { loadFeatureTable, type FeatureTable } from '$lib/featureTable';
  import ColorPanel from './ColorPanel.svelte';
  import { colorBy, fieldValue, natural, shapeBy } from '$lib/colorBy';
  import { metadataFields } from '$lib/samples';
  import type { MetaField } from '$lib/api';
  import { studyMetadata } from '$lib/studyMetadata.svelte';
  import { loadPlotPrefs, savePlotPrefs } from '$lib/plotPrefs';

  let { studyIdx }: { studyIdx: number } = $props();

  let data = $state<StudyLineage | null>(null);
  let loading = $state(false);
  let error = $state('');
  let unsupported = $state(false);
  // Selected node per group (keyed by prep protocol).
  let selected = $state<Record<string, string | null>>({});
  // The open "Run workflow" launcher per group: the node it runs from, and the
  // workflow picked for it.
  let launch = $state<Record<string, { from: string; workflow: string } | null>>({});
  let loadedFor = -1;

  $effect(() => {
    if (studyIdx && loadedFor !== studyIdx) {
      loadedFor = studyIdx;
      load(studyIdx);
    }
  });

  async function load(idx: number) {
    loading = true;
    error = '';
    unsupported = false;
    const r = await api.studyLineage(idx);
    loading = false;
    if (!r.ok) {
      if (r.status === 404 || r.status === 405) unsupported = true;
      else error = `HTTP ${r.status} — ${r.detail}`;
      data = null;
      return;
    }
    data = r.data;
    // Pick up the last settings chosen here; each is checked against the data
    // before it is used (see the validation effect and the depth restores).
    const color: Record<string, string> = {};
    const shape: Record<string, string> = {};
    const cont: Record<string, boolean> = {};
    for (const g of r.data.groups) {
      const pr = loadPlotPrefs(idx, g.prep_protocol);
      if (pr.colorVar) color[g.prep_protocol] = pr.colorVar;
      if (pr.shapeVar) shape[g.prep_protocol] = pr.shapeVar;
      if (pr.continuous) cont[g.prep_protocol] = pr.continuous;
    }
    colorVar = color;
    shapeVar = shape;
    continuousFor = cont;
  }

  const NODE_W = 170;
  const NODE_H = 76;
  const COL_GAP = 56;
  const ROW_GAP = 20;

  type Placed = { node: LineageNode; c: number; r: number };
  /** A "Run workflow" launcher, one column right of the node it runs from. */
  type Launcher = { from: Placed; c: number; r: number };

  /** Column = longest path from a root; rows stack within a column. A node some
   *  workflow can run from gets a launcher in the next column, below that column's
   *  nodes. */
  function layout(g: LineageGroup) {
    const incoming = new Map<string, string[]>();
    for (const e of g.edges) incoming.set(e.target, [...(incoming.get(e.target) ?? []), e.source]);
    const depth = new Map<string, number>();
    const depthOf = (id: string, seen = new Set<string>()): number => {
      if (depth.has(id)) return depth.get(id)!;
      if (seen.has(id)) return 0; // a cycle would be a server bug; don't hang on it
      seen.add(id);
      const parents = incoming.get(id) ?? [];
      const d = parents.length ? Math.max(...parents.map((p) => depthOf(p, seen))) + 1 : 0;
      depth.set(id, d);
      return d;
    };
    const rows = new Map<number, number>();
    const placed: Placed[] = g.nodes.map((node) => {
      const c = depthOf(node.id);
      const r = rows.get(c) ?? 0;
      rows.set(c, r + 1);
      return { node, c, r };
    });
    const at = new Map(placed.map((p) => [p.node.id, p]));
    const launchers: Launcher[] = placed
      .filter((p) => workflowsFor(p.node, g).length)
      .map((from) => ({ from, c: from.c + 1, r: 0 }));
    for (const l of launchers) {
      l.r = rows.get(l.c) ?? 0;
      rows.set(l.c, l.r + 1);
    }
    const cols = Math.max(0, ...placed.map((p) => p.c), ...launchers.map((l) => l.c)) + 1;
    const maxRows = Math.max(1, ...rows.values());
    return {
      placed,
      at,
      launchers,
      width: cols * NODE_W + (cols - 1) * COL_GAP,
      height: maxRows * NODE_H + (maxRows - 1) * ROW_GAP
    };
  }
  const x = (c: number) => c * (NODE_W + COL_GAP);
  const y = (r: number) => r * (NODE_H + ROW_GAP);

  const STATE_ORDER: LineageState[] = [
    'completed',
    'processing',
    'pending',
    'failed',
    'invalidated',
    'no_data',
    'not_started'
  ];
  const STATE_BAR: Record<LineageState, string> = {
    completed: 'bg-teal-500',
    processing: 'bg-blue-500',
    pending: 'bg-amber-400',
    failed: 'bg-red-500',
    invalidated: 'bg-red-300',
    no_data: 'bg-gray-400',
    not_started: 'bg-gray-200'
  };
  const STATE_CHIP: Record<LineageState, string> = {
    completed: 'bg-green-50 text-green-700 ring-green-600/20',
    processing: 'bg-blue-50 text-blue-700 ring-blue-600/20',
    pending: 'bg-amber-50 text-amber-800 ring-amber-600/20',
    failed: 'bg-red-50 text-red-700 ring-red-600/10',
    invalidated: 'bg-red-50 text-red-600 ring-red-600/10',
    no_data: 'bg-gray-50 text-gray-600 ring-gray-500/10',
    not_started: 'bg-gray-50 text-gray-400 ring-gray-400/10'
  };
  const stateLabel = (s: string) => s.replace('_', ' ');

  function segments(n: LineageNode) {
    const total = Object.values(n.counts).reduce((a, b) => a + (b ?? 0), 0) || 1;
    return STATE_ORDER.filter((s) => n.counts[s]).map((s) => ({
      cls: STATE_BAR[s],
      pct: (100 * (n.counts[s] ?? 0)) / total
    }));
  }

  /** One line under a node's label: a product says how many samples it holds;
   *  a stage lists its non-zero states. */
  function summary(n: LineageNode): string {
    if (n.kind === 'product') {
      const k = n.counts.completed ?? 0;
      return `${k} sample${k === 1 ? '' : 's'}`;
    }
    return STATE_ORDER.filter((s) => n.counts[s])
      .map((s) => `${n.counts[s]} ${stateLabel(s)}`)
      .join(' · ');
  }

  /** The nodes from a root down to `n` (inclusive) that measure a per-sample
   *  value, upstream first, so a node's table carries every count leading to it
   *  (Reads, then ASVs, ...). */
  function valueChain(g: LineageGroup, n: LineageNode): LineageNode[] {
    const byId = new Map(g.nodes.map((x) => [x.id, x]));
    const seen = new Set<string>();
    const walk = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      for (const e of g.edges) if (e.target === id) walk(e.source);
    };
    walk(n.id);
    // Upstream first: an ancestor sits at a lower depth than what it feeds.
    const depth = (id: string): number => {
      const parents = g.edges.filter((e) => e.target === id).map((e) => e.source);
      return parents.length ? Math.max(...parents.map(depth)) + 1 : 0;
    };
    return [...seen]
      .map((id) => byId.get(id)!)
      .filter((x) => x?.value_label)
      .sort((a, b) => depth(a.id) - depth(b.id));
  }

  function detailColumns(g: LineageGroup, n: LineageNode) {
    return [
      { key: 'sample', label: labelHeader(g.samples.map((s) => s.label_source)) },
      ...valueChain(g, n).map((v) => ({ key: `v:${v.id}`, label: v.value_label! }))
    ];
  }

  /** The scatter of the first two counts on the way to `n`, over the rows the
   *  table currently shows; rows lacking a positive value for either are counted. */
  function scatter(g: LineageGroup, n: LineageNode, rows: Record<string, unknown>[]) {
    const chain = valueChain(g, n);
    if (chain.length < 2) return null;
    const [a, b] = chain;
    const points = rows.flatMap((r) => {
      const x = Number(r[`v:${a.id}`]);
      const y = Number(r[`v:${b.id}`]);
      return x > 0 && y > 0 ? [{ label: String(r.sample), x, y }] : [];
    });
    // Nothing to plot until some sample has both values (a run still pending).
    if (points.length === 0) return null;
    return {
      points,
      xLabel: a.value_label!,
      yLabel: b.value_label!,
      omitted: rows.length - points.length
    };
  }

  // A feature table's PCoA, by processing_idx: fetched and computed (in the
  // Pyodide worker) the first time its node is selected, then kept; a new depth
  // recomputes from the kept table.
  type PcoaState =
    | { state: 'loading' }
    | { state: 'ok'; table: FeatureTable; pcoa: Pcoa; busy: boolean }
    | { state: 'error'; message: string };
  // Raw: entries are only ever replaced, and the feature table inside is posted to
  // the worker, which cannot clone a reactive proxy.
  let pcoaFor = $state.raw<Record<number, PcoaState>>({});

  async function loadPcoa(processingIdx: number, protocol: string) {
    pcoaFor = { ...pcoaFor, [processingIdx]: { state: 'loading' } };
    const table = await loadFeatureTable({ processing_idx: [processingIdx], study_idx: studyIdx });
    if (!table.ok) {
      pcoaFor = { ...pcoaFor, [processingIdx]: { state: 'error', message: `feature table: ${table.detail}` } };
      return;
    }
    try {
      let pcoa = await pyworker.pcoa(table.data);
      // Restore the last depth, if a sample still has exactly that depth, before
      // anything is shown, so the plot draws once at the depth it will stay at.
      const saved = loadPlotPrefs(studyIdx, protocol).pcoaDepth;
      if (saved != null && table.data.valueKind === 'count') {
        try {
          if (!pcoa.depths.includes(saved)) throw new Error('no sample has that depth any more');
          pcoa = await pyworker.pcoa(table.data, saved);
        } catch (e) {
          savePlotPrefs(studyIdx, protocol, { pcoaDepth: null });
          console.warn(`Saved PCoA depth ${saved} not restored:`, e);
        }
      }
      pcoaFor = { ...pcoaFor, [processingIdx]: { state: 'ok', table: table.data, pcoa, busy: false } };
    } catch (e) {
      pcoaFor = { ...pcoaFor, [processingIdx]: { state: 'error', message: `PCoA: ${String(e)}` } };
    }
  }

  async function rarefy(processingIdx: number, depth: number | null, protocol: string) {
    const cur = pcoaFor[processingIdx];
    if (cur?.state !== 'ok') return;
    pcoaFor = { ...pcoaFor, [processingIdx]: { ...cur, busy: true } };
    try {
      const pcoa = await pyworker.pcoa(cur.table, depth);
      pcoaFor = { ...pcoaFor, [processingIdx]: { ...cur, pcoa, busy: false } };
      savePlotPrefs(studyIdx, protocol, { pcoaDepth: depth });
    } catch (e) {
      // A depth that fails (e.g. too few samples reach it) is not remembered; the
      // unrarefied ordination still stands.
      savePlotPrefs(studyIdx, protocol, { pcoaDepth: null });
      pcoaFor = { ...pcoaFor, [processingIdx]: { ...cur, busy: false } };
      console.warn(`PCoA at depth ${depth} failed; kept the previous ordination:`, e);
    }
  }

  // Sample metadata for colouring, by sample label, from the study's shared
  // metadata (loaded once when the study opens).
  type MetaState = { state: 'loading' } | { state: 'ok'; byLabel: Record<string, Record<string, MetaField>> };
  const metaFor = $derived.by(() => {
    const out: Record<string, MetaState> = {};
    if (!data) return out;
    const ready = studyMetadata.ready(studyIdx);
    for (const g of data.groups) {
      if (!ready) {
        out[g.prep_protocol] = { state: 'loading' };
        continue;
      }
      const byLabel: Record<string, Record<string, MetaField>> = {};
      for (const s of g.samples) {
        const b = studyMetadata.byIdx.get(s.biosample_idx);
        if (b) byLabel[s.label] = metadataFields(b);
      }
      out[g.prep_protocol] = { state: 'ok', byLabel };
    }
    return out;
  });
  // The lineage can sit on a page that didn't start the load; this is a no-op
  // when the study is already loaded or loading.
  $effect(() => {
    if (studyIdx) studyMetadata.load(studyIdx);
  });

  // Each scatter's axis scales, once switched this visit (else the saved ones).
  let logFor = $state<Record<string, { xLog?: boolean; yLog?: boolean }>>({});
  // The variable each group's ordination is coloured by, and whether its palette
  // is continuous.
  let colorVar = $state<Record<string, string>>({});
  let continuousFor = $state<Record<string, boolean>>({});

  function variablesOf(byLabel: Record<string, Record<string, MetaField>>): string[] {
    const seen = new Set<string>();
    for (const f of Object.values(byLabel)) for (const k of Object.keys(f)) seen.add(k);
    return [...seen].sort(natural);
  }

  // `keys` are what the plot keys its markers by; `biosampleOf` maps a key to its
  // biosample's public name, the metadata key (identity for lineage labels; the
  // feature table's sidecar for its columns).
  const same = (k: string) => k;

  function coloringFor(g: LineageGroup, keys: string[], biosampleOf: (k: string) => string = same) {
    const m = metaFor[g.prep_protocol];
    const v = colorVar[g.prep_protocol];
    if (m?.state !== 'ok' || !v) return null;
    return colorBy(Object.fromEntries(keys.map((k) => [k, fieldValue(m.byLabel[biosampleOf(k)]?.[v])])), {
      continuous: continuousFor[g.prep_protocol] ?? false
    });
  }

  // The variable each group's markers are shaped by ('' for none).
  let shapeVar = $state<Record<string, string>>({});

  function shapingFor(g: LineageGroup, keys: string[], biosampleOf: (k: string) => string = same) {
    const m = metaFor[g.prep_protocol];
    const v = shapeVar[g.prep_protocol];
    if (m?.state !== 'ok' || !v) return null;
    return shapeBy(Object.fromEntries(keys.map((k) => [k, fieldValue(m.byLabel[biosampleOf(k)]?.[v])])));
  }

  // Settings restored from storage are checked once the metadata is in: a saved
  // variable the study no longer has falls back to the default.
  $effect(() => {
    for (const g of data?.groups ?? []) {
      const m = metaFor[g.prep_protocol];
      if (m?.state !== 'ok') continue;
      const vars = variablesOf(m.byLabel);
      const key = g.prep_protocol;
      const c = colorVar[key];
      if (c && !vars.includes(c))
        untrack(() => (colorVar = { ...colorVar, [key]: vars.includes('qiita_sample_type') ? 'qiita_sample_type' : (vars[0] ?? '') }));
      const sh = shapeVar[key];
      if (sh && !vars.includes(sh)) untrack(() => (shapeVar = { ...shapeVar, [key]: '' }));
    }
  });

  // And saved whenever they change.
  $effect(() => {
    for (const g of data?.groups ?? []) {
      const key = g.prep_protocol;
      savePlotPrefs(studyIdx, key, {
        colorVar: colorVar[key],
        shapeVar: shapeVar[key] ?? '',
        continuous: continuousFor[key] ?? false
      });
    }
  });

  // The PERMANOVA for each group's current (variable, depth), recomputed whenever
  // either changes; a stale answer (an older request's) is dropped.
  let permFor = $state<Record<string, Permanova | string | null>>({});
  let permSeq = 0;
  $effect(() => {
    for (const g of data?.groups ?? []) {
      const sel = selected[g.prep_protocol];
      const node = sel ? g.nodes.find((n) => n.id === sel) : null;
      const ft = node?.kind === 'product' ? node.processing_idx : null;
      const pc = ft != null ? pcoaFor[ft] : undefined;
      if (pc?.state !== 'ok' || pc.busy) continue;
      const coloring = coloringFor(g, pc.pcoa.samples, (k) => pc.table.biosampleOf[k]);
      if (!coloring) continue;
      const key = g.prep_protocol;
      if (!coloring.groups) {
        untrack(() => (permFor = { ...permFor, [key]: 'A continuous variable has no groups to test.' }));
        continue;
      }
      const seq = ++permSeq;
      const groups = coloring.groups;
      untrack(() => (permFor = { ...permFor, [key]: null }));
      pyworker.permanova(groups).then(
        (r) => seq === permSeq && (permFor = { ...permFor, [key]: r }),
        (e) => seq === permSeq && (permFor = { ...permFor, [key]: `PERMANOVA failed: ${String(e)}` })
      );
    }
  });

  // Each group's table rows after its filter, which the scatter draws.
  let visible = $state<Record<string, Record<string, unknown>[]>>({});

  function detailRows(g: LineageGroup, n: LineageNode) {
    const chain = valueChain(g, n);
    return g.samples
      .filter((s) => n.kind !== 'product' || s.cells[n.id])
      .map((s) => ({
        sample: s.label,
        ...Object.fromEntries(chain.map((v) => [`v:${v.id}`, s.cells[v.id]?.value ?? '—'])),
        __state: s.cells[n.id]?.state ?? 'not_started'
      }));
  }

  // The action that produced a node, shown on hover over the arrow into it rather
  // than on the node: the node says what the data is, the arrow how it got there.
  const producedBy = (n: LineageNode) => (n.kind === 'product' ? '' : (n.detail ?? ''));
  let edgeHover = $state<{ key: string; x: number; y: number; text: string } | null>(null);
</script>

{#if loading && !data}
  <Card title="Processing lineage"><p class="text-sm text-gray-500">Loading lineage…</p></Card>
{:else if unsupported}
  <Card title="Processing lineage">
    <p class="text-sm text-gray-500">
      Lineage needs <code class="rounded bg-gray-100 px-1">GET /study/&lbrace;idx&rbrace;/lineage</code>,
      which this server doesn't have yet.
    </p>
  </Card>
{:else if error}
  <Card title="Processing lineage"><p class="text-sm text-red-700">{error}</p></Card>
{:else if data && data.groups.length === 0}
  <Card title="Processing lineage">
    <p class="text-sm text-gray-500">No samples linked to this study yet.</p>
  </Card>
{:else if data}
  <div class="space-y-4">
    {#each data.groups as g (g.prep_protocol)}
      {@const L = layout(g)}
      {@const sel = selected[g.prep_protocol] ?? null}
      {@const selNode = sel ? (g.nodes.find((n) => n.id === sel) ?? null) : null}
      <Card bodyClass="" title={`Processing lineage — ${g.prep_protocol.replaceAll('_', ' ')} (${g.samples.length} samples)`}>
        <div class="overflow-x-auto px-4 py-4 sm:px-6">
          <div class="relative mx-auto" style="width:{L.width}px;height:{L.height}px">
            <svg class="pointer-events-none absolute inset-0" width={L.width} height={L.height}>
              <defs>
                <marker id="lin-arrow-{g.prep_protocol}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M0 0L10 5L0 10z" fill="#9ca3af" />
                </marker>
              </defs>
              {#each g.edges as e (e.source + '>' + e.target)}
                {@const a = L.at.get(e.source)}
                {@const b = L.at.get(e.target)}
                {#if a && b}
                  {@const key = `${g.prep_protocol}:${e.source}>${e.target}`}
                  {@const x1 = x(a.c) + NODE_W}
                  {@const y1 = y(a.r) + NODE_H / 2}
                  {@const x2 = x(b.c)}
                  {@const y2 = y(b.r) + NODE_H / 2}
                  {@const action = producedBy(b.node)}
                  <line
                    {x1}
                    {y1}
                    {x2}
                    {y2}
                    stroke={edgeHover?.key === key
                      ? '#0f766e'
                      : b.node.kind === 'product'
                        ? '#cbd5e1'
                        : '#9ca3af'}
                    stroke-width={edgeHover?.key === key ? 2.5 : 1.5}
                    stroke-dasharray={b.node.kind === 'product' ? '4 3' : undefined}
                    marker-end="url(#lin-arrow-{g.prep_protocol})"
                  />
                  {#if action}
                    <!-- A wide, invisible hit area: a 1.5px arrow is too thin to hover. -->
                    <line
                      {x1}
                      {y1}
                      {x2}
                      {y2}
                      stroke="transparent"
                      stroke-width="16"
                      pointer-events="stroke"
                      class="cursor-help"
                      role="img"
                      aria-label={action}
                      onpointerenter={() =>
                        (edgeHover = { key, x: (x1 + x2) / 2, y: (y1 + y2) / 2, text: action })}
                      onpointerleave={() => (edgeHover = null)}
                    />
                  {/if}
                {/if}
              {/each}
              {#each L.launchers as l (l.from.node.id)}
                <line
                  x1={x(l.from.c) + NODE_W}
                  y1={y(l.from.r) + NODE_H / 2}
                  x2={x(l.c)}
                  y2={y(l.r) + NODE_H / 2}
                  stroke={launch[g.prep_protocol]?.from === l.from.node.id ? '#0f766e' : '#cbd5e1'}
                  stroke-width="1.5"
                  stroke-dasharray="4 3"
                  marker-end="url(#lin-arrow-{g.prep_protocol})"
                />
              {/each}
            </svg>

            {#each L.placed as p (p.node.id)}
              {@const isProduct = p.node.kind === 'product'}
              <button
                class="absolute flex flex-col overflow-hidden rounded-lg border text-center transition {sel === p.node.id
                  ? 'border-teal-500 ring-1 ring-teal-500'
                  : isProduct
                    ? 'border-dashed border-teal-300 bg-teal-50/40 hover:border-teal-400'
                    : 'border-gray-200 bg-white hover:border-gray-300'}"
                style="left:{x(p.c)}px;top:{y(p.r)}px;width:{NODE_W}px;height:{NODE_H}px"
                onclick={() => {
                  selected = { ...selected, [g.prep_protocol]: sel === p.node.id ? null : p.node.id };
                  const ft = p.node.kind === 'product' ? p.node.processing_idx : null;
                  if (ft != null && !pcoaFor[ft]) loadPcoa(ft, g.prep_protocol);
                  // A node with a plot (a feature table, or two counts) colours by metadata.
                  if (ft != null || valueChain(g, p.node).length >= 2) {
                    if (!colorVar[g.prep_protocol])
                      colorVar = { ...colorVar, [g.prep_protocol]: 'qiita_sample_type' };
                  }
                }}
              >
                <span class="flex flex-1 flex-col items-center justify-center gap-0.5 px-2">
                  <span class="text-sm leading-tight font-medium text-gray-900">{p.node.label}</span>
                  <span class="text-[11px] leading-tight text-gray-500">{summary(p.node)}</span>
                </span>
                <div class="flex h-1.5 w-full bg-gray-100">
                  {#each segments(p.node) as seg}<div class={seg.cls} style="width:{seg.pct}%"></div>{/each}
                </div>
              </button>
            {/each}
            {#each L.launchers as l (l.from.node.id)}
              {@const open = launch[g.prep_protocol]?.from === l.from.node.id}
              <button
                class="absolute flex items-center justify-center gap-1.5 rounded-lg border border-dashed text-sm font-medium transition {open
                  ? 'border-teal-500 bg-teal-50 text-teal-800 ring-1 ring-teal-500'
                  : 'border-gray-300 bg-white/60 text-gray-500 hover:border-teal-400 hover:text-teal-700'}"
                style="left:{x(l.c)}px;top:{y(l.r)}px;width:{NODE_W}px;height:{NODE_H}px"
                aria-expanded={open}
                onclick={() => {
                  const ws = workflowsFor(l.from.node, g);
                  launch = {
                    ...launch,
                    [g.prep_protocol]: open
                      ? null
                      : { from: l.from.node.id, workflow: (ws.find((w) => w.form) ?? ws[0]).id }
                  };
                }}
              >
                <svg viewBox="0 0 20 20" fill="currentColor" class="size-4" aria-hidden="true">
                  <path d="M6.3 2.84A1.5 1.5 0 0 0 4 4.11v11.78a1.5 1.5 0 0 0 2.3 1.27l9.34-5.89a1.5 1.5 0 0 0 0-2.54L6.3 2.84Z" />
                </svg>
                Run workflow
              </button>
            {/each}
            {#if edgeHover?.key.startsWith(`${g.prep_protocol}:`)}
              <div
                class="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded bg-gray-900 px-2 py-1 font-mono text-[11px] whitespace-nowrap text-white shadow"
                style="left:{edgeHover.x}px;top:{edgeHover.y - 6}px"
              >
                {edgeHover.text}
              </div>
            {/if}
          </div>
        </div>

        {#if launch[g.prep_protocol]}
          {@const ln = launch[g.prep_protocol]!}
          {@const fromNode = g.nodes.find((n) => n.id === ln.from)}
          {@const choices = fromNode ? workflowsFor(fromNode, g) : []}
          {@const wf = choices.find((w) => w.id === ln.workflow)}
          <div class="flex flex-wrap items-end gap-3 border-t border-gray-200 bg-gray-50 px-4 py-3 sm:px-6">
            <p class="flex w-full items-center justify-between text-xs font-medium text-gray-500">
              Run a workflow on {fromNode?.label ?? 'this node'}
              <button
                type="button"
                class="text-gray-400 hover:text-gray-600"
                aria-label="Close"
                onclick={() => (launch = { ...launch, [g.prep_protocol]: null })}>✕</button
              >
            </p>
            <label class="flex flex-col gap-1 text-xs text-gray-600">
              Workflow
              <Select
                class="w-64"
                bind:value={
                  () => ln.workflow,
                  (v) => (launch = { ...launch, [g.prep_protocol]: { from: ln.from, workflow: v } })
                }
              >
                {#each choices as w (w.id)}
                  <option value={w.id} disabled={!w.form}>{w.label}{w.note ? ` — ${w.note}` : ''}</option>
                {/each}
              </Select>
            </label>
            {#if wf?.form}
              {#key wf.id}
                <wf.form samples={g.samples} onSubmitted={() => load(studyIdx)} />
              {/key}
            {/if}
          </div>
        {/if}

        {#if selNode}
          {@const sc = scatter(g, selNode, visible[g.prep_protocol] ?? [])}
          {@const ftIdx = selNode.kind === 'product' ? selNode.processing_idx : null}
          {@const pc = ftIdx != null ? pcoaFor[ftIdx] : undefined}
          {@const shown = new Set((visible[g.prep_protocol] ?? []).map((r) => String(r.sample)))}
          <div class="border-t border-gray-200">
            {#if ftIdx != null}
              {@const meta = metaFor[g.prep_protocol]}
              {@const bio = pc?.state === 'ok' ? (k: string) => pc.table.biosampleOf[k] : same}
              {@const coloring = pc?.state === 'ok' ? coloringFor(g, pc.pcoa.samples, bio) : null}
              {@const shaping = pc?.state === 'ok' ? shapingFor(g, pc.pcoa.samples, bio) : null}
              <div class="grid grid-cols-1 gap-x-2 pt-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                <div>
                  <!-- Held until the metadata is in too, so the restored colours and
                       shapes are on the first draw rather than repainted over it. -->
                  {#if pc?.state === 'ok' && meta?.state === 'ok'}
                    <PcoaPlot
                      pcoa={pc.pcoa}
                      busy={pc.busy}
                      visible={shown}
                      displayOf={(k) => {
                        const b = pc.table.biosampleOf[k];
                        return b === k ? k : `${b} · ${k}`;
                      }}
                      colorOf={coloring?.colorOf ?? null}
                      symbolOf={shaping?.symbolOf ?? null}
                      onDepth={(d) => rarefy(ftIdx, d, g.prep_protocol)}
                    />
                  {:else if pc?.state === 'error'}
                    <p class="px-4 py-12 text-center text-sm text-amber-800 sm:px-6">{pc.message}</p>
                  {:else}
                    <Spinner label={pc?.state === 'ok' ? 'Loading sample metadata…' : 'Computing PCoA…'} />
                  {/if}
                </div>
                {#if pc?.state === 'ok' && meta?.state === 'ok'}
                  <div class="lg:pt-6">
                    <ColorPanel
                      variables={meta?.state === 'ok' ? variablesOf(meta.byLabel) : []}
                      bind:value={
                        () => colorVar[g.prep_protocol] ?? '',
                        (v) => (colorVar = { ...colorVar, [g.prep_protocol]: v })
                      }
                      legend={coloring?.legend ?? []}
                      gradient={coloring?.gradient ?? null}
                      bind:continuous={
                        () => continuousFor[g.prep_protocol] ?? false,
                        (v) => (continuousFor = { ...continuousFor, [g.prep_protocol]: v })
                      }
                      bind:shape={
                        () => shapeVar[g.prep_protocol] ?? '',
                        (v) => (shapeVar = { ...shapeVar, [g.prep_protocol]: v })
                      }
                      shapeLegend={shaping?.legend ?? []}
                      shapeRepeats={shaping?.repeats ?? false}
                      permanova={permFor[g.prep_protocol] ?? null}
                      loading={meta?.state !== 'ok'}
                    />
                  </div>
                {/if}
              </div>
            {:else if sc}
              {@const meta = metaFor[g.prep_protocol]}
              {@const labels = sc.points.map((p) => p.label)}
              {@const coloring = coloringFor(g, labels)}
              {@const shaping = shapingFor(g, labels)}
              <div class="grid grid-cols-1 gap-x-2 pt-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                {#if meta?.state === 'ok'}
                  <ValueScatter
                    {...sc}
                    colorOf={coloring?.colorOf ?? null}
                    symbolOf={shaping?.symbolOf ?? null}
                    initialDepth={loadPlotPrefs(studyIdx, g.prep_protocol).asvDepth ?? null}
                    onDepthChange={(d) => savePlotPrefs(studyIdx, g.prep_protocol, { asvDepth: d })}
                    bind:xLog={
                      () => logFor[g.prep_protocol]?.xLog ?? loadPlotPrefs(studyIdx, g.prep_protocol).xLog ?? true,
                      (v) => {
                        logFor = { ...logFor, [g.prep_protocol]: { ...logFor[g.prep_protocol], xLog: v } };
                        savePlotPrefs(studyIdx, g.prep_protocol, { xLog: v });
                      }
                    }
                    bind:yLog={
                      () => logFor[g.prep_protocol]?.yLog ?? loadPlotPrefs(studyIdx, g.prep_protocol).yLog ?? true,
                      (v) => {
                        logFor = { ...logFor, [g.prep_protocol]: { ...logFor[g.prep_protocol], yLog: v } };
                        savePlotPrefs(studyIdx, g.prep_protocol, { yLog: v });
                      }
                    }
                  />
                {:else}
                  <Spinner label="Loading sample metadata…" />
                {/if}
                <div class="lg:pt-6">
                  <ColorPanel
                    variables={meta?.state === 'ok' ? variablesOf(meta.byLabel) : []}
                    bind:value={
                      () => colorVar[g.prep_protocol] ?? '',
                      (v) => (colorVar = { ...colorVar, [g.prep_protocol]: v })
                    }
                    legend={coloring?.legend ?? []}
                    gradient={coloring?.gradient ?? null}
                    bind:continuous={
                      () => continuousFor[g.prep_protocol] ?? false,
                      (v) => (continuousFor = { ...continuousFor, [g.prep_protocol]: v })
                    }
                    bind:shape={
                      () => shapeVar[g.prep_protocol] ?? '',
                      (v) => (shapeVar = { ...shapeVar, [g.prep_protocol]: v })
                    }
                    shapeLegend={shaping?.legend ?? []}
                    shapeRepeats={shaping?.repeats ?? false}
                    loading={meta?.state !== 'ok'}
                  />
                </div>
              </div>
            {/if}
            {#if ftIdx != null && pc?.state === 'ok'}
              <FeatureTableGrid
                table={pc.table}
                idHeader={labelHeader(g.samples.map((s) => s.label_source))}
                bind:visibleLabels={
                  () => (visible[g.prep_protocol] ?? []).map((r) => String(r.sample)),
                  (v) => untrack(() => (visible = { ...visible, [g.prep_protocol]: v.map((l) => ({ sample: l })) }))
                }
              />
            {:else}
            <DataTable
              columns={detailColumns(g, selNode)}
              rows={detailRows(g, selNode)}
              bind:visibleRows={
                () => visible[g.prep_protocol] ?? [],
                // Untracked: the table's effect calls this, and reading `visible`
                // there would make the effect depend on what it writes.
                (v) => untrack(() => (visible = { ...visible, [g.prep_protocol]: v }))
              }
            >
              {#snippet actions(r)}
                {@const st = String(r.__state) as LineageState}
                <span class="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium capitalize ring-1 ring-inset {STATE_CHIP[st] ?? STATE_CHIP.not_started}">{stateLabel(st)}</span>
              {/snippet}
            </DataTable>
            {/if}
          </div>
        {/if}
      </Card>
    {/each}
  </div>
{/if}
