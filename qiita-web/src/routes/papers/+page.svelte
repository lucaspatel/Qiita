<script lang="ts">
  // Papers feed (stateless demo): recent metagenomics papers from Europe PMC, newest
  // first, filterable by journal and by whether we detected deposited data. Each paper
  // links to the publisher (read it) and, when it reports ENA/BioProject accessions,
  // imports them straight into the ENA ingestion workflow. Everything is fetched in the
  // browser and cached for an hour; nothing is stored server-side.
  import { fetchRecentPapers, accessionsFor, JOURNAL_FILTERS, richText, type Paper } from '$lib/papers/europepmc';
  import PageHeading from '$lib/ui/PageHeading.svelte';
  import Card from '$lib/ui/Card.svelte';
  import Spinner from '$lib/ui/Spinner.svelte';
  import Select from '$lib/ui/Select.svelte';
  import EnaImportModal from '$lib/ui/EnaImportModal.svelte';

  let days = $state(30);
  let papers = $state<Paper[]>([]);
  let loading = $state(false);
  let err = $state('');
  let loadedFor = -1;

  async function load(force = false) {
    loading = true;
    err = '';
    try {
      papers = await fetchRecentPapers(days, force);
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
      papers = [];
    }
    loading = false;
  }
  // Load on first view and whenever the window changes.
  $effect(() => {
    if (days !== loadedFor) {
      loadedFor = days;
      load();
    }
  });

  // Journal filter: the named venues, all on by default, plus an "Other" escape.
  let enabled = $state<boolean[]>(JOURNAL_FILTERS.map(() => true));
  // Curated by default (Other off): the named venues are the morning list. Turn Other on
  // for everything (most metagenomics is in Frontiers, Sci Reports, IJMS… — now that the
  // fetch is wide and the toggle works, "all journals" actually returns the full volume).
  let showOther = $state(false);
  // Preprints have no journal, so the named-journal chips never match them. They're
  // highly relevant here, so govern them with their own switch, on by default.
  let includePreprints = $state(true);
  let hasDataOnly = $state(true);
  const resetFilters = () => {
    enabled = JOURNAL_FILTERS.map(() => true);
    showOther = true;
    includePreprints = true;
    hasDataOnly = false;
  };

  const matchesJournal = (p: Paper) => {
    if (p.isPreprint) return includePreprints; // no journal — its own switch governs it
    const named = JOURNAL_FILTERS.some((f) => f.test(p.journalNorm));
    const sel = JOURNAL_FILTERS.some((f, i) => enabled[i] && f.test(p.journalNorm));
    return sel || (showOther && !named);
  };
  const hasData = (p: Paper) => p.hasData || p.accessions.length > 0;
  const filtered = $derived(papers.filter((p) => matchesJournal(p) && (!hasDataOnly || hasData(p))));
  const withData = $derived(papers.filter(hasData).length);
  const selectedCount = $derived(enabled.filter(Boolean).length);
  const allOn = $derived(selectedCount === JOURNAL_FILTERS.length && showOther && includePreprints);
  const selectAll = () => (enabled = JOURNAL_FILTERS.map(() => true));
  const selectNone = () => (enabled = JOURNAL_FILTERS.map(() => false));

  // Close the journal dropdown on a click outside it (native <details> stays open).
  let journalMenu = $state<HTMLDetailsElement>();
  $effect(() => {
    const el = journalMenu;
    if (!el) return;
    const onDoc = (e: MouseEvent) => {
      if (el.open && !el.contains(e.target as Node)) el.open = false;
    };
    document.addEventListener('click', onDoc);
    return () => document.removeEventListener('click', onDoc);
  });
  const today = new Date().toISOString().slice(0, 10);

  // Text-mined accessions, fetched (batched) for the papers actually shown and merged
  // with the abstract-detected ones. `accsOf` is a paper's full accession set.
  let anno = $state<Record<string, string[]>>({});
  const tried = new Set<string>();
  const accsOf = (p: Paper) => [...new Set([...p.accessions, ...(anno[p.id] ?? [])])];
  $effect(() => {
    // Annotate every shown paper we haven't tried yet (not just hasData — some papers
    // carry a study accession Europe PMC didn't flag). Capped per pass: cheap on the
    // curated feed, bounded when "Other" opens it to hundreds.
    const todo = filtered.filter((p) => !tried.has(p.id)).slice(0, 150);
    if (!todo.length) return;
    todo.forEach((p) => tried.add(p.id));
    accessionsFor(todo.map((p) => ({ source: p.source, id: p.id }))).then((m) => (anno = { ...anno, ...m }));
  });

  // ENA import, pre-filled from a paper's accessions.
  let enaOpen = $state(false);
  let enaInitial = $state('');
  function importPaper(p: Paper) {
    enaInitial = accsOf(p).join('\n');
    enaOpen = true;
  }
