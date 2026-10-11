<script lang="ts">
  // The caller's studies from GET /study. "Mine" (the default) is their own and
  // shared studies — min_tier=viewer — since on a deploy with many public
  // studies those otherwise bury the few a person works on; "Include public"
  // lists everything they can read. `unsupported` turns true on a server that
  // predates the route — 405, since POST /study shares the path (404 if not) —
  // so the page can fall back to its recents list.
  import { api, type StudySummary } from '$lib/api';
  import Card from './Card.svelte';

  let { unsupported = $bindable(false) }: { unsupported?: boolean } = $props();

  const PAGE = 10;
  let scope = $state<'mine' | 'all'>('mine');
  let query = $state('');
  let rows = $state<StudySummary[]>([]);
  // Cursor pages: `starts[i]` is the after_study_idx that opens page i (undefined
  // for the first); `next` opens the page after this one, null at the end.
  let starts = $state<(number | undefined)[]>([undefined]);
  let pageNo = $state(0);
  let next = $state<number | null>(null);
  let loading = $state(false);
  let error = $state('');
  let seq = 0;

  async function load(page: number) {
    const mine = ++seq;
    loading = true;
    error = '';
    const r = await api.studies({
      q: query.trim() || undefined,
      min_tier: scope === 'mine' ? 'viewer' : undefined,
      after_study_idx: starts[page],
      limit: PAGE
    });
    if (mine !== seq) return; // a newer page/search/scope superseded this one
    loading = false;
    if (!r.ok) {
      if (r.status === 405 || r.status === 404) unsupported = true;
      else error = `HTTP ${r.status} — ${r.detail}`;
      return;
    }
    rows = r.data.studies;
    pageNo = page;
    next = r.data.next_after_study_idx;
    if (next != null) starts[page + 1] = next;
  }

  function reset() {
    starts = [undefined];
    next = null;
    load(0);
  }

  // Reload on scope change, and on search after a short pause in typing.
  let timer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    scope;
    query;
    clearTimeout(timer);
    timer = setTimeout(reset, 250);
    return () => clearTimeout(timer);
  });

  function access(s: StudySummary): { label: string; cls: string } {
    switch (s.access_via) {
      case 'owner':
        return { label: 'owner', cls: 'bg-teal-50 text-teal-700 ring-teal-600/20' };
      case 'grant':
        return { label: s.caller_tier, cls: 'bg-blue-50 text-blue-700 ring-blue-600/20' };
      case 'public':
        return { label: 'public', cls: 'bg-gray-50 text-gray-600 ring-gray-500/10' };
      case 'role':
        return { label: 'by role', cls: 'bg-purple-50 text-purple-700 ring-purple-600/20' };
    }
  }
</script>

{#if !unsupported}
  <Card title="Your studies" bodyClass="">
    {#snippet actions()}
      <div class="flex min-w-0 flex-1 items-center justify-end gap-2 sm:flex-none">
        <input
          placeholder="search…"
          bind:value={query}
          class="w-full min-w-0 rounded-md border border-gray-300 px-2.5 py-1 text-sm sm:w-56"
        />
        <span class="inline-flex shrink-0 rounded-md shadow-sm ring-1 ring-gray-300 ring-inset">
          {#each [['mine', 'Mine'], ['all', 'Public too']] as [value, label]}
            <button
              class="px-3 py-1 text-sm font-medium whitespace-nowrap first:rounded-l-md last:rounded-r-md {scope === value
                ? 'bg-teal-700 text-white'
                : 'bg-white text-gray-700 hover:bg-gray-50'}"
              aria-pressed={scope === value}
              onclick={() => (scope = value as 'mine' | 'all')}>{label}</button
            >
          {/each}
        </span>
      </div>
    {/snippet}

    {#if error}
      <p class="px-4 py-6 text-center text-red-700">{error}</p>
    {:else if rows.length}
      <table class="min-w-full divide-y divide-gray-200 text-sm">
        <thead class="bg-gray-50">
          <tr>
            {#each [['Study', ''], ['Accession', 'hidden sm:table-cell'], ['Your access', ''], ['Updated', 'hidden sm:table-cell']] as [h, cls]}
              <th class="px-4 py-2 text-left text-xs font-semibold tracking-wide whitespace-nowrap text-gray-500 uppercase {cls}">{h}</th>
            {/each}
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-100">
          {#each rows as s (s.study_idx)}
            {@const a = access(s)}
            <tr class="hover:bg-gray-50">
              <td class="px-4 py-2">
                <a href="/studies/{s.study_idx}" class="font-medium text-teal-700 hover:underline">{s.title}</a>
                <span class="block text-xs text-gray-400">#{s.study_idx}{s.alias ? ` · ${s.alias}` : ''}</span>
              </td>
              <td class="hidden px-4 py-2 font-mono text-xs whitespace-nowrap text-gray-600 sm:table-cell">
                {s.bioproject_accession ?? s.ena_study_accession ?? '—'}
              </td>
              <td class="px-4 py-2">
                <span class="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium capitalize ring-1 ring-inset {a.cls}">{a.label}</span>
              </td>
              <td class="hidden px-4 py-2 whitespace-nowrap text-gray-500 sm:table-cell">{new Date(s.updated_at).toLocaleDateString()}</td>
            </tr>
          {/each}
        </tbody>
      </table>
      <div class="flex items-center justify-between border-t border-gray-100 px-4 py-2 text-xs text-gray-500">
        <span>Page {pageNo + 1}{next == null ? ' · end of list' : ''}</span>
        <span class="flex gap-2">
          <button
            class="rounded border border-gray-300 px-2 py-0.5 hover:bg-gray-50 disabled:opacity-40"
            onclick={() => load(pageNo - 1)}
            disabled={loading || pageNo === 0}>Previous</button
          >
          <button
            class="rounded border border-gray-300 px-2 py-0.5 hover:bg-gray-50 disabled:opacity-40"
            onclick={() => load(pageNo + 1)}
            disabled={loading || next == null}>{loading ? 'Loading…' : 'Next'}</button
          >
        </span>
      </div>
    {:else if loading}
      <p class="px-4 py-8 text-center text-gray-500">Loading…</p>
    {:else if next != null}
      <!-- A short page can be empty yet not the last (the server filtered a batch). -->
      <p class="px-4 py-8 text-center text-gray-500">
        Nothing on this page — <button class="text-teal-700 hover:underline" onclick={() => load(pageNo + 1)}>next page</button>
      </p>
    {:else}
      <p class="px-4 py-8 text-center text-gray-500">
        {#if query.trim()}No studies match “{query.trim()}”.{:else if scope === 'mine'}
          Nothing of your own or shared with you yet —
          <button class="text-teal-700 hover:underline" onclick={() => (scope = 'all')}>include public studies</button>.
        {:else}No studies you can read.{/if}
      </p>
    {/if}
  </Card>
{/if}
