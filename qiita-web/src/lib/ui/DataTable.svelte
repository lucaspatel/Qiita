<script lang="ts">
  // Generic filter / sort / paginate table. Columns + plain row objects; the first
  // column is treated as the sticky index. An optional `actions` snippet renders a
  // trailing cell per row (e.g. a state chip + button). Modeled on SampleGrid's
  // sort/filter/paginate logic — a candidate to back SampleGrid itself later.
  import type { Snippet } from 'svelte';

  type Col = { key: string; label: string };
  type Row = Record<string, unknown>;

  let {
    columns,
    rows,
    pageSize = 25,
    filterPlaceholder = 'Filter...',
    actions,
    visibleRows = $bindable([])
  }: {
    columns: Col[];
    rows: Row[];
    pageSize?: number;
    filterPlaceholder?: string;
    actions?: Snippet<[Row]>;
    /** Out: the rows passing the filter, in display order, for a companion view. */
    visibleRows?: Row[];
  } = $props();

  let query = $state('');
  let sortKey = $state('');
  let sortDir = $state<'asc' | 'desc'>('asc');
  let page = $state(0);

  function toggleSort(key: string) {
    sortDir = sortKey === key && sortDir === 'asc' ? 'desc' : 'asc';
    sortKey = key;
  }

  const text = (r: Row, k: string) => {
    const v = r[k];
    return v == null ? '' : String(v);
  };

  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase();
    let out = q
      ? rows.filter((r) => columns.some((c) => text(r, c.key).toLowerCase().includes(q)))
      : rows;
    if (sortKey) {
      const dir = sortDir === 'asc' ? 1 : -1;
      out = [...out].sort((a, b) => {
        const av = text(a, sortKey);
        const bv = text(b, sortKey);
        const an = Number(av);
        const bn = Number(bv);
        const numeric = av !== '' && bv !== '' && Number.isFinite(an) && Number.isFinite(bn);
        return (numeric ? an - bn : av.localeCompare(bv)) * dir;
      });
    }
    return out;
  });

  $effect(() => {
    visibleRows = filtered;
  });
  const pageCount = $derived(Math.max(1, Math.ceil(filtered.length / pageSize)));
  const clampedPage = $derived(Math.min(page, pageCount - 1));
  const paged = $derived(filtered.slice(clampedPage * pageSize, clampedPage * pageSize + pageSize));
  $effect(() => {
    query;
    page = 0;
  });

  const display = (v: unknown) =>
    v == null ? '—' : typeof v === 'number' ? v.toLocaleString() : String(v);
</script>

<div>
  <div class="flex items-center justify-between gap-3 px-4 py-3 sm:px-6">
    <span class="text-xs text-gray-400">{filtered.length} row{filtered.length === 1 ? '' : 's'}</span>
    <input
      placeholder={filterPlaceholder}
      bind:value={query}
      class="w-56 rounded-md border border-gray-300 px-2.5 py-1 text-sm"
    />
  </div>
  <div class="overflow-x-auto border-t border-gray-200">
    <table class="min-w-full divide-y divide-gray-200 text-sm">
      <thead class="bg-gray-50">
        <tr>
          {#each columns as c, i (c.key)}
            <th class="{i === 0 ? 'sticky left-0 z-10 bg-gray-50 ' : ''}px-3 py-2 text-left">
              <button
                class="inline-flex items-center gap-1 text-xs font-semibold tracking-wide text-gray-500 uppercase hover:text-gray-700"
                onclick={() => toggleSort(c.key)}
              >
                {c.label}
                <span class="text-gray-400"
                  >{sortKey === c.key ? (sortDir === 'asc' ? '↑' : '↓') : ''}</span
                >
              </button>
            </th>
          {/each}
          {#if actions}<th class="px-3 py-2"></th>{/if}
        </tr>
      </thead>
      <tbody class="divide-y divide-gray-100">
        {#each paged as r (r)}
          <tr class="hover:bg-gray-50">
            {#each columns as c, j (c.key)}
              <td
                class="{j === 0
                  ? 'sticky left-0 z-10 bg-white font-mono text-xs text-gray-800 '
                  : 'text-gray-700 '}px-3 py-2 whitespace-nowrap">{display(r[c.key])}</td
              >
            {/each}
            {#if actions}<td class="px-3 py-2 text-right whitespace-nowrap">{@render actions(r)}</td
              >{/if}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  {#if pageCount > 1}
    <div
      class="flex items-center justify-end gap-2 border-t border-gray-100 px-3 py-2 text-xs text-gray-500"
    >
      <button
        class="rounded border border-gray-300 px-2 py-0.5 hover:bg-gray-50 disabled:opacity-40"
        onclick={() => (page = Math.max(0, clampedPage - 1))}
        disabled={clampedPage === 0}>Prev</button
      >
      <span>Page {clampedPage + 1} / {pageCount}</span>
      <button
        class="rounded border border-gray-300 px-2 py-0.5 hover:bg-gray-50 disabled:opacity-40"
        onclick={() => (page = Math.min(pageCount - 1, clampedPage + 1))}
        disabled={clampedPage >= pageCount - 1}>Next</button
      >
    </div>
  {/if}
</div>
