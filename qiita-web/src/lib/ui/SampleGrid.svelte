<script lang="ts">
  // Sortable / searchable / paginated view of the sample metadata, hand-rolled
  // with $derived (the @vincjo handler's sort/search didn't apply outside its own
  // components). Owns its Card and mirrors the Sample-metadata card: flush table,
  // sticky first column, search + Map in the header, bordered footer. The map
  // shows the rows that pass the current filter.
  import type { Biosample } from '$lib/api';
  import { humanize } from '$lib/utils';
  import { settings } from '$lib/settings.svelte';
  import { cellText, geoPoints, sampleLabel, type Column } from '$lib/samples';
  import Card from '$lib/ui/Card.svelte';
  import GeoMap from '$lib/ui/GeoMap.svelte';
  import Modal from '$lib/ui/Modal.svelte';

  // `total` and `loading` let the grid render while samples stream in.
  let {
    samples,
    columns,
    total = samples.length,
    loading = false
  }: { samples: Biosample[]; columns: Column[]; total?: number; loading?: boolean } = $props();

  // Each row keeps its sample so the filtered set can feed the map.
  type Row = { sample: Biosample; cells: Record<string, string> };
  const allCols = $derived([{ key: 'accession', label: 'Accession' }, ...columns]);
  const rows = $derived<Row[]>(
    samples.map((s) => {
      const cells: Record<string, string> = { accession: sampleLabel(s) };
      for (const c of columns) cells[c.key] = cellText(s, c.key);
      return { sample: s, cells };
    })
  );

  const PAGE = 50;
  let query = $state('');
  let sortKey = $state('');
  let sortDir = $state<'asc' | 'desc'>('asc');
  let page = $state(0);

  function toggleSort(key: string) {
    sortDir = sortKey === key && sortDir === 'asc' ? 'desc' : 'asc';
    sortKey = key;
  }

  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase();
    let out = q
      ? rows.filter((r) => allCols.some((c) => (r.cells[c.key] ?? '').toLowerCase().includes(q)))
      : rows;
    if (sortKey) {
      const dir = sortDir === 'asc' ? 1 : -1;
      out = [...out].sort((a, b) => {
        const av = a.cells[sortKey] ?? '';
        const bv = b.cells[sortKey] ?? '';
        const an = Number(av);
        const bn = Number(bv);
        const numeric = av !== '' && bv !== '' && Number.isFinite(an) && Number.isFinite(bn);
        return (numeric ? an - bn : av.localeCompare(bv)) * dir;
      });
    }
    return out;
  });

  const pageCount = $derived(Math.max(1, Math.ceil(filtered.length / PAGE)));
  const clampedPage = $derived(Math.min(page, pageCount - 1));
  const paged = $derived(filtered.slice(clampedPage * PAGE, clampedPage * PAGE + PAGE));
  $effect(() => {
    query;
    page = 0;
  });

  let mapOpen = $state(false);
  const points = $derived(geoPoints(filtered.map((r) => r.sample)));
</script>

<Card title="Sample metadata" bodyClass="">
  {#snippet actions()}
    <div class="flex items-center gap-3">
      <input
        placeholder="filter…"
        bind:value={query}
        class="w-56 rounded-md border border-gray-300 px-2.5 py-1 text-sm"
      />
      <button
        class="rounded-md bg-white px-3 py-1 text-sm font-medium text-teal-700 ring-1 ring-teal-600/30 ring-inset hover:bg-teal-50 disabled:opacity-40"
        onclick={() => (mapOpen = true)}
        disabled={!points.length}>Map ({points.length})</button
      >
    </div>
  {/snippet}

  <div class="overflow-x-auto">
    <table class="min-w-full divide-y divide-gray-200 text-sm">
      <thead class="bg-gray-50">
        <tr>
          {#each allCols as c, i}
            <th
              class="{i === 0
                ? 'sticky left-0 z-10 bg-gray-50 '
                : ''}px-3 py-2 text-left text-xs font-semibold tracking-wide whitespace-nowrap text-gray-500 uppercase"
            >
              <!-- Preflight resets text-transform on <button>; restate the header style. -->
              <button
                class="inline-flex items-center gap-1 font-semibold tracking-wide uppercase hover:text-gray-700"
                onclick={() => toggleSort(c.key)}
              >
                {i === 0 ? 'Accession' : settings.humanizeLabels ? humanize(c.label) : c.label}
                <span class="text-gray-400">{sortKey === c.key ? (sortDir === 'asc' ? '↑' : '↓') : ''}</span>
              </button>
            </th>
          {/each}
        </tr>
      </thead>
      <tbody class="divide-y divide-gray-100">
        {#each paged as row (row.sample.biosample_idx)}
          <tr class="hover:bg-gray-50">
            {#each allCols as c, i}
              <td
                class="{i === 0
                  ? 'sticky left-0 z-10 bg-white font-mono text-xs text-gray-700 '
                  : 'text-gray-600 '}px-3 py-2 whitespace-nowrap"
              >{row.cells[c.key] || (i === 0 ? '' : '—')}</td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>

  <div class="flex items-center justify-between border-t border-gray-100 px-4 py-2 text-xs text-gray-500">
    <span>
      {#if loading}Loading {samples.length} of {total}…{:else}
      {filtered.length ? clampedPage * PAGE + 1 : 0}–{Math.min((clampedPage + 1) * PAGE, filtered.length)}
      of {filtered.length}{query ? ` (filtered from ${rows.length})` : ''}
      {/if}
    </span>
    <span class="flex items-center gap-2">
      <button class="rounded border border-gray-300 px-2 py-0.5 hover:bg-gray-50 disabled:opacity-40" onclick={() => (page = Math.max(0, clampedPage - 1))} disabled={clampedPage === 0}>Prev</button>
      <span>Page {clampedPage + 1} / {pageCount}</span>
      <button class="rounded border border-gray-300 px-2 py-0.5 hover:bg-gray-50 disabled:opacity-40" onclick={() => (page = Math.min(pageCount - 1, clampedPage + 1))} disabled={clampedPage >= pageCount - 1}>Next</button>
    </span>
  </div>
</Card>

<Modal
  bind:open={mapOpen}
  title="Geographic distribution — {points.length} samples{query ? ` matching “${query}”` : ''}"
>
  <GeoMap {points} />
</Modal>
