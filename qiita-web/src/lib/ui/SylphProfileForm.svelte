<script lang="ts">
  // Profile a group's reads with sylph: pick a database (a sylph file registered on
  // an active sequence reference, which a reference may carry several of) and
  // submit one ticket per pool the chosen samples sit on, limited to them. Each database is its own
  // run, so its own branch of the lineage once submitted. sylph's own default
  // minimum ANI applies; the job takes `min_ani` already, for when the form offers
  // it again.
  import { api, type Reference } from '$lib/api';
  import type { WorkflowFormProps } from '$lib/nodeWorkflows';
  import Select from './Select.svelte';

  let { samples, chosen, onSubmitted }: WorkflowFormProps = $props();

  const ACTION = { id: 'taxonomic-profile', version: '1.0.0', indexType: 'sylph' };

  /** One database file: its index row, the reference it belongs to, and how the
   *  registration labelled it (e.g. `ani95`), else its format. */
  type Database = { indexIdx: number; ref: Reference; label: string };

  let databases = $state<Database[] | null>(null);
  let databasesError = $state('');
  let indexIdx = $state<number | undefined>(undefined);
  let submitting = $state(false);
  let result = $state<{ ok: boolean; text: string } | null>(null);

  // The pools the chosen samples sit on, each with its chosen samples: one ticket
  // each.
  const pools = $derived.by(() => {
    const picked = new Set(chosen);
    const seen = new Map<number, { pool: number; run: number; samples: number[] }>();
    for (const s of samples) {
      if (!picked.has(s.prep_sample_idx)) continue;
      if (s.sequenced_pool_idx == null || s.sequencing_run_idx == null) continue;
      const p = seen.get(s.sequenced_pool_idx) ?? {
        pool: s.sequenced_pool_idx,
        run: s.sequencing_run_idx,
        samples: []
      };
      p.samples.push(s.prep_sample_idx);
      seen.set(s.sequenced_pool_idx, p);
    }
    return [...seen.values()];
  });
  const sampleCount = $derived(pools.reduce((n, p) => n + p.samples.length, 0));

  // The sylph files on active, non-host sequence references.
  $effect(() => {
    (async () => {
      const refs = await api.references();
      if (!refs.ok) {
        databasesError = `references: ${refs.detail}`;
        return;
      }
      const candidates = refs.data.filter(
        (r) => r.kind === 'sequence_reference' && r.status === 'active' && !r.is_host
      );
      const found: Database[] = [];
      for (const ref of candidates) {
        const idx = await api.referenceIndices(ref.reference_idx);
        if (!idx.ok) continue;
        for (const file of idx.data.filter((i) => i.index_type === ACTION.indexType))
          found.push({
            indexIdx: file.reference_index_idx,
            ref,
            label: String(file.params?.label ?? file.params?.format ?? '')
          });
      }
      databases = found;
      if (found.length === 1) indexIdx = found[0].indexIdx;
    })();
  });

  const canSubmit = $derived(indexIdx != null && pools.length > 0 && !submitting);

  async function submit() {
    if (!canSubmit) return;
    submitting = true;
    result = null;
    const done: string[] = [];
    const failed: string[] = [];
    for (const { pool, run, samples: picked } of pools) {
      const r = await api.submitWorkTicket({
        action_id: ACTION.id,
        action_version: ACTION.version,
        scope_target: { kind: 'sequenced_pool', sequenced_pool_idx: pool, sequencing_run_idx: run },
        action_context: { sylph_index_idx: indexIdx, prep_sample_idxs: picked }
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

<label class="flex flex-col gap-1 text-xs text-gray-600">
  Database
  {#if databasesError}
    <span class="py-1.5 text-sm text-amber-800">{databasesError}</span>
  {:else if databases === null}
    <span class="py-1.5 text-sm text-gray-400">Loading…</span>
  {:else if databases.length === 0}
    <span class="py-1.5 text-sm text-gray-500">No sylph database is registered</span>
  {:else}
    <Select bind:value={indexIdx} class="w-64">
      {#if databases.length > 1}<option value={undefined}>Choose…</option>{/if}
      {#each databases as d (d.indexIdx)}
        <option value={d.indexIdx}>{d.ref.name} {d.ref.version} · {d.label}</option>
      {/each}
    </Select>
  {/if}
</label>
<button
  type="button"
  class="rounded-md bg-teal-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-500 disabled:cursor-not-allowed disabled:opacity-50"
  disabled={!canSubmit}
  onclick={submit}
>
  {submitting
    ? 'Submitting…'
    : `Profile ${sampleCount} sample${sampleCount === 1 ? '' : 's'}` +
      (pools.length > 1 ? ` (${pools.length} pools)` : '')}
</button>
{#if result}
  <p class="w-full text-xs {result.ok ? 'text-teal-700' : 'text-amber-800'}">{result.text}</p>
{/if}
