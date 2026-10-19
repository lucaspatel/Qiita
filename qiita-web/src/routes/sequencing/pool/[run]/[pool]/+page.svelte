<script lang="ts">
  // A sequenced pool's page — the cross-study, run-scoped view. Demo scope: the
  // processing rollup (GET …/completion) — demux state and the per-sample buckets.
  // Samples table, pool-level processing (mask/align), and the studies it touches
  // come next; this is the seam the study page links into.
  import { page } from '$app/state';
  import { auth } from '$lib/auth.svelte';
  import { api, type PoolCompletion, type PoolDemuxState } from '$lib/api';
  import PageHeading from '$lib/ui/PageHeading.svelte';
  import Card from '$lib/ui/Card.svelte';
  import Spinner from '$lib/ui/Spinner.svelte';

  const run = $derived(Number(page.params.run));
  const pool = $derived(Number(page.params.pool));

  let data = $state<PoolCompletion | null>(null);
  let err = $state('');
  let loading = $state(false);
  let loadedKey = '';
  $effect(() => {
    const key = `${run}:${pool}`;
    if (!auth.isSet || key === loadedKey) return;
    loadedKey = key;
    loading = true;
    err = '';
    data = null;
    api.poolCompletion(run, pool).then((r) => {
      if (r.ok) data = r.data;
      else err = r.status === 403 ? 'You need to own this run or be a wet-lab admin to view it.' : `HTTP ${r.status} — ${r.detail}`;
      loading = false;
    });
  });

  const demuxStyle: Record<PoolDemuxState, string> = {
    completed: 'bg-green-50 text-green-700 ring-green-600/20',
    in_flight: 'bg-yellow-50 text-yellow-800 ring-yellow-600/20',
    failed: 'bg-red-50 text-red-700 ring-red-600/10',
    no_data: 'bg-gray-50 text-gray-600 ring-gray-500/10',
    not_submitted: 'bg-gray-50 text-gray-600 ring-gray-500/10'
  };

  // The per-sample buckets, in the order worth reading; zeros are shown muted.
  const buckets = $derived(
    data
      ? ([
          ['completed', data.samples_completed, 'bg-green-500'],
          ['in flight', data.samples_in_flight, 'bg-yellow-400'],
          ['failed', data.samples_failed, 'bg-red-500'],
          ['no data', data.samples_no_data, 'bg-gray-300'],
          ['invalidated', data.samples_invalidated, 'bg-orange-400'],
          ['cancelled', data.samples_cancelled, 'bg-gray-400'],
          ['not submitted', data.samples_not_submitted, 'bg-gray-200']
        ] as const)
      : []
  );
  const pct = (n: number) => (data && data.sample_count ? (n / data.sample_count) * 100 : 0);
</script>

<PageHeading title="Pool #{pool}" subtitle="Sequencing run #{run}" />

{#if !auth.isSet}
  <Card><p class="py-8 text-center text-gray-500">Log in to view this pool.</p></Card>
{:else if loading}
  <Card><div class="flex justify-center py-10"><Spinner /></div></Card>
{:else if err}
  <Card><p class="py-8 text-center text-red-700">{err}</p></Card>
{:else if data}
  <div class="space-y-6">
    <Card title="Processing status">
      <div class="flex flex-wrap items-center gap-3">
        <span class="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium capitalize ring-1 ring-inset {demuxStyle[data.demux_state]}">
          demux: {data.demux_state.replace('_', ' ')}
        </span>
        {#if data.fully_processed}
          <span class="inline-flex items-center rounded-full bg-green-100 px-2 py-1 text-xs font-medium text-green-700">fully processed</span>
        {:else if data.complete}
          <span class="inline-flex items-center rounded-full bg-teal-100 px-2 py-1 text-xs font-medium text-teal-700">samples complete</span>
        {/if}
        <span class="ml-auto text-sm text-gray-500">{data.sample_count} samples</span>
      </div>

      <!-- Proportion bar across the buckets. -->
      <div class="mt-4 flex h-2 w-full overflow-hidden rounded-full bg-gray-100">
        {#each buckets as [, n, color] (color)}
          {#if n > 0}<div class={color} style="width:{pct(n)}%"></div>{/if}
        {/each}
      </div>

      <dl class="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
        {#each buckets as [label, n, color] (label)}
          <div class="flex items-center gap-2 text-sm {n ? '' : 'text-gray-400'}">
            <span class="size-2.5 shrink-0 rounded-full {n ? color : 'bg-gray-200'}"></span>
            <dt class="text-gray-500">{label}</dt>
            <dd class="ml-auto font-medium tabular-nums {n ? 'text-gray-900' : ''}">{n}</dd>
          </div>
        {/each}
      </dl>
    </Card>

    <p class="text-xs text-gray-400">
      Samples, pool-level processing (mask / align), and the studies this pool touches come next.
    </p>
  </div>
{/if}
