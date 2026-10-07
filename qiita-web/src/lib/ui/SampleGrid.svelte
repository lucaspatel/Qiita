<script lang="ts">
  // Sortable / searchable / paginated view of the sample metadata, hand-rolled
  // with $derived (the @vincjo handler's sort/search didn't apply outside its own
  // components). Owns its Card and mirrors the Sample-metadata card: flush table,
  // sticky first column, search in the header, bordered footer.
  import type { Biosample } from '$lib/api';
  import { humanize } from '$lib/utils';
  import { settings } from '$lib/settings.svelte';
  import Card from '$lib/ui/Card.svelte';

  let { samples, columns }: { samples: Biosample[]; columns: { key: string; label: string }[] } =
    $props();

  function cellText(s: Biosample, key: string): string {
    const f = s.global_metadata?.[key];
    if (!f || f.value == null) return '';
    const v = f.value;
    if (typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (o.kind === 'missing_reason') return String(o.name ?? '(missing)');
      if (o.kind === 'terminology_term') return String(o.label ?? o.term_id ?? '(term)');
      return JSON.stringify(v);
    }
    return String(v);
  }

  type Row = Record<string, string>;
  const allCols = $derived([{ key: 'accession', label: 'Accession' }, ...columns]);
  const rows = $derived<Row[]>(
    samples.map((s) => {
      const row: Row = { accession: s.biosample_accession ?? String(s.biosample_idx) };
      for (const c of columns) row[c.key] = cellText(s, c.key);
      return row;
    })
  );

  const PAGE = 20;
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
      ? rows.filter((r) => allCols.some((c) => (r[c.key] ?? '').toLowerCase().includes(q)))
      : rows;
    if (sortKey) {
      const dir = sortDir === 'asc' ? 1 : -1;
      out = [...out].sort((a, b) => {
        const av = a[sortKey] ?? '';
        const bv = b[sortKey] ?? '';
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
</script>

<Card title="Sample metadata — grid demo" bodyClass="">
  {#snippet actions()}
    <input
      placeholder="filter…"
      bind:value={query}
      class="w-56 rounded-md border border-gray-300 px-2.5 py-1 text-sm"
    />
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
              <button class="inline-flex items-center gap-1 hover:text-gray-700" onclick={() => toggleSort(c.key)}>
                {i === 0 ? 'Accession' : settings.humanizeLabels ? humanize(c.label) : c.label}
                <span class="text-gray-400">{sortKey === c.key ? (sortDir === 'asc' ? '↑' : '↓') : ''}</span>
              </button>
            </th>
          {/each}
        </tr>
      </thead>
      <tbody class="divide-y divide-gray-100">
        {#each paged as row}
          <tr class="hover:bg-gray-50">
            {#each allCols as c, i}
              <td
                class="{i === 0
                  ? 'sticky left-0 z-10 bg-white font-mono text-xs text-gray-700 '
                  : 'text-gray-600 '}px-3 py-2 whitespace-nowrap"
              >{row[c.key] ?? ''}</td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>

  <div class="flex items-center justify-between border-t border-gray-100 px-4 py-2 text-xs text-gray-500">
    <span>
      {filtered.length ? clampedPage * PAGE + 1 : 0}–{Math.min((clampedPage + 1) * PAGE, filtered.length)}
      of {filtered.length}{query ? ` (filtered from ${rows.length})` : ''}
    </span>
    <span class="flex items-center gap-2">
      <button class="rounded border border-gray-300 px-2 py-0.5 hover:bg-gray-50 disabled:opacity-40" onclick={() => (page = Math.max(0, clampedPage - 1))} disabled={clampedPage === 0}>Prev</button>
      <span>Page {clampedPage + 1} / {pageCount}</span>
      <button class="rounded border border-gray-300 px-2 py-0.5 hover:bg-gray-50 disabled:opacity-40" onclick={() => (page = Math.min(pageCount - 1, clampedPage + 1))} disabled={clampedPage >= pageCount - 1}>Next</button>
    </span>
  </div>
</Card>
