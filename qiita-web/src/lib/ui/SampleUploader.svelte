<script lang="ts">
  // Metadata-sheet → bulk biosample import, scoped to ONE study. Embedded on the
  // study detail page (the study is the context, so there's no study-picker here).
  import { api, type BiosampleRow, type BulkImportResult, type ApiResult } from '$lib/api';
  import Select from '$lib/ui/Select.svelte';
  import DropZone from '$lib/ui/DropZone.svelte';
  import { metameq } from '$lib/pyodide/pyodide.svelte';
  import type { MetameqValidationResult } from '$lib/pyodide/types';

  let { studyIdx, onUploaded }: { studyIdx: number; onUploaded?: () => void } = $props();

  // Owner defaults to the logged-in principal.
  let ownerIdx = $state<number | null>(null);
  $effect(() => {
    if (ownerIdx == null) api.whoami().then((r) => r.ok && (ownerIdx = r.data.principal_idx));
  });

  // --- sheet parsing (client-side) ---
  let fileName = $state('');
  let headers = $state<string[]>([]);
  let rows = $state<string[][]>([]);
  let parseMsg = $state('');
  let idCol = $state(0);
  let idFieldName = $state('owner sample name');
  let tubeCol = $state(-1);

  function parse(text: string) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim() !== '');
    if (!lines.length) {
      parseMsg = 'empty file';
      return;
    }
    const delim = lines[0].includes('\t') ? '\t' : ','; // lab prep templates are TSV
    headers = lines[0].split(delim).map((h) => h.trim());
    rows = lines.slice(1).map((l) => {
      const cells = l.split(delim).map((c) => c.trim());
      while (cells.length < headers.length) cells.push(''); // rectangular, for editing
      return cells;
    });
    idCol = 0;
    tubeCol = headers.findIndex((h) => /tube|tubecode/i.test(h));
    parseMsg = `${rows.length} rows × ${headers.length} columns`;
  }

  async function handleFile(f: File | undefined) {
    if (!f) return;
    fileName = f.name;
    result = null;
    submitErr = '';
    valResult = null;
    valErr = '';
    parse(await f.text());
  }

  // --- optional, non-blocking metameq validation (lazy Pyodide) ---
  let validating = $state(false);
  let valResult = $state<MetameqValidationResult | null>(null);
  let valErr = $state('');

  // Validate the CURRENT (possibly edited) grid, so edits are always what's
  // checked. Re-serialized as TSV — metameq reads tabular by extension.
  function gridToFile(): File {
    const line = (cells: string[]) => headers.map((_h, i) => cells[i] ?? '').join('\t');
    const tsv = [headers.join('\t'), ...rows.map(line)].join('\n');
    return new File([tsv], 'metadata.tsv', { type: 'text/tab-separated-values' });
  }

  async function validate() {
    if (!rows.length) return;
    validating = true;
    valErr = '';
    try {
      valResult = await metameq.validate(gridToFile());
    } catch (e) {
      valErr = String(e);
    } finally {
      validating = false;
    }
  }

  const valIssues = $derived<Record<string, unknown>[]>(valResult?.validationErrors ?? []);

  // Map each validation issue to a grid cell: match sample_name against the
  // sample-id column's value, field_name against a header. Issues on metameq's
  // extended columns (not in the sheet) stay in the issues table, unhighlighted.
  const errorCells = $derived.by(() => {
    const m = new Map<string, string>();
    for (const iss of valIssues) {
      const sn = String(iss.sample_name ?? '');
      const r = rows.findIndex((cells) => (cells[idCol] ?? '') === sn);
      const c = headers.indexOf(String(iss.field_name ?? ''));
      if (r >= 0 && c >= 0) m.set(`${r}-${c}`, String(iss.error_message ?? ''));
    }
    return m;
  });

  // --- submit ---
  let submitting = $state(false);
  let result = $state<BulkImportResult | null>(null);
  let submitErr = $state('');

  const samples = $derived<BiosampleRow[]>(
    rows.map((cells) => {
      const metadata: Record<string, string> = {};
      headers.forEach((h, i) => {
        if (i === idCol || i === tubeCol) return;
        const v = cells[i] ?? '';
        if (v) metadata[h] = v;
      });
      return {
        owner_idx: ownerIdx ?? 0,
        owner_biosample_id_field_name: idFieldName.trim(),
        owner_biosample_id_value: cells[idCol] ?? '',
        metadata,
        matrix_tube_id: tubeCol >= 0 ? cells[tubeCol] || null : null
      };
    })
  );

  const ready = $derived(!!ownerIdx && !!idFieldName.trim() && rows.length > 0 && !submitting);

  async function upload() {
    submitting = true;
    result = null;
    submitErr = '';
    const r: ApiResult<BulkImportResult> = await api.bulkImportBiosamples(studyIdx, samples);
    submitting = false;
    if (r.ok) {
      result = r.data;
      onUploaded?.();
      // Clear the loaded sheet so the drop zone resets instead of lingering on
      // "drop another to replace" — the success banner below reports the result.
      headers = [];
      rows = [];
      fileName = '';
      valResult = null;
      valErr = '';
    } else {
      submitErr = `HTTP ${r.status} — ${r.detail}`;
    }
  }
</script>

