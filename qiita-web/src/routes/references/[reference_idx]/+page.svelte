<script lang="ts">
  import { page } from '$app/state';
  import { auth } from '$lib/auth.svelte';
  import {
    api,
    type ApiResult,
    type Reference,
    type ReferenceIndex,
    type ReferenceExclusion
  } from '$lib/api';
  import PageHeading from '$lib/ui/PageHeading.svelte';
  import Card from '$lib/ui/Card.svelte';
  import StatusPill from '$lib/ui/StatusPill.svelte';

  const idx = $derived(Number(page.params.reference_idx));

  let rec = $state<ApiResult<Reference> | null>(null);
  let indices = $state<ApiResult<ReferenceIndex[]> | null>(null);
  let excl = $state<ApiResult<ReferenceExclusion[]> | null>(null);
  let gmap = $state<ApiResult<{ entries: unknown[]; count?: number }> | null>(null);
  let loadedFor = -1;

  $effect(() => {
    const i = idx;
    if (!auth.isSet || !i || loadedFor === i) return;
    loadedFor = i;
    rec = indices = excl = gmap = null;
    api.reference(i).then((r) => (rec = r));
    api.referenceIndices(i).then((r) => (indices = r));
    api.referenceExclusions(i).then((r) => (excl = r));
    api.referenceGenomeMap(i).then((r) => (gmap = r));
  });

  const n = (v: unknown) => Number(v ?? 0);
  const summary = $derived.by(() => {
    const rows = indices?.ok ? indices.data : [];
    const m = new Map<string, { count: number; sharded: number; subjects: number; features: number }>();
    for (const r of rows) {
      const g = m.get(r.index_type) ?? { count: 0, sharded: 0, subjects: 0, features: 0 };
      g.count++;
      if (r.shard_id != null) g.sharded++;
      g.subjects += n(r.params?.num_subjects);
      g.features += n(r.params?.feature_count);
      m.set(r.index_type, g);
    }
    return [...m.entries()].map(([type, g]) => ({ type, ...g }));
  });
  const sylphFiles = $derived(indices?.ok ? indices.data.filter((r) => r.index_type === 'sylph') : []);
  const gmapCount = $derived(gmap?.ok ? (gmap.data.count ?? gmap.data.entries?.length ?? 0) : 0);
  const fmt = (x: number) => x.toLocaleString();
  const bytes = (x: number) => {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (x >= 1024 && i < units.length - 1) (x /= 1024), i++;
    return `${x.toFixed(i ? 1 : 0)} ${units[i]}`;
  };
</script>

<div class="mb-3">
  <a href="/references" class="text-sm text-teal-700 hover:underline">← References</a>
</div>

