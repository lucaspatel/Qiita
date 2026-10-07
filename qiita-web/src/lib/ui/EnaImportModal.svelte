<script lang="ts">
  import { api, type EnaImportBatch } from '$lib/api';
  import {
    parseAccessionText,
    STUDY_PREFIXES,
    BATCH_STATE_CLASS,
    RUN_STATUS_CLASS,
    badgeClass,
    isTerminal
  } from '$lib/ena';
  import Modal from './Modal.svelte';
  import DropZone from './DropZone.svelte';

  let { open = $bindable(false) }: { open?: boolean } = $props();

  let mode = $state<'compose' | 'status'>('compose');
  let text = $state('');
  let fileName = $state('');
  let submitting = $state(false);
  let loading = $state(false);
  let errMsg = $state('');
  let batch = $state<EnaImportBatch | null>(null);
  let lastRefreshed = $state('');

  const parsed = $derived(parseAccessionText(text));
  const canSubmit = $derived(
    parsed.accessions.length > 0 && parsed.errors.length === 0 && !submitting
  );
  const allTerminal = $derived(!!batch && batch.items.every((i) => isTerminal(i.state)));

  // Initialize on each open: a recent idx → jump to its status; else a fresh compose.
  let wasOpen = false;
  $effect(() => {
    if (open && !wasOpen) {
      errMsg = '';
      mode = 'compose';
      text = '';
      fileName = '';
      batch = null;
    }
    wasOpen = open;
  });

  async function onFile(f: File) {
    fileName = f.name;
    text = await f.text();
  }

  function stamp() {
    lastRefreshed = new Date().toLocaleTimeString();
  }

  async function submit() {
    submitting = true;
    errMsg = '';
    const r = await api.submitEnaImport(parsed.accessions);
    submitting = false;
    if (!r.ok) {
      errMsg = `HTTP ${r.status} — ${r.detail}`;
      return;
    }
    batch = r.data;
    mode = 'status';
    stamp();
  }

  async function loadStatus(idx: number) {
    loading = true;
    errMsg = '';
    const r = await api.enaImportStatus(idx);
    loading = false;
    if (!r.ok) {
      errMsg = `HTTP ${r.status} — ${r.detail}`;
      batch = null;
      return;
    }
    batch = r.data;
    stamp();
  }

  function newImport() {
    mode = 'compose';
    text = '';
    fileName = '';
    batch = null;
    errMsg = '';
  }
</script>

