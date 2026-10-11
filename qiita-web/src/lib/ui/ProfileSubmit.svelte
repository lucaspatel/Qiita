<script lang="ts">
  // Submit a taxonomic profile of a group's reads: pick the method, then a
  // database that method can read (a sylph method lists only profiling databases
  // with a registered sylph file), and submit one ticket per pool the group's
  // samples sit on. Each method + database is its own run, so its own branch of
  // the lineage once submitted.
  import { api, type LineageSample, type Reference } from '$lib/api';
  import Select from './Select.svelte';

  let {
    samples,
    onSubmitted
  }: {
    samples: LineageSample[];
    /** Called once every pool's ticket is in, to reload the lineage. */
    onSubmitted: () => void;
  } = $props();

  type Method = {
    id: string;
    label: string;
    /** The workflow it submits, and the index type its database must carry. */
    action?: { id: string; version: string; indexType: string };
    note?: string;
  };
  const METHODS: Method[] = [
    {
      id: 'sylph',
      label: 'sylph (k-mer profiling of raw reads)',
      action: { id: 'taxonomic-profile', version: '1.0.0', indexType: 'sylph' }
    },
    { id: 'woltka', label: 'woltka (alignment-based OGUs)', note: 'not available yet' }
  ];

  type Database = { ref: Reference; format: string; taxonomy: boolean };

  let methodId = $state('sylph');
  const method = $derived(METHODS.find((m) => m.id === methodId)!);
  let databases = $state<Database[] | null>(null);
  let databasesError = $state('');
  let referenceIdx = $state<number | undefined>(undefined);
  let minAni = $state('');
  let submitting = $state(false);
  let result = $state<{ ok: boolean; text: string } | null>(null);

  // The pools the group's samples sit on: one ticket each.
  const pools = $derived.by(() => {
    const seen = new Map<number, number>();
    for (const s of samples)
      if (s.sequenced_pool_idx != null && s.sequencing_run_idx != null)
        seen.set(s.sequenced_pool_idx, s.sequencing_run_idx);
    return [...seen].map(([pool, run]) => ({ pool, run }));
  });

  // The databases the chosen method can read: active profiling databases whose
  // newest files include the method's index type.
  $effect(() => {
    const indexType = method.action?.indexType;
    databases = null;
    databasesError = '';
    referenceIdx = undefined;
    if (!indexType) {
      databases = [];
      return;
    }
    (async () => {
      const refs = await api.references();
      if (!refs.ok) {
        databasesError = `references: ${refs.detail}`;
        return;
      }
      const candidates = refs.data.filter(
        (r) => r.kind === 'profiling_database' && r.status === 'active'
      );
      const found: Database[] = [];
      for (const ref of candidates) {
        const idx = await api.referenceIndices(ref.reference_idx);
        if (!idx.ok) continue;
        const file = idx.data.find((i) => i.index_type === indexType);
        if (!file) continue;
        found.push({
          ref,
          format: String(file.params?.format ?? ''),
          taxonomy: idx.data.some((i) => i.index_type === `${indexType}_taxonomy`)
        });
      }
      databases = found;
      if (found.length === 1) referenceIdx = found[0].ref.reference_idx;
    })();
  });

  const aniValue = $derived(minAni.trim() === '' ? null : Number(minAni));
  const aniValid = $derived(aniValue === null || (aniValue >= 0 && aniValue <= 1));
  const canSubmit = $derived(
    !!method.action && referenceIdx != null && aniValid && pools.length > 0 && !submitting
  );

  async function submit() {
    if (!canSubmit || !method.action) return;
    submitting = true;
    result = null;
    const done: string[] = [];
    const failed: string[] = [];
    for (const { pool, run } of pools) {
      const r = await api.submitWorkTicket({
        action_id: method.action.id,
        action_version: method.action.version,
        scope_target: { kind: 'sequenced_pool', sequenced_pool_idx: pool, sequencing_run_idx: run },
        action_context: {
          sylph_reference_idx: referenceIdx,
          ...(aniValue !== null ? { min_ani: aniValue } : {})
        }
      });
      if (r.ok) done.push(`#${r.data.work_ticket_idx}`);
      else failed.push(`pool ${pool}: ${r.detail}`);
    }
    submitting = false;
    result = failed.length
      ? { ok: false, text: [done.length ? `submitted ${done.join(', ')}` : '', ...failed].filter(Boolean).join('; ') }
      : { ok: true, text: `submitted ticket${done.length === 1 ? '' : 's'} ${done.join(', ')}` };
    if (done.length) onSubmitted();
  }
</script>

<div class="flex flex-wrap items-end gap-3 border-b border-gray-200 bg-gray-50 px-4 py-3 sm:px-6">
  <p class="w-full text-xs font-medium text-gray-500">Taxonomic profile of these reads</p>
  <label class="flex flex-col gap-1 text-xs text-gray-600">
    Method
    <Select bind:value={methodId} class="w-72">
      {#each METHODS as m (m.id)}
        <option value={m.id} disabled={!m.action}>{m.label}{m.note ? ` — ${m.note}` : ''}</option>
      {/each}
    </Select>
  </label>
  <label class="flex flex-col gap-1 text-xs text-gray-600">
    Database
    {#if databasesError}
      <span class="py-1.5 text-sm text-amber-800">{databasesError}</span>
    {:else if databases === null}
      <span class="py-1.5 text-sm text-gray-400">Loading…</span>
    {:else if databases.length === 0}
      <span class="py-1.5 text-sm text-gray-500">No {method.label.split(' ')[0]} database is registered</span>
    {:else}
      <Select bind:value={referenceIdx} class="w-64">
        {#if databases.length > 1}<option value={undefined}>Choose…</option>{/if}
        {#each databases as d (d.ref.reference_idx)}
          <option value={d.ref.reference_idx}
            >{d.ref.name} {d.ref.version} · {d.format}{d.taxonomy ? '' : ' · no taxonomy'}</option
          >
        {/each}
      </Select>
    {/if}
  </label>
  <label class="flex flex-col gap-1 text-xs text-gray-600">
    Min ANI (0–1, optional)
    <input
      bind:value={minAni}
      inputmode="decimal"
      placeholder="sylph default"
      class="w-32 rounded-md border px-3 py-1.5 text-sm text-gray-900 focus:ring-1 focus:outline-none {aniValid
        ? 'border-gray-300 focus:border-teal-500 focus:ring-teal-500'
        : 'border-red-400 focus:border-red-500 focus:ring-red-500'}"
    />
  </label>
  <button
    type="button"
    class="rounded-md bg-teal-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-500 disabled:cursor-not-allowed disabled:opacity-50"
    disabled={!canSubmit}
    onclick={submit}
  >
    {submitting ? 'Submitting…' : `Profile ${pools.length} pool${pools.length === 1 ? '' : 's'}`}
  </button>
  {#if result}
    <p class="w-full text-xs {result.ok ? 'text-teal-700' : 'text-amber-800'}">{result.text}</p>
  {/if}
</div>