<div class="space-y-3">
  <DropZone
    accept=".tsv / .csv — one row per sample"
    hint="Drop a metadata sheet here, or click to browse"
    {fileName}
    onfile={handleFile}
  />
  <div class="flex items-center justify-between text-xs text-gray-400">
    <span>{parseMsg}</span>
    <span>owner: {ownerIdx ?? '…'}</span>
  </div>

  {#if headers.length}
    <div class="flex flex-wrap items-end gap-3 border-t border-gray-100 pt-3 text-sm">
      <label>
        <span class="mb-1 block text-gray-500">sample-id column</span>
        <Select bind:value={idCol} class="w-44">
          {#each headers as h, i}<option value={i}>{h}</option>{/each}
        </Select>
      </label>
      <label>
        <span class="mb-1 block text-gray-500">→ stored as field</span>
        <input
          bind:value={idFieldName}
          class="w-44 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm focus:border-teal-500 focus:ring-1 focus:ring-teal-500 focus:outline-none"
        />
      </label>
      <label>
        <span class="mb-1 block text-gray-500">tube-id column</span>
        <Select bind:value={tubeCol} class="w-44">
          <option value={-1}>— none —</option>
          {#each headers as h, i}<option value={i}>{h}</option>{/each}
        </Select>
      </label>
      <button
        class="ml-auto rounded-md bg-teal-700 px-4 py-1.5 font-semibold text-white shadow-sm hover:bg-teal-600 disabled:opacity-40"
        onclick={upload}
        disabled={!ready}>{submitting ? 'Uploading…' : `Upload ${rows.length} sample${rows.length === 1 ? '' : 's'}`}</button>
    </div>
    <div class="max-h-64 overflow-auto rounded-md ring-1 ring-gray-200">
      <table class="min-w-full divide-y divide-gray-200 text-xs">
        <thead class="sticky top-0 bg-gray-50">
          <tr>
            {#each headers as h, i}
              <th class="px-2 py-1.5 text-left font-semibold whitespace-nowrap {i === idCol ? 'text-teal-700' : i === tubeCol ? 'text-amber-700' : 'text-gray-500'}">
                {h}{#if i === idCol}<span class="font-normal"> · id</span>{:else if i === tubeCol}<span class="font-normal"> · tube</span>{/if}
              </th>
            {/each}
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-100">
          {#each rows as _cells, r}
            <tr>
              {#each headers as _h, i}
                <td class="p-0">
                  <input
                    bind:value={rows[r][i]}
                    title={errorCells.get(`${r}-${i}`) ?? ''}
                    class="w-full min-w-28 border-0 bg-transparent px-2 py-1 text-xs text-gray-700 focus:bg-white focus:ring-1 focus:ring-teal-500 focus:outline-none focus:ring-inset {errorCells.has(
                      `${r}-${i}`
                    )
                      ? 'bg-red-50 text-red-800'
                      : ''}"
                  />
                </td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <p class="text-xs text-gray-400">{rows.length} rows · editable</p>

    <div class="rounded-lg border border-gray-200 bg-gray-50/60 p-3">
      <div class="flex flex-wrap items-center gap-2">
        <button
          class="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-teal-700 ring-1 ring-teal-600/30 ring-inset hover:bg-teal-50 disabled:opacity-40"
          onclick={validate}
          disabled={validating}>{validating ? 'Validating…' : valResult ? 'Re-validate' : 'Validate metadata'}</button>
      </div>

      {#if validating && !metameq.isReady}
        <p class="mt-2 text-xs text-gray-500">Loading validator… {metameq.loadProgress}% (first run downloads the engine)</p>
      {/if}

      {#if valErr}
        <p class="mt-2 text-sm text-red-700">{valErr}</p>
      {:else if valResult}
        {#if !valResult.processed}
          <p class="mt-2 text-sm text-amber-700">Validator couldn't process the sheet{valResult.errors?.[0]?.message ? `: ${valResult.errors[0].message}` : '.'}</p>
        {:else}
          <p class="mt-2 text-sm {valResult.summary.errorCount ? 'text-amber-700' : 'text-green-700'}">
            {valResult.summary.validRows}/{valResult.summary.totalRows} rows valid · {valResult.summary.errorCount} issue{valResult.summary.errorCount === 1 ? '' : 's'}
          </p>
          {#if valIssues.length}
            <div class="mt-2 max-h-56 overflow-auto rounded-md ring-1 ring-gray-200">
              <table class="min-w-full divide-y divide-gray-200 text-xs">
                <thead class="sticky top-0 bg-gray-50">
                  <tr>{#each ['sample', 'field', 'value', 'issue'] as h}<th class="px-2 py-1.5 text-left font-semibold text-gray-500">{h}</th>{/each}</tr>
                </thead>
                <tbody class="divide-y divide-gray-100">
                  {#each valIssues.slice(0, 200) as iss}
                    <tr>
                      <td class="px-2 py-1 whitespace-nowrap text-gray-700">{String(iss.sample_name ?? '')}</td>
                      <td class="px-2 py-1 whitespace-nowrap text-gray-700">{String(iss.field_name ?? '')}</td>
                      <td class="px-2 py-1 whitespace-nowrap text-gray-500">{String(iss.field_value ?? '')}</td>
                      <td class="px-2 py-1 text-amber-800">{String(iss.error_message ?? '')}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
            {#if valIssues.length > 200}<p class="mt-1 text-xs text-gray-400">Showing first 200 of {valIssues.length}.</p>{/if}
          {/if}
        {/if}
      {/if}
    </div>
  {/if}

  {#if submitErr}
    <div class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-600/10">
      {submitErr}
      <p class="mt-1 text-xs text-red-600/80">All-or-nothing: nothing was created. Fix the named row and re-upload.</p>
    </div>
  {:else if result}
    <p class="text-sm text-green-700">✓ Created {result.results.length} biosamples (idx {result.results[0]?.biosample_idx}–{result.results[result.results.length - 1]?.biosample_idx}).</p>
  {/if}
</div>