<Modal bind:open title="Import from ENA (INSDC)">
  {#if mode === 'compose'}
    <div class="space-y-3">
      <p class="text-sm text-gray-600">
        Pull a public INSDC/ENA study into Qiita by accession — reads plus harmonized
        metadata. One <strong>study</strong> accession per line ({STUDY_PREFIXES.join(', ')}…);
        run and sample accessions are refused. Admin-only (wet-lab or system).
      </p>

      <label class="block text-sm">
        <span class="mb-1 block text-gray-500">Study accessions</span>
        <textarea
          bind:value={text}
          rows="6"
          placeholder={'PRJEB11419\nPRJNA000000\n# comments and blank lines are ignored'}
          class="w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-sm"
        ></textarea>
      </label>

      <div class="text-sm">
        <span class="mb-1 block text-gray-500">…or upload a list (.txt, one per line)</span>
        <DropZone accept=".txt" {fileName} onfile={onFile} />
      </div>

      {#if text.trim()}
        <div class="rounded-md bg-gray-50 p-3 text-sm">
          <p class="text-gray-700">
            <span class="font-semibold">{parsed.accessions.length}</span> valid accession{parsed
              .accessions.length === 1
              ? ''
              : 's'}
            {#if parsed.errors.length}
              · <span class="font-semibold text-red-700">{parsed.errors.length} rejected</span>
            {/if}
          </p>
          {#if parsed.errors.length}
            <ul class="mt-1 list-inside list-disc text-red-700">
              {#each parsed.errors as e}<li>{e}</li>{/each}
            </ul>
            <p class="mt-1 text-xs text-gray-500">
              A single malformed accession rejects the whole batch at submit — fix these first.
            </p>
          {/if}
        </div>
      {/if}

      {#if errMsg}<p class="text-sm text-red-700">{errMsg}</p>{/if}

      <div class="flex justify-end gap-2 pt-1">
        <button
          class="rounded-md bg-white px-3 py-1.5 text-sm font-semibold text-gray-700 ring-1 ring-gray-300 ring-inset hover:bg-gray-50"
          onclick={() => (open = false)}>Cancel</button
        >
        <button
          class="rounded-md bg-teal-700 px-4 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-teal-600 disabled:opacity-50"
          onclick={submit}
          disabled={!canSubmit}
          >{submitting ? 'Submitting…' : `Import ${parsed.accessions.length || ''}`.trim()}</button
        >
      </div>
    </div>
  {:else}
    <!-- status: a table you Refresh, same shape as the Jobs view -->
    <div class="space-y-3">
      <div class="flex items-center justify-between">
        <div class="text-sm text-gray-700">
          {#if batch}
            <span class="font-semibold">Batch #{batch.ena_import_batch_idx}</span>
            {#if allTerminal}
              <span class="ml-2 text-green-700">· all items terminal</span>
            {:else}
              <span class="ml-2 text-blue-700">· working…</span>
            {/if}
          {/if}
          {#if lastRefreshed}<span class="ml-2 text-xs text-gray-400"
              >refreshed {lastRefreshed}</span
            >{/if}
        </div>
        <button
          class="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-teal-700 ring-1 ring-teal-600/30 ring-inset hover:bg-teal-50 disabled:opacity-40"
          onclick={() => batch && loadStatus(batch.ena_import_batch_idx)}
          disabled={loading || !batch}>{loading ? 'Refreshing…' : 'Refresh'}</button
        >
      </div>

      {#if errMsg}<p class="text-sm text-red-700">{errMsg}</p>{/if}

      {#if batch}
        <div class="overflow-x-auto">
          <table class="min-w-full divide-y divide-gray-200 text-sm">
            <thead class="bg-gray-50">
              <tr>
                {#each ['Accession', 'State', 'Study', 'Downloads', 'Runs'] as h}
                  <th
                    class="px-3 py-2 text-left text-xs font-semibold tracking-wide whitespace-nowrap text-gray-500 uppercase"
                    >{h}</th
                  >
                {/each}
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-100">
              {#each batch.items as it (it.ena_study_accession)}
                <tr class="align-top hover:bg-gray-50">
                  <td class="px-3 py-2 font-mono whitespace-nowrap text-gray-800"
                    >{it.ena_study_accession}</td
                  >
                  <td class="px-3 py-2">
                    <span
                      class="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium capitalize ring-1 ring-inset {badgeClass(
                        BATCH_STATE_CLASS,
                        it.state
                      )}">{it.state}</span
                    >
                    {#if it.failure_reason}
                      <p class="mt-1 max-w-xs text-xs text-red-700">{it.failure_reason}</p>
                    {/if}
                  </td>
                  <td class="px-3 py-2 whitespace-nowrap">
                    {#if it.study_idx != null}
                      <a href="/studies/{it.study_idx}" class="text-teal-700 hover:underline"
                        >#{it.study_idx}</a
                      >
                    {:else}<span class="text-gray-400">—</span>{/if}
                  </td>
                  <td class="px-3 py-2 whitespace-nowrap">
                    {#if it.download_work_ticket_idxs.length}
                      {#each it.download_work_ticket_idxs as wt, i}<a
                          href="/tickets/{wt}"
                          class="text-teal-700 hover:underline">#{wt}</a
                        >{#if i < it.download_work_ticket_idxs.length - 1}<span
                            class="text-gray-400">, </span
                          >{/if}{/each}
                    {:else}<span class="text-gray-400">—</span>{/if}
                  </td>
                  <td class="px-3 py-2">
                    {#if it.ena_runs.length}
                      <details>
                        <summary class="cursor-pointer text-xs text-gray-600"
                          >{it.ena_runs.length} run{it.ena_runs.length === 1 ? '' : 's'}</summary
                        >
                        <ul class="mt-1 space-y-0.5">
                          {#each it.ena_runs as run}
                            <li class="flex items-center gap-2 text-xs">
                              <span class="font-mono text-gray-700">{run.run_accession}</span>
                              <span
                                class="inline-flex items-center rounded px-1.5 py-0.5 font-medium ring-1 ring-inset {badgeClass(
                                  RUN_STATUS_CLASS,
                                  run.status
                                )}">{run.status.replace(/_/g, ' ')}</span
                              >
                            </li>
                          {/each}
                        </ul>
                      </details>
                    {:else}<span class="text-gray-400">—</span>{/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        {#if !allTerminal}
          <p class="text-xs text-gray-500">
            Items advance in the background. Press Refresh to see the latest — spawned download
            jobs also appear under <a href="/tickets" class="text-teal-700 hover:underline">Jobs</a>.
          </p>
        {/if}
      {:else if loading}
        <p class="py-6 text-center text-gray-500">Loading…</p>
      {/if}

      <div class="flex justify-end gap-2 pt-1">
        <button
          class="rounded-md bg-white px-3 py-1.5 text-sm font-semibold text-gray-700 ring-1 ring-gray-300 ring-inset hover:bg-gray-50"
          onclick={newImport}>New import</button
        >
        <button
          class="rounded-md bg-teal-700 px-4 py-1.5 text-sm font-semibold text-white hover:bg-teal-600"
          onclick={() => (open = false)}>Close</button
        >
      </div>
    </div>
  {/if}
</Modal>
