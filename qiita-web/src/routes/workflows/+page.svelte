<script lang="ts">
  import { auth } from '$lib/auth.svelte';
  import { api, type PrepProtocol, type Reference } from '$lib/api';
  import PageHeading from '$lib/ui/PageHeading.svelte';
  import Card from '$lib/ui/Card.svelte';
  import Modal from '$lib/ui/Modal.svelte';
  import Select from '$lib/ui/Select.svelte';
  import DropZone from '$lib/ui/DropZone.svelte';
  import EnaImportModal from '$lib/ui/EnaImportModal.svelte';
  import { isAdminRole } from '$lib/roles';

  // --- ENA import (admin-only; opens the batch submit/status modal) ---
  let isAdmin = $state(false);
  let enaOpen = $state(false);

  function newEnaImport() {
    enaOpen = true;
  }

  // Gate the ENA card on the caller's role, mirroring the route's own gate.
  $effect(() => {
    if (auth.isSet) {
      api.whoami().then((r) => {
        isAdmin = r.ok && isAdminRole(r.data.system_role);
      });
    } else {
      isAdmin = false;
    }
  });

  // --- Amplicon run submit (run id + preflight → chains golay-demux → denoise) ---
  let open = $state(false);
  let runId = $state('');
  let selectedFile = $state<File | null>(null);
  let fileName = $state('');
  let prepProtocol = $state(0);
  let ref = $state(0);
  let trim = $state(150);
  let primer = $state('GTGYCAGCMGCCGCGGTAA');
  let orient = $state(false);
  let advanced = $state(false);
  let submitting = $state(false);
  let errMsg = $state('');
  let okTickets = $state<{ work_ticket_idx: number; action_id: string }[] | null>(null);

  let protocols = $state<PrepProtocol[]>([]);
  let refs = $state<Reference[]>([]);

  async function openRun() {
    runId = '';
    selectedFile = null;
    fileName = '';
    trim = 150;
    primer = 'GTGYCAGCMGCCGCGGTAA';
    orient = false;
    advanced = false;
    errMsg = '';
    okTickets = null;
    open = true;
    const [pp, rf] = await Promise.all([api.prepProtocols(), api.references()]);
    protocols = pp.ok ? pp.data.filter((p) => !p.retired) : [];
    refs = rf.ok
      ? rf.data.filter((r) => r.kind === 'sequence_reference' && r.status === 'active' && !r.is_host)
      : [];
    // Default to the amplicon prep protocol for this workflow.
    const amp = protocols.find((p) => p.name === 'short_read_amplicon');
    prepProtocol = amp?.prep_protocol_idx ?? protocols[0]?.prep_protocol_idx ?? 0;
    ref = refs[0]?.reference_idx ?? 0;
  }

  function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
  }

  const ready = $derived(
    !!runId.trim() && !!selectedFile && prepProtocol > 0 && ref > 0 && trim >= 6 && !submitting
  );

  async function submitRun() {
    if (!selectedFile || !prepProtocol || !ref) return;
    submitting = true;
    errMsg = '';
    okTickets = null;
    try {
      const blob = await fileToBase64(selectedFile);
      const r = await api.submitAmpliconRun({
        instrument_run_id: runId.trim(),
        run_preflight_blob: blob,
        prep_protocol_idx: prepProtocol,
        sortmerna_reference_idx: ref,
        trim,
        primer,
        orient_primer: orient
      });
      if (r.ok) okTickets = r.data.tickets;
      else errMsg = `HTTP ${r.status} — ${r.detail}`;
    } catch (e) {
      errMsg = String(e);
    } finally {
      submitting = false;
    }
  }
</script>

<PageHeading title="Workflows" subtitle="Submit a workflow — its run appears under Jobs." />

