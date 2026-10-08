<script lang="ts">
  import { api, type StudyLineage, type LineageNode } from '$lib/api';
  import { STATE_CLASS } from '$lib/tickets';
  import Card from './Card.svelte';
  import DataTable from './DataTable.svelte';

  let { studyIdx }: { studyIdx: number } = $props();

  let data = $state<StudyLineage | null>(null);
  let loading = $state(false);
  let error = $state('');
  let unsupported = $state(false);
  let selected = $state<string | null>(null);
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
    if (selected && !r.data.nodes.some((n) => n.id === selected)) selected = null;
  }

  async function queueSample(prepSampleIdx: number) {
    await api.processSample(studyIdx, prepSampleIdx);
    await load(studyIdx); // reflect the advanced state in counts/bars/table
  }

  // --- fixed DAG layout (ids are a known shape) ---
  const NODE_W = 150;
  const NODE_H = 72;
  const COL_GAP = 66;
  const ROW_GAP = 22;
  const POS: Record<string, { c: number; r: number }> = {
    raw_reads: { c: 0, r: 1 },
    processed_reads: { c: 1, r: 1 },
    assemblies: { c: 2, r: 1 },
    bins: { c: 3, r: 1 },
    mag: { c: 4, r: 0 },
    lcg: { c: 4, r: 1 },
    unbinned: { c: 4, r: 2 },
    feature_table: { c: 5, r: 0.5 }
  };
  const colX = (c: number) => c * (NODE_W + COL_GAP);
  const rowY = (r: number) => r * (NODE_H + ROW_GAP);
  const boardW = colX(5) + NODE_W;
  const boardH = rowY(2) + NODE_H;
  const rightMid = (id: string) => ({ x: colX(POS[id].c) + NODE_W, y: rowY(POS[id].r) + NODE_H / 2 });
  const leftMid = (id: string) => ({ x: colX(POS[id].c), y: rowY(POS[id].r) + NODE_H / 2 });

  const selectedNode = $derived(
    data && selected ? (data.nodes.find((n) => n.id === selected) ?? null) : null
  );

  const chip = (state: string) =>
    STATE_CLASS[state as keyof typeof STATE_CLASS] ?? 'bg-gray-50 text-gray-600 ring-gray-500/10';
  const stateLabel = (s: string) =>
    s === 'not_started' ? 'not started' : s === 'no_data' ? 'no data' : s.replace('_', ' ');

  // Completion bar segmented by sample state, out of the node's total.
  function segments(n: LineageNode) {
    const total = n.completion.total || 1;
    let completed = 0;
    let processing = 0;
    let failed = 0;
    for (const s of n.samples) {
      if (s.state === 'completed') completed++;
      else if (s.state === 'processing') processing++;
      else if (s.state === 'failed') failed++;
    }
    const remaining = Math.max(0, total - completed - processing - failed);
    return [
      { cls: 'bg-teal-500', n: completed },
      { cls: 'bg-blue-500', n: processing },
      { cls: 'bg-red-500', n: failed },
      { cls: 'bg-gray-200', n: remaining }
    ]
      .filter((s) => s.n > 0)
      .map((s) => ({ cls: s.cls, pct: (100 * s.n) / total }));
  }

  // Per-node detail rows for DataTable: node columns + hidden state/idx for the action cell.
  function detailRows(n: LineageNode) {
    return n.samples.map((s) => ({
      accession: s.accession,
      ...s.values,
      __state: s.state,
      __idx: s.prep_sample_idx
    }));
  }
</script>