{#if !auth.isSet}
  <Card><p class="py-8 text-center text-gray-500">Log in to view a reference.</p></Card>
{:else if rec && !rec.ok}
  <Card><p class="py-8 text-center text-red-700">HTTP {rec.status} — {rec.detail}</p></Card>
{:else if rec?.ok}
  <PageHeading title="{rec.data.name} · v{rec.data.version}">
    {#snippet actions()}
      {#if rec?.ok}
        <StatusPill status={rec.data.status} />
        {#if rec.data.is_host}<span class="rounded-md bg-gray-100 px-2 py-0.5 text-xs text-gray-600">host</span>{/if}
      {/if}
    {/snippet}
  </PageHeading>

  <div class="space-y-6">
    <Card title="Overview">
      <dl class="grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-2">
        {#each Object.entries(rec.data) as [k, v]}
          <div class="flex gap-2 text-sm">
            <dt class="w-40 shrink-0 font-medium text-gray-500">{k}</dt>
            <dd class="text-gray-900">{v == null ? '—' : String(v)}</dd>
          </div>
        {/each}
      </dl>
    </Card>

    <Card title="Built indices" bodyClass="">
      {#if indices && !indices.ok}
        <p class="px-4 py-6 text-center text-red-700">HTTP {indices.status} — {indices.detail}</p>
      {:else if indices?.ok}
        <table class="min-w-full divide-y divide-gray-200 text-sm">
          <thead class="bg-gray-50">
            <tr>
              {#each ['Type', 'Indices', 'Sharded', 'Subjects', 'Features'] as h}
                <th class="px-4 py-2 text-left text-xs font-semibold tracking-wide text-gray-500 uppercase">{h}</th>
              {/each}
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            {#each summary as s (s.type)}
              <tr>
                <td class="px-4 py-2 font-medium text-gray-900">{s.type}</td>
                <td class="px-4 py-2 text-gray-600">{fmt(s.count)}</td>
                <td class="px-4 py-2 text-gray-600">{s.sharded ? `${fmt(s.sharded)} shards` : '—'}</td>
                <td class="px-4 py-2 text-gray-600">{s.subjects ? fmt(s.subjects) : '—'}</td>
                <td class="px-4 py-2 text-gray-600">{s.features ? fmt(s.features) : '—'}</td>
              </tr>
            {:else}
              <tr><td colspan="5" class="px-4 py-6 text-center text-gray-500">No indices built.</td></tr>
            {/each}
          </tbody>
        </table>
      {:else}
        <p class="px-4 py-6 text-center text-gray-400">Loading…</p>
      {/if}
    </Card>

    {#if sylphFiles.length}
    <!-- Sylph databases sketched from this reference's genomes, registered where
         they sit; a profile names one of them. -->
    <Card title="Sylph databases" bodyClass="">
      <table class="min-w-full divide-y divide-gray-200 text-sm">
        <thead class="bg-gray-50">
          <tr>
            {#each ['Label', 'Path', 'Size', 'sha256', 'Registered'] as h}
              <th class="px-4 py-2 text-left text-xs font-semibold tracking-wide text-gray-500 uppercase">{h}</th>
            {/each}
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-100">
          {#each sylphFiles as f (f.reference_index_idx)}
            <tr>
              <td class="px-4 py-2 font-medium whitespace-nowrap text-gray-900"
                >{f.params?.label ?? '—'}{#if f.params?.format} · {f.params.format}{/if}</td
              >
              <td class="px-4 py-2 font-mono text-xs break-all">{f.fs_path}</td>
              <td class="px-4 py-2 whitespace-nowrap">{f.params?.size_bytes ? bytes(n(f.params.size_bytes)) : '—'}</td>
              <td class="px-4 py-2 font-mono text-xs" title={String(f.params?.sha256 ?? '')}
                >{String(f.params?.sha256 ?? '—').slice(0, 12)}</td
              >
              <td class="px-4 py-2 whitespace-nowrap">{new Date(f.created_at).toLocaleString()}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </Card>
    {/if}

    <div class="grid grid-cols-1 gap-6 md:grid-cols-2">
      <Card title="Exclusions">
        {#if excl?.ok}
          {#if excl.data.length}
            <p class="text-sm text-gray-700">{fmt(excl.data.length)} excluded features.</p>
          {:else}
            <p class="text-sm text-gray-500">No exclusions.</p>
          {/if}
        {:else if excl && !excl.ok}
          <p class="text-sm text-red-700">HTTP {excl.status} — {excl.detail}</p>
        {:else}
          <p class="text-sm text-gray-400">Loading…</p>
        {/if}
      </Card>

      <Card title="Genome map">
        {#if gmap?.ok}
          <p class="text-sm text-gray-700">
            {gmapCount ? `${fmt(gmapCount)} genome entries.` : 'No genome map for this reference.'}
          </p>
        {:else if gmap && !gmap.ok}
          <p class="text-sm text-gray-500">Not available (HTTP {gmap.status}).</p>
        {:else}
          <p class="text-sm text-gray-400">Loading…</p>
        {/if}
      </Card>
    </div>
  </div>
{/if}