{#if !auth.isSet}
  <Card><p class="py-8 text-center text-gray-500">Log in to submit workflows.</p></Card>
{:else}
  <div class="grid gap-4 sm:grid-cols-2">
    <Card title="Amplicon (Rapid 16S)">
      {#snippet actions()}
        <button class="rounded-md bg-teal-700 px-4 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-teal-600" onclick={openRun}>Queue run</button>
      {/snippet}
      <p class="text-sm text-gray-600">Demultiplex a pooled run and denoise into ASV features.</p>
    </Card>

    <Card title="Long-read assembly">
      {#snippet actions()}
        <button class="cursor-not-allowed rounded-md bg-teal-700 px-4 py-1.5 text-sm font-semibold text-white opacity-50" disabled>Queue run</button>
      {/snippet}
      <p class="text-sm text-gray-600">Assemble and bin long-read (PacBio) samples into genomes.</p>
    </Card>

    {#if isAdmin}
      <Card title="Import from ENA (INSDC)">
        {#snippet actions()}
          <button class="rounded-md bg-teal-700 px-4 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-teal-600" onclick={newEnaImport}>Import</button>
        {/snippet}
        <p class="text-sm text-gray-600">Pull a public study into Qiita by accession — reads plus harmonized metadata.</p>
      </Card>
    {/if}
  </div>
{/if}

<Modal bind:open title="Queue run — Amplicon (Rapid 16S)">
  {#if okTickets}
    <div class="space-y-3">
      <p class="text-sm text-green-700">✓ Queued {okTickets.length} work tickets:</p>
      <ul class="text-sm text-gray-700">
        {#each okTickets as t}<li>#{t.work_ticket_idx} · {t.action_id}</li>{/each}
      </ul>
      <div class="flex justify-end gap-2">
        <button class="rounded-md bg-white px-3 py-1.5 text-sm font-semibold text-gray-700 ring-1 ring-gray-300 ring-inset hover:bg-gray-50" onclick={() => (open = false)}>Close</button>
        <a href="/tickets" class="rounded-md bg-teal-700 px-4 py-1.5 text-sm font-semibold text-white hover:bg-teal-600">View in Jobs</a>
      </div>
    </div>
  {:else}
    <div class="space-y-3">
      <label class="block text-sm">
        <span class="mb-1 block text-gray-500">Instrument run ID</span>
        <input bind:value={runId} placeholder="e.g. 20260925_M05314_…" class="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm" />
      </label>

      <div class="text-sm">
        <span class="mb-1 block text-gray-500">Pre-flight file</span>
        <DropZone accept=".sqlite / .db" {fileName} onfile={(f) => { selectedFile = f; fileName = f.name; }} />
      </div>

      <div class="grid grid-cols-2 gap-3 text-sm">
        <label>
          <span class="mb-1 block text-gray-500">Prep protocol</span>
          <Select bind:value={prepProtocol} class="w-full">
            {#each protocols as p}<option value={p.prep_protocol_idx}>{p.name}</option>{/each}
          </Select>
        </label>
        <label>
          <span class="mb-1 block text-gray-500">SortMeRNA reference</span>
          <Select bind:value={ref} class="w-full">
            {#each refs as r}<option value={r.reference_idx}>{r.name} ({r.version})</option>{/each}
          </Select>
        </label>
      </div>

      <button class="text-xs text-teal-700 hover:underline" onclick={() => (advanced = !advanced)}>{advanced ? 'Hide' : 'Show'} advanced</button>
      {#if advanced}
        <div class="grid grid-cols-2 items-end gap-3 rounded-md bg-gray-50 p-3 text-sm">
          <label>
            <span class="mb-1 block text-gray-500">Trim length</span>
            <input type="number" min="6" bind:value={trim} class="w-full rounded-md border border-gray-300 px-3 py-1.5" />
          </label>
          <label>
            <span class="mb-1 block text-gray-500">Primer</span>
            <input bind:value={primer} class="w-full rounded-md border border-gray-300 px-3 py-1.5" />
          </label>
          <label class="col-span-2 flex items-center gap-2 text-gray-700">
            <input type="checkbox" bind:checked={orient} class="size-4 rounded border-gray-300 text-teal-600 focus:ring-teal-500" />
            Orient primer
          </label>
        </div>
      {/if}

      {#if errMsg}<p class="text-sm text-red-700">{errMsg}</p>{/if}

      <div class="flex justify-end gap-2 pt-1">
        <button class="rounded-md bg-white px-3 py-1.5 text-sm font-semibold text-gray-700 ring-1 ring-gray-300 ring-inset hover:bg-gray-50" onclick={() => (open = false)}>Cancel</button>
        <button
          class="rounded-md bg-teal-700 px-4 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-teal-600 disabled:opacity-50"
          onclick={submitRun}
          disabled={!ready}>{submitting ? 'Queuing…' : 'Queue run'}</button>
      </div>
    </div>
  {/if}
</Modal>

<EnaImportModal bind:open={enaOpen} />
