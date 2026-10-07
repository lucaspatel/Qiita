<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { auth } from '$lib/auth.svelte';
  import { getRecents, addRecent, removeRecent, type RecentStudy } from '$lib/recents';
  import { api, type StudyAccessionField } from '$lib/api';
  import { settings } from '$lib/settings.svelte';
  import PageHeading from '$lib/ui/PageHeading.svelte';
  import Card from '$lib/ui/Card.svelte';
  import Modal from '$lib/ui/Modal.svelte';
  import Select from '$lib/ui/Select.svelte';

  let recents = $state<RecentStudy[]>([]);
  onMount(() => (recents = getRecents()));

  // --- open a study (by idx or accession) ---
  type OpenMode = 'idx' | StudyAccessionField;
  let openMode = $state<OpenMode>('idx');
  let openValue = $state('');
  let openBusy = $state(false);
  let openMsg = $state('');

  async function openStudy() {
    const v = openValue.trim();
    if (!v) return;
    openMsg = '';
    if (openMode === 'idx') {
      const n = Number(v);
      if (Number.isInteger(n) && n > 0) goto(`/studies/${n}`);
      else openMsg = 'Enter a positive study idx.';
      return;
    }
    openBusy = true;
    const r = await api.lookupStudyByAccession([v], openMode);
    openBusy = false;
    if (!r.ok) {
      openMsg = `HTTP ${r.status} — ${r.detail}`;
      return;
    }
    const idx = r.data.resolved[v];
    if (idx) goto(`/studies/${idx}`);
    else openMsg = `No study with ${openMode.replace('_accession', '')} “${v}”.`;
  }

  // --- create a study (modal) ---
  let createOpen = $state(false);
  let newTitle = $state('');
  let newBioproject = $state('');
  let creating = $state(false);
  let createMsg = $state('');

  async function createStudy() {
    if (!newTitle.trim()) return;
    creating = true;
    createMsg = '';
    const r = await api.createStudy({
      title: newTitle.trim(),
      bioproject_accession: newBioproject.trim() || null
    });
    creating = false;
    if (!r.ok) {
      createMsg = `HTTP ${r.status} — ${r.detail}`;
      return;
    }
    const idx = Number(r.data.study_idx);
    if (settings.rememberRecents)
      addRecent({ idx, accessible: true, biosampleCount: 0, lastOpened: Date.now() });
    createOpen = false;
    goto(`/studies/${idx}`);
  }

  function drop(idx: number) {
    removeRecent(idx);
    recents = getRecents();
  }
</script>

<PageHeading title="Studies" subtitle="Create a study, or open one by id or accession. Load samples from a study's page.">
  {#snippet actions()}
    {#if auth.isSet}
      <button
        class="rounded-md bg-teal-700 px-4 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-teal-600"
        onclick={() => {
          newTitle = '';
          newBioproject = '';
          createMsg = '';
          createOpen = true;
        }}>Create study</button>
    {/if}
  {/snippet}
</PageHeading>

{#if !auth.isSet}
  <Card><p class="py-8 text-center text-gray-500">Log in to create or open a study.</p></Card>
{:else}
  <div class="mb-6">
    <Card title="Open a study">
      <div class="flex flex-wrap items-end gap-2">
        <label class="text-sm">
          <span class="mb-1 block text-gray-500">by</span>
          <Select bind:value={openMode} class="w-48">
            <option value="idx">study idx</option>
            <option value="bioproject_accession">bioproject accession</option>
            <option value="ena_study_accession">ENA accession</option>
          </Select>
        </label>
        <label class="text-sm">
          <span class="mb-1 block text-gray-500">{openMode === 'idx' ? 'idx' : 'accession'}</span>
          <input
            bind:value={openValue}
            placeholder={openMode === 'idx' ? 'e.g. 25006' : openMode === 'bioproject_accession' ? 'PRJNA…' : 'PRJEB…'}
            onkeydown={(e: KeyboardEvent) => e.key === 'Enter' && openStudy()}
            class="w-56 rounded-md border border-gray-300 px-3 py-1.5 text-sm"
          />
        </label>
        <button
          class="rounded-md bg-white px-4 py-1.5 text-sm font-semibold text-teal-700 ring-1 ring-teal-600/30 ring-inset hover:bg-teal-50 disabled:opacity-50"
          onclick={openStudy}
          disabled={!openValue.trim() || openBusy}>{openBusy ? 'Opening…' : 'Open'}</button>
      </div>
      {#if openMsg}<p class="mt-2 text-sm text-amber-700">{openMsg}</p>{/if}
    </Card>
  </div>

  <Card title="Recent studies" bodyClass="">
    {#if recents.length}
      <table class="min-w-full divide-y divide-gray-200 text-sm">
        <thead class="bg-gray-50">
          <tr>
            {#each ['Study', 'Access', 'Biosamples', 'Opened', ''] as h}
              <th class="px-4 py-2 text-left text-xs font-semibold tracking-wide text-gray-500 uppercase">{h}</th>
            {/each}
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-100">
          {#each recents as r (r.idx)}
            <tr class="hover:bg-gray-50">
              <td class="px-4 py-2 font-medium">
                <a href="/studies/{r.idx}" class="text-teal-700 hover:underline">Study {r.idx}</a>
              </td>
              <td class="px-4 py-2">
                {#if r.accessible}
                  <span class="inline-flex items-center rounded-md bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700 ring-1 ring-green-600/20 ring-inset">accessible</span>
                {:else}
                  <span class="inline-flex items-center rounded-md bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 ring-1 ring-amber-600/20 ring-inset">restricted</span>
                {/if}
              </td>
              <td class="px-4 py-2 text-gray-600">{r.biosampleCount ?? '—'}</td>
              <td class="px-4 py-2 text-gray-500">{new Date(r.lastOpened).toLocaleString()}</td>
              <td class="px-4 py-2 text-right">
                <button class="text-xs text-gray-400 hover:text-red-600" onclick={() => drop(r.idx)}>remove</button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {:else}
      <p class="px-4 py-8 text-center text-gray-500">No studies yet — create one or open one above.</p>
    {/if}
  </Card>
{/if}

<Modal bind:open={createOpen} title="Create a study">
  <div class="space-y-3">
    <label class="block text-sm">
      <span class="mb-1 block text-gray-500">Title</span>
      <input
        bind:value={newTitle}
        placeholder="Study title"
        onkeydown={(e: KeyboardEvent) => e.key === 'Enter' && createStudy()}
        class="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
      />
    </label>
    <label class="block text-sm">
      <span class="mb-1 block text-gray-500">Bioproject accession <span class="text-gray-400">(optional)</span></span>
      <input
        bind:value={newBioproject}
        placeholder="PRJNA…"
        class="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
      />
    </label>
    {#if createMsg}<p class="text-sm text-amber-700">{createMsg}</p>{/if}
    <div class="flex justify-end gap-2 pt-2">
      <button class="rounded-md bg-white px-3 py-1.5 text-sm font-semibold text-gray-700 ring-1 ring-gray-300 ring-inset hover:bg-gray-50" onclick={() => (createOpen = false)}>Cancel</button>
      <button
        class="rounded-md bg-teal-700 px-4 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-teal-600 disabled:opacity-50"
        onclick={createStudy}
        disabled={!newTitle.trim() || creating}>{creating ? 'Creating…' : 'Create & open'}</button>
    </div>
  </div>
</Modal>
