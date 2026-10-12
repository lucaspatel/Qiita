<script lang="ts">
  // A feature table shown dense: one row per sample, one column per feature, the
  // count in each cell and "-" where the sample has none of it. The table itself
  // stays sparse (COO); only the cells in view are looked up. Features run most
  // abundant first, and only the columns in view render: the rest are spacer
  // cells sized to keep the scroll width true. Rows sort by the sample or by any
  // feature's value (the arrow in its header); tapping a header's name expands
  // its column to the width of the whole species name or sequence (one line, for
  // reading and copying), with a copy button; another tap collapses it.
  import { genomeLabel, type FeatureTable } from '$lib/featureTable';

  let {
    table,
    idHeader,
    visibleLabels = $bindable([])
  }: {
    table: FeatureTable;
    idHeader: string;
    /** Out: the column names passing the filter, for a companion plot. */
    visibleLabels?: string[];
  } = $props();

  // A profile's columns carry species names, an amplicon table's the first bases.
  const COL_W = $derived(table.valueKind === 'relative_abundance' ? 168 : 96);
  const ID_W = 200;
  const PAGE = 25;

  // Each sample's observations as a feature-code -> count lookup, and the feature
  // codes in display order (most abundant first).
  const view = $derived.by(() => {
    const bySample = table.samples.map(() => new Map<number, number>());
    const totals = new Float64Array(table.features.length);
    for (let i = 0; i < table.s.length; i++) {
      bySample[table.s[i]].set(table.f[i], table.c[i]);
      totals[table.f[i]] += table.c[i];
    }
    const order = Array.from(table.features.keys()).sort((a, b) => totals[b] - totals[a]);
    return { bySample, order };
  });

  let query = $state('');
  let page = $state(0);
  // 'sample' sorts by the row's label; a number sorts by that feature's value
  // (a sample without it counts as zero). A feature starts most-first.
  let sortKey = $state<'sample' | number | null>(null);
  let sortDir = $state<'asc' | 'desc'>('desc');
  function toggleSort(key: 'sample' | number) {
    if (sortKey === key) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    else {
      sortKey = key;
      sortDir = key === 'sample' ? 'asc' : 'desc';
    }
  }
  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase();
    const rows = table.samples
      .map((name, s) => ({ name, s, biosample: table.biosampleOf[name] ?? name }))
      .filter((r) => !q || r.name.toLowerCase().includes(q) || r.biosample.toLowerCase().includes(q));
    if (sortKey === null) return rows;
    const dir = sortDir === 'asc' ? 1 : -1;
    const key = sortKey;
    return rows.sort((a, b) =>
      key === 'sample'
        ? a.biosample.localeCompare(b.biosample) * dir
        : ((view.bySample[a.s].get(key) ?? 0) - (view.bySample[b.s].get(key) ?? 0)) * dir ||
          a.biosample.localeCompare(b.biosample)
    );
  });
  // Features whose header is expanded to the whole name.
  let expanded = $state(new Set<number>());
  function toggleExpanded(f: number) {
    const next = new Set(expanded);
    if (!next.delete(f)) next.add(f);
    expanded = next;
  }
  $effect(() => {
    visibleLabels = filtered.map((r) => r.name);
  });
  $effect(() => {
    query;
    sortKey;
    sortDir;
    page = 0;
  });
  const pageCount = $derived(Math.max(1, Math.ceil(filtered.length / PAGE)));
  const clamped = $derived(Math.min(page, pageCount - 1));
  const paged = $derived(filtered.slice(clamped * PAGE, clamped * PAGE + PAGE));

  // Horizontal windowing. Columns are COL_W wide unless expanded, so each one's
  // left edge is a prefix sum and the columns in view are found by bisection.
  const nCols = $derived(view.order.length);
  let scrollLeft = $state(0);
  let viewW = $state(0);
  // An 11px monospace glyph is ~6.7px; the padding and the sort arrow add ~44px.
  const CHAR_W = 6.7;
  const widthOf = (f: number) =>
    expanded.has(f)
      ? Math.max(COL_W, Math.ceil(Math.max(sequence(f).length, table.features[f].length) * CHAR_W) + 44)
      : COL_W;
  const edges = $derived.by(() => {
    const out = new Float64Array(nCols + 1);
    for (let k = 0; k < nCols; k++) out[k + 1] = out[k] + widthOf(view.order[k]);
    return out;
  });
  // The column whose span holds pixel x (0..nCols).
  function colAt(x: number): number {
    let lo = 0;
    let hi = nCols;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (edges[mid + 1] <= x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  const first = $derived(Math.max(0, colAt(scrollLeft) - 2));
  const last = $derived(Math.min(nCols, colAt(scrollLeft + viewW - ID_W) + 3));
  const cols = $derived(Array.from({ length: Math.max(0, last - first) }, (_, k) => view.order[first + k]));
  // A column is headed by its ASV — the first bases, the whole sequence (and its
  // md5 feature id) on hover, and a click copies the sequence — or, for a profile,
  // by the genome's name, which a click copies.
  const isAbundance = $derived(table.valueKind === 'relative_abundance');
  // What a header shows and a click copies: an ASV's sequence, or a genome's
  // species (its lineage's lowest named rank) with the genome's accession copied.
  const sequence = (f: number) =>
    table.sequenceOf.get(table.features[f]) ??
    (isAbundance ? genomeLabel(table, table.features[f]) : table.features[f]);
  const copyText = (f: number) => table.sequenceOf.get(table.features[f]) ?? table.features[f];
  const headerTitle = (f: number) =>
    table.sequenceOf.has(table.features[f])
      ? `${sequence(f)}\nmd5 ${table.features[f]}`
      : `${table.features[f]}\n${table.taxonomyOf.get(table.features[f]) ?? 'no taxonomy'}`;
  // An abundance is a percent of the sample.
  const cell = (v: number) =>
    isAbundance
      ? `${v.toLocaleString(undefined, { maximumFractionDigits: v < 0.1 ? 4 : 2 })}%`
      : v.toLocaleString();
  const short = (seq: string) =>
    isAbundance ? (seq.length > 22 ? `${seq.slice(0, 22)}…` : seq) : seq.length > 10 ? `${seq.slice(0, 10)}…` : seq;
  let copied = $state<number | null>(null);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  async function copy(f: number) {
    try {
      await navigator.clipboard.writeText(copyText(f));
    } catch {
      return; // No clipboard (insecure context, or denied): nothing to confirm.
    }
    copied = f;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copied = null), 1200);
  }