<Card title="Processing lineage">
  {#if loading && !data}
    <p class="text-sm text-gray-500">Loading lineage…</p>
  {:else if unsupported}
    <p class="text-sm text-gray-500">
      Lineage needs <code class="rounded bg-gray-100 px-1">GET /study/&lbrace;idx&rbrace;/lineage</code>,
      which this server doesn't have yet.
    </p>
  {:else if error}
    <p class="text-sm text-red-700">{error}</p>
  {:else if data}
    <!-- singular study DAG: pools converge; stages rail → Bins forks into MAG/LCG/Unbinned;
         MAG & LCG feed a detached (dashed) feature table. px/pt padding keeps a selected
         node's ring from being clipped by the scroll container (overflow-x:auto clips y too). -->
    <div class="overflow-x-auto px-1 pt-2 pb-2">
      <div class="relative" style="width:{boardW}px;height:{boardH}px">
        <svg
          class="pointer-events-none absolute inset-0"
          width={boardW}
          height={boardH}
          aria-hidden="true"
        >
          <defs>
            <marker id="lin-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M0 0L10 5L0 10z" fill="#9ca3af" />
            </marker>
          </defs>
          {#each data.edges as [from, to, opt] (from + to)}
            {#if POS[from] && POS[to]}
              {@const a = rightMid(from)}
              {@const b = leftMid(to)}
              <line
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={opt?.dashed ? '#cbd5e1' : '#9ca3af'}
                stroke-width="1.5"
                stroke-dasharray={opt?.dashed ? '4 3' : undefined}
                marker-end="url(#lin-arrow)"
              />
            {/if}
          {/each}
        </svg>

        {#each data.nodes as n (n.id)}
          {#if POS[n.id]}
            {@const isFeature = n.kind === 'feature_table'}
            <button
              class="absolute flex flex-col overflow-hidden rounded-lg border text-center transition {selected ===
              n.id
                ? 'border-teal-500 ring-1 ring-teal-500'
                : isFeature
                  ? 'border-dashed border-teal-300 bg-teal-50/40 hover:border-teal-400'
                  : 'border-gray-200 bg-white hover:border-gray-300'}"
              style="left:{colX(POS[n.id].c)}px;top:{rowY(POS[n.id].r)}px;width:{NODE_W}px;height:{NODE_H}px"
              onclick={() => (selected = selected === n.id ? null : n.id)}
            >
              <span class="flex flex-1 flex-col items-center justify-center gap-0.5 px-2">
                <span class="text-sm leading-tight font-medium text-gray-900">{n.label}</span>
                {#if isFeature}
                  <span class="text-xs text-gray-500"
                    >{data.feature_table_stats.tables.length} table{data.feature_table_stats.tables
                      .length === 1
                      ? ''
                      : 's'}</span
                  >
                {:else}
                  <span class="text-xs text-gray-500"
                    ><span class="font-semibold text-gray-700">{n.completion.done}</span>/{n
                      .completion.total} samples</span
                  >
                {/if}
              </span>
              <!-- segmented completion bar -->
              <div class="flex h-1.5 w-full bg-gray-100">
                {#each segments(n) as seg}<div class={seg.cls} style="width:{seg.pct}%"></div>{/each}
              </div>
            </button>
          {/if}
        {/each}
      </div>
    </div>

    {#if selectedNode}
      <div class="mt-3 rounded-md ring-1 ring-gray-200">
        {#if selectedNode.kind === 'feature_table'}
          <DataTable
            columns={[
              { key: 'id', label: 'Feature table' },
              { key: 'rows', label: 'Rows' },
              { key: 'cols', label: 'Cols' },
              { key: 'sparsity_pct', label: 'Sparsity %' },
              { key: 'merged_sample_count', label: 'Merged samples' }
            ]}
            rows={data.feature_table_stats.tables}
          />
          <p class="px-3 py-2 text-xs text-gray-400">
            Merged sample count may be fewer than samples processed, and a feature table may span
            pools or studies.
          </p>
        {:else}
          <DataTable
            columns={[{ key: 'accession', label: 'Sample' }, ...selectedNode.columns]}
            rows={detailRows(selectedNode)}
            filterPlaceholder="filter samples…"
          >
            {#snippet actions(r)}
              {@const st = String(r.__state)}
              <span
                class="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium capitalize ring-1 ring-inset {chip(st)}"
                >{stateLabel(st)}</span
              >
              {#if selectedNode?.action_id && st === 'not_started'}
                <button
                  class="ml-2 rounded-md bg-teal-700 px-2.5 py-0.5 text-xs font-semibold text-white hover:bg-teal-600"
                  onclick={() => queueSample(Number(r.__idx))}>Queue</button
                >
              {/if}
            {/snippet}
          </DataTable>
        {/if}
      </div>
    {:else}
      <p class="mt-2 text-xs text-gray-400">Click a node to see its per-sample detail.</p>
    {/if}
  {/if}
</Card>
