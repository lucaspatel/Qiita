<script lang="ts">
  import {
    buildLineage,
    type LineageGraph,
    type LineageNode,
    type LineageStatus
  } from '$lib/lineage';

  let { prepSampleIdx }: { prepSampleIdx: number } = $props();

  let graph = $state<LineageGraph | null>(null);
  let loading = $state(false);
  let error = $state('');
  let unsupported = $state(false);
  let stepsOpen = $state(false);
  let loadedFor = -1;

  $effect(() => {
    if (prepSampleIdx && loadedFor !== prepSampleIdx) {
      loadedFor = prepSampleIdx;
      load(prepSampleIdx);
    }
  });

  async function load(idx: number) {
    loading = true;
    error = '';
    unsupported = false;
    graph = null;
    stepsOpen = false;
    const r = await buildLineage(idx);
    loading = false;
    if (!r.ok) {
      unsupported = r.unsupported;
      error = r.error;
      return;
    }
    graph = r.graph;
  }

  const STATUS_CLASS: Record<LineageStatus, string> = {
    completed: 'bg-green-50 text-green-700 ring-green-600/20',
    processing: 'bg-blue-50 text-blue-700 ring-blue-600/20',
    queued: 'bg-amber-50 text-amber-800 ring-amber-600/20',
    pending: 'bg-gray-50 text-gray-500 ring-gray-400/20',
    failed: 'bg-red-50 text-red-700 ring-red-600/10',
    no_data: 'bg-gray-50 text-gray-400 ring-gray-400/20'
  };
  const DOT: Record<LineageStatus, string> = {
    completed: 'bg-green-500',
    processing: 'bg-blue-500',
    queued: 'bg-amber-500',
    pending: 'bg-gray-300',
    failed: 'bg-red-500',
    no_data: 'bg-gray-300'
  };

  const byId = $derived<Record<string, LineageNode>>(
    graph ? Object.fromEntries(graph.nodes.map((n) => [n.id, n])) : {}
  );
  const assembly = $derived(graph?.nodes.find((n) => n.kind === 'assembly'));
</script>

{#snippet chip(node: LineageNode | undefined)}
  {#if node}
    <div class="min-w-[8.5rem] rounded-md px-3 py-2 ring-1 ring-inset {STATUS_CLASS[node.status]}">
      <p class="text-sm font-medium">{node.label}</p>
      {#if node.detail}<p class="mt-0.5 text-xs opacity-80">{node.detail}</p>{/if}
      <p class="mt-1 text-[10px] font-medium tracking-wide uppercase opacity-70">
        {node.status.replace('_', ' ')}
      </p>
    </div>
  {/if}
{/snippet}

{#snippet arrow()}
  <div class="flex shrink-0 items-center self-center px-1 text-lg text-gray-300" aria-hidden="true">→</div>
{/snippet}

{#if loading}
  <p class="py-3 text-sm text-gray-500">Reconstructing lineage…</p>
{:else if unsupported}
  <p class="py-3 text-sm text-gray-500">
    Lineage needs <code class="rounded bg-gray-100 px-1">GET /processing</code>, which this
    server doesn't have yet.
  </p>
{:else if error}
  <p class="py-3 text-sm text-red-700">{error}</p>
{:else if graph}
  <div class="overflow-x-auto py-1">
    <div class="flex items-start gap-1">
      {@render chip(byId['reads'])}
      {#if byId['mask']}{@render arrow()}{@render chip(byId['mask'])}{/if}
      {@render arrow()}

      <!-- assembly node + its expandable 11-step chain -->
      <div class="flex flex-col gap-1">
        {@render chip(assembly)}
        {#if assembly?.steps}
          <button class="text-left text-[11px] text-teal-700 hover:underline" onclick={() => (stepsOpen = !stepsOpen)}>
            {stepsOpen ? 'Hide' : 'Show'} steps ({assembly.steps.length})
          </button>
          {#if stepsOpen}
            <ol class="space-y-0.5 rounded-md bg-gray-50 px-2 py-1.5 ring-1 ring-gray-200 ring-inset">
              {#each assembly.steps as s, i}
                <li class="flex items-center gap-2 text-[11px] text-gray-600">
                  <span class="w-4 text-right text-gray-300">{i + 1}</span>
                  <span class="size-2 shrink-0 rounded-full {DOT[s.status]}"></span>
                  <span class="font-mono">{s.name}</span>
                </li>
              {/each}
            </ol>
          {/if}
        {/if}
      </div>

      {@render arrow()}

      <!-- contig classes branch out, converge on the feature table -->
      <div class="flex flex-col gap-1 self-center">
        {@render chip(byId['mag'])}
        {@render chip(byId['lcg'])}
        {@render chip(byId['unbinned'])}
      </div>

      {@render arrow()}
      {@render chip(byId['features'])}
    </div>
  </div>
{/if}