</script>

<div>
  <div class="flex items-center justify-between gap-3 px-4 py-3 sm:px-6">
    <span class="text-xs text-gray-400">
      {filtered.length} sample{filtered.length === 1 ? '' : 's'} × {nCols.toLocaleString()} features ·
      {table.s.length.toLocaleString()} observations · {isAbundance
        ? 'relative abundance, as the profiler reported it'
        : 'counts as delivered (not rarefied)'}
    </span>
    <input
      placeholder="Filter..."
      bind:value={query}
      class="w-56 rounded-md border border-gray-300 px-2.5 py-1 text-sm"
    />
  </div>
  <div
    class="overflow-x-auto border-t border-gray-200"
    bind:clientWidth={viewW}
    onscroll={(e) => (scrollLeft = (e.currentTarget as HTMLElement).scrollLeft)}
  >
    <table class="text-sm" style="table-layout:fixed;width:{ID_W + edges[nCols]}px">
      <thead class="bg-gray-50">
        <tr>
          <th
            class="sticky left-0 z-10 bg-gray-50 px-3 py-2 text-left align-top text-xs font-semibold tracking-wide whitespace-nowrap text-gray-500 uppercase"
            style="width:{ID_W}px"
          >
            <!-- Preflight resets text-transform on <button>; restate the header style. -->
            <button
              type="button"
              class="inline-flex items-center gap-1 font-semibold tracking-wide uppercase hover:text-gray-700"
              onclick={() => toggleSort('sample')}
              >{idHeader}<span class="text-gray-400">{sortKey === 'sample' ? (sortDir === 'asc' ? '↑' : '↓') : ''}</span></button
            >
          </th>
          {#if first > 0}<th style="width:{edges[first]}px"></th>{/if}
          {#each cols as f (f)}
            {@const open = expanded.has(f)}
            <th class="p-0 text-left align-top" style="width:{widthOf(f)}px">
              <div class="flex items-start">
                <button
                  type="button"
                  class="min-w-0 flex-1 px-2 py-2 text-left font-mono text-[11px] font-normal {open
                    ? 'whitespace-nowrap text-gray-800 select-text'
                    : 'truncate whitespace-nowrap text-gray-500 hover:text-gray-800'}"
                  title={open ? undefined : headerTitle(f)}
                  aria-expanded={open}
                  onclick={() => toggleExpanded(f)}>{open ? sequence(f) : short(sequence(f))}</button
                >
                <button
                  type="button"
                  class="shrink-0 py-2 pr-1.5 text-[11px] {sortKey === f
                    ? 'text-teal-700'
                    : 'text-gray-300 hover:text-gray-600'}"
                  title="Sort samples by this feature"
                  aria-label="Sort samples by this feature"
                  onclick={() => toggleSort(f)}>{sortKey === f && sortDir === 'asc' ? '↑' : '↓'}</button
                >
              </div>
              {#if open}
                <div class="px-2 pb-2 text-[10px] font-normal whitespace-nowrap text-gray-400">
                  {#if !table.sequenceOf.has(table.features[f])}<div class="font-mono">{table.features[f]}</div>{/if}
                  <button
                    type="button"
                    class="mt-0.5 cursor-copy {copied === f ? 'text-teal-700' : 'text-teal-600 hover:text-teal-800'}"
                    onclick={() => copy(f)}
                    >{copied === f
                      ? 'Copied'
                      : table.sequenceOf.has(table.features[f])
                        ? 'Copy sequence'
                        : 'Copy accession'}</button
                  >
                </div>
              {/if}
            </th>
          {/each}
          {#if last < nCols}<th style="width:{edges[nCols] - edges[last]}px"></th>{/if}
        </tr>
      </thead>
      <tbody class="divide-y divide-gray-100">
        {#each paged as r (r.name)}
          <tr class="hover:bg-gray-50">
            <td class="sticky left-0 z-10 bg-white px-3 py-1.5 font-mono text-xs whitespace-nowrap text-gray-700">
              {r.biosample}{#if r.name !== r.biosample}<span class="ml-1.5 text-gray-400">{r.name}</span>{/if}
            </td>
            {#if first > 0}<td></td>{/if}
            {#each cols as f (f)}
              {@const v = view.bySample[r.s].get(f)}
              <!-- An expanded column is wide; its values sit under the name's start. -->
              <td
                class="px-2 py-1.5 tabular-nums {expanded.has(f) ? 'text-left' : 'text-right'} {v
                  ? 'text-gray-700'
                  : 'text-gray-300'}"
              >
                {v ? cell(v) : '-'}
              </td>
            {/each}
            {#if last < nCols}<td></td>{/if}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  {#if pageCount > 1}
    <div class="flex items-center justify-end gap-2 border-t border-gray-100 px-3 py-2 text-xs text-gray-500">
      <button class="rounded px-2 py-1 ring-1 ring-gray-200 disabled:opacity-40" disabled={clamped === 0} onclick={() => (page = clamped - 1)}>Prev</button>
      <span>Page {clamped + 1} / {pageCount}</span>
      <button class="rounded px-2 py-1 ring-1 ring-gray-200 disabled:opacity-40" disabled={clamped >= pageCount - 1} onclick={() => (page = clamped + 1)}>Next</button>
    </div>
  {/if}
</div>
