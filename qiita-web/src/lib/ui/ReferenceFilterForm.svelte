<script lang="ts">
  // Filter an amplicon feature table to a reference's ASVs (Greengenes2's, say):
  // keep the ASVs identical to one of its sequences, ranked by its taxonomy. Nothing
  // is submitted or stored; it adds a dashed view node the server computes on read.
  import { api, type Reference } from '$lib/api';
  import type { WorkflowFormProps } from '$lib/nodeWorkflows';
  import Select from './Select.svelte';

  let { onView }: WorkflowFormProps = $props();

  let refs = $state<Reference[] | null>(null);
  let error = $state('');
  let referenceIdx = $state<number | undefined>(undefined);

  $effect(() => {
    (async () => {
      const r = await api.references();
      if (!r.ok) {
        error = `references: ${r.detail}`;
        return;
      }
      refs = r.data.filter(
        (x) => x.kind === 'sequence_reference' && x.status === 'active' && !x.is_host
      );
      referenceIdx = (refs.find((x) => /greengenes|gg2/i.test(x.name)) ?? refs[0])?.reference_idx;
    })();
  });

  const chosen = $derived(refs?.find((x) => x.reference_idx === referenceIdx));
</script>

<label class="flex flex-col gap-1 text-xs text-gray-600">
  Reference
  {#if error}
    <span class="py-1.5 text-sm text-amber-800">{error}</span>
  {:else if refs === null}
    <span class="py-1.5 text-sm text-gray-400">Loading…</span>
  {:else if refs.length === 0}
    <span class="py-1.5 text-sm text-gray-500">No sequence reference is loaded</span>
  {:else}
    <Select bind:value={referenceIdx} class="w-64">
      {#each refs as r (r.reference_idx)}
        <option value={r.reference_idx}>{r.name} {r.version}</option>
      {/each}
    </Select>
  {/if}
</label>
<button
  type="button"
  class="rounded-md bg-teal-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-500 disabled:cursor-not-allowed disabled:opacity-50"
  disabled={!chosen}
  onclick={() => chosen && onView({ filterReferenceIdx: chosen.reference_idx, label: `${chosen.name} ${chosen.version}` })}
>
  Add filtered table
</button>
<p class="w-full text-xs text-gray-500">
  Keeps the ASVs identical to one of the reference's sequences, ranked by its taxonomy;
  computed each time it's opened, nothing is stored.
</p>