</script>

<PageHeading title="Papers" subtitle="Recent metagenomics papers with public data — read, and import into ENA ingestion.">
  {#snippet actions()}
    <button
      class="rounded-md bg-white px-3 py-1.5 text-sm font-semibold text-gray-700 shadow-xs ring-1 ring-gray-300 ring-inset hover:bg-gray-50 disabled:opacity-50"
      onclick={() => load(true)}
      disabled={loading}>Refresh</button
    >
  {/snippet}
</PageHeading>

<!-- Controls: a standalone bar so the journal dropdown can overflow freely (a Card's
     overflow-hidden would clip it when the list is short). -->
<div class="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg bg-white px-4 py-3 shadow-sm ring-1 ring-gray-200">
    <label class="inline-flex items-center gap-1.5 text-sm text-gray-700">
      <span class="text-gray-500">Window</span>
      <Select bind:value={days} class="w-28">
        {#each [7, 30, 90] as d (d)}<option value={d}>{d} days</option>{/each}
      </Select>
    </label>
    <label class="inline-flex cursor-pointer items-center gap-2 text-sm text-gray-700 select-none">
      <input type="checkbox" class="size-4 rounded border-gray-300 accent-teal-600" bind:checked={hasDataOnly} />
      Has deposited data{#if !loading}<span class="text-gray-400"> ({withData}/{papers.length})</span>{/if}
    </label>
    <!-- Journals: a dropdown multi-toggle (the named venues, all on by default, + Other). -->
    <details bind:this={journalMenu} class="group relative text-sm [&_summary::-webkit-details-marker]:hidden">
      <summary class="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-md bg-white px-3 py-1.5 font-medium text-gray-700 ring-1 ring-gray-300 ring-inset hover:bg-gray-50">
        {allOn ? 'All journals' : 'Journals'} <span class="text-gray-400">({selectedCount}{showOther ? '+other' : ''}/{JOURNAL_FILTERS.length})</span>
        <svg viewBox="0 0 20 20" fill="currentColor" class="size-4 text-gray-400 transition-transform group-open:rotate-180"><path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.168l3.71-3.938a.75.75 0 1 1 1.08 1.04l-4.25 4.5a.75.75 0 0 1-1.08 0l-4.25-4.5a.75.75 0 0 1 .02-1.06Z" clip-rule="evenodd" /></svg>
      </summary>
      <div class="absolute left-0 z-20 mt-1 w-60 rounded-md bg-white p-2 shadow-lg ring-1 ring-gray-200">
        <div class="flex items-center justify-between px-1 pb-1.5 text-xs text-gray-500">
          <span>Show papers in…</span>
          <span class="flex gap-2">
            <button type="button" class="hover:text-gray-900" onclick={selectAll}>All</button>
            <button type="button" class="hover:text-gray-900" onclick={selectNone}>None</button>
          </span>
        </div>
        <div class="max-h-64 overflow-auto">
          {#each JOURNAL_FILTERS as f, i (f.label)}
            <label class="flex cursor-pointer items-center gap-2 rounded px-1 py-1 hover:bg-gray-50">
              <input type="checkbox" class="size-4 rounded border-gray-300 accent-teal-600" bind:checked={enabled[i]} />
              {f.label}
            </label>
          {/each}
          <label class="mt-1 flex cursor-pointer items-center gap-2 rounded border-t border-gray-100 px-1 pt-1.5 text-gray-600 hover:bg-gray-50">
            <input type="checkbox" class="size-4 rounded border-gray-300 accent-teal-600" bind:checked={includePreprints} />
            Preprints
          </label>
          <label class="flex cursor-pointer items-center gap-2 rounded px-1 pb-1 text-gray-600 hover:bg-gray-50">
            <input type="checkbox" class="size-4 rounded border-gray-300 accent-gray-600" bind:checked={showOther} />
            Other journals
          </label>
        </div>
      </div>
    </details>
</div>

<Card bodyClass="">
  {#if loading}
    <div class="flex justify-center py-12"><Spinner /></div>
  {:else if err}
    <div class="px-4 py-10 text-center sm:px-6">
      <p class="text-sm text-red-700">Couldn't load papers: {err}</p>
      <p class="mt-1 text-xs text-gray-400">If this is a CORS error, the feed needs a small proxy (control-plane route) — see PAPERS_FEED.md.</p>
    </div>
  {:else if !filtered.length}
    <div class="px-4 py-12 text-center text-sm text-gray-500 sm:px-6">
      {#if papers.length === 0}
        <p>No metagenomics papers indexed in the last {days} days. Try a longer window.</p>
      {:else}
        <p>{papers.length} papers fetched, but none match your filters{hasDataOnly ? ' with detected data' : ''}.</p>
        <button class="mt-3 rounded-md bg-teal-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-teal-500" onclick={resetFilters}>Show all journals</button>
      {/if}
    </div>
  {:else}
    <ul role="list" class="divide-y divide-gray-100">
      {#each filtered as p (p.id)}
        {@const accs = accsOf(p)}
        <li class="flex items-start justify-between gap-x-6 px-4 py-4 sm:px-6">
          <div class="min-w-0 flex-1">
            <a href={p.url} target="_blank" rel="noopener" class="text-sm/6 font-semibold text-gray-900 hover:text-teal-700">{@html richText(p.title)}</a>
            <!-- authors, under the title -->
            {#if p.authors}<p class="mt-0.5 line-clamp-2 text-xs text-gray-500">{p.authors}</p>{/if}
            <!-- meta: journal · date · pills · links -->
            <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs/5 text-gray-500">
              <span class="font-medium text-gray-700">{p.journal}</span>
              <svg viewBox="0 0 2 2" class="size-0.5 fill-current"><circle r="1" cx="1" cy="1" /></svg>
              <span class="whitespace-nowrap">{p.date || 'undated'}</span>
              {#if p.date === today}<span class="rounded-md bg-amber-50 px-1.5 py-0.5 font-medium text-amber-800 ring-1 ring-amber-600/20 ring-inset">New</span>{/if}
              {#if p.isPreprint}<span class="rounded-md bg-violet-50 px-1.5 py-0.5 font-medium text-violet-700 ring-1 ring-violet-600/20 ring-inset">Preprint</span>{/if}
              {#if p.isOpenAccess}<span class="rounded-md bg-green-50 px-1.5 py-0.5 font-medium text-green-700 ring-1 ring-green-600/20 ring-inset">Open access</span>{/if}
              {#if p.hasData || accs.length}<span class="rounded-md bg-blue-50 px-1.5 py-0.5 font-medium text-blue-700 ring-1 ring-blue-600/20 ring-inset">Data</span>{/if}
            </div>
          </div>
          <!-- direct import only when an accession is actually in hand (the PRJ/ERP chip);
               the modal opens pre-filled. The server enforces auth on submit. -->
          {#if accs.length}
            <button
              class="flex-none rounded-md bg-teal-600 px-2.5 py-1.5 text-sm font-semibold text-white shadow-xs hover:bg-teal-500"
              title="Import {accs.join(', ')} into ENA ingestion"
              onclick={() => importPaper(p)}>Import → ENA</button
            >
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</Card>

<EnaImportModal bind:open={enaOpen} initial={enaInitial} />
