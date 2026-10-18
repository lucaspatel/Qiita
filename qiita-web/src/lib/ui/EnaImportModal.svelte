<script lang="ts">
  import { api, type EnaImportBatch } from '$lib/api';
  import {
    parseAccessionText,
    STUDY_PREFIXES,
    BATCH_STATE_CLASS,
    RUN_STATUS_CLASS,
    badgeClass,
    isTerminal,
    groupRuns,
    groupWarnings,
    statusCounts
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

  // A failure reason longer than this is clamped to two lines behind "show all".
  const LONG_REASON = 160;
  // Run accessions listed per group before "+N more".
  const ACCESSIONS_SHOWN = 6;
  // Keys of the reasons and accession lists the viewer has expanded.
  let expanded = $state<Record<string, boolean>>({});
  const toggle = (key: string) => (expanded[key] = !expanded[key]);
  const label = (status: string) => status.replace(/_/g, ' ');
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

  function reset() {
    mode = 'compose';
    text = '';
    fileName = '';
    batch = null;
    errMsg = '';
    expanded = {};
  }

  // Reset to a fresh compose each time the modal opens.
  let wasOpen = false;
  $effect(() => {
    if (open && !wasOpen) reset();
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

  async function loadStatus() {
    if (!batch) return;
    loading = true;
    errMsg = '';
    const r = await api.enaImportStatus(batch.ena_import_batch_idx);
    loading = false;
    if (!r.ok) {
      errMsg = `HTTP ${r.status} — ${r.detail}`;
      batch = null;
      return;
    }
    batch = r.data;
    stamp();
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
          >{submitting
            ? 'Submitting…'
            : parsed.accessions.length
              ? `Import ${parsed.accessions.length}`
              : 'Import'}</button
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
          onclick={loadStatus}
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
                  <td class="min-w-52 px-3 py-2">
                    <span
                      class="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium capitalize ring-1 ring-inset {badgeClass(
                        BATCH_STATE_CLASS,
                        it.state
                      )}">{it.state}</span
                    >
                    {#if it.failure_reason}
                      {@const key = `reason:${it.ena_study_accession}`}
                      <p
                        class="mt-1 max-w-xs text-xs break-words text-red-700 {expanded[key]
                          ? 'max-h-60 overflow-y-auto'
                          : 'line-clamp-2'}"
                      >
                        {it.failure_reason}
                      </p>
                      {#if it.failure_reason.length > LONG_REASON}
                        <button
                          type="button"
                          class="text-xs text-teal-700 hover:underline"
                          onclick={() => toggle(key)}>{expanded[key] ? 'show less' : 'show all'}</button
                        >
                      {/if}
                    {:else if it.state === 'failed'}
                      <p class="mt-1 max-w-xs text-xs text-red-700">No reason recorded.</p>
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
                  <td class="min-w-64 px-3 py-2">
                    {#if it.ena_runs.length}
                      {@const warnings = groupWarnings(it.ena_runs)}
                      {@const warned = it.ena_runs.filter((r) => r.metadata_warnings?.length).length}
                      <details>
                        <summary class="cursor-pointer text-xs text-gray-600">
                          {plural(it.ena_runs.length, 'run')}
                          {#each statusCounts(it.ena_runs) as [status, n] (status)}
                            <span
                              class="ml-1 inline-flex items-center rounded px-1.5 py-0.5 font-medium ring-1 ring-inset {badgeClass(
                                RUN_STATUS_CLASS,
                                status
                              )}">{n} {label(status)}</span
                            >
                          {/each}
                          {#if warned}
                            <span
                              class="ml-1 inline-flex items-center rounded bg-amber-50 px-1.5 py-0.5 font-medium text-amber-800 ring-1 ring-amber-600/20 ring-inset"
                              >{warned} with warnings</span
                            >
                          {/if}
                        </summary>
                        <ul class="mt-2 space-y-2">
                          {#each groupRuns(it.ena_runs) as group (group.status + (group.reason ?? ''))}
                            {@const key = `runs:${it.ena_study_accession}:${group.status}:${group.reason ?? ''}`}
                            {@const shown = expanded[key]
                              ? group.accessions
                              : group.accessions.slice(0, ACCESSIONS_SHOWN)}
                            <li class="text-xs">
                              <span
                                class="inline-flex items-center rounded px-1.5 py-0.5 font-medium ring-1 ring-inset {badgeClass(
                                  RUN_STATUS_CLASS,
                                  group.status
                                )}">{label(group.status)}</span
                              >
                              <span class="ml-1 text-gray-600">{plural(group.accessions.length, 'run')}</span>
                              {#if group.reason}
                                <p class="mt-0.5 break-words text-gray-700">{group.reason}</p>
                              {/if}
                              <p
                                class="mt-0.5 font-mono break-words text-gray-500 {expanded[key]
                                  ? 'max-h-40 overflow-y-auto'
                                  : ''}"
                              >
                                {shown.join(', ')}{#if group.accessions.length > ACCESSIONS_SHOWN}
                                  <button
                                    type="button"
                                    class="ml-1 font-sans text-teal-700 hover:underline"
                                    onclick={() => toggle(key)}
                                    >{expanded[key]
                                      ? 'show fewer'
                                      : `+${group.accessions.length - ACCESSIONS_SHOWN} more`}</button
                                  >
                                {/if}
                              </p>
                            </li>
                          {/each}
                        </ul>
                        {#if warnings.length}
                          <p class="mt-3 text-xs font-medium text-amber-800">Metadata warnings</p>
                          <ul class="mt-1 space-y-1.5">
                            {#each warnings as warning (warning.message)}
                              <li class="text-xs">
                                <p class="break-words text-gray-700">{warning.message}</p>
                                {#if warning.samples.length}
                                  <p class="text-gray-500">
                                    {plural(warning.samples.length, 'sample')}: <span class="font-mono"
                                      >{warning.samples.slice(0, ACCESSIONS_SHOWN).join(', ')}{warning
                                        .samples.length > ACCESSIONS_SHOWN
                                        ? ', …'
                                        : ''}</span
                                    >
                                  </p>
                                {/if}
                              </li>
                            {/each}
                          </ul>
                        {/if}
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
          onclick={reset}>New import</button
        >
        <button
          class="rounded-md bg-teal-700 px-4 py-1.5 text-sm font-semibold text-white hover:bg-teal-600"
          onclick={() => (open = false)}>Close</button
        >
      </div>
    </div>
  {/if}
</Modal>
