<script module lang="ts">
  import type { Biosample } from '$lib/api';
  const bsCache = new Map<number, Biosample>();
</script>

<script lang="ts">
  import { page } from '$app/state';
  import { auth } from '$lib/auth.svelte';
  import { api, type ApiResult, type StudyAccessRow } from '$lib/api';
  import { addRecent } from '$lib/recents';
  import PageHeading from '$lib/ui/PageHeading.svelte';
  import Card from '$lib/ui/Card.svelte';
  import Modal from '$lib/ui/Modal.svelte';
  import SampleUploader from '$lib/ui/SampleUploader.svelte';
  import SampleGrid from '$lib/ui/SampleGrid.svelte';
  import { metadataColumns } from '$lib/samples';
  import { settings } from '$lib/settings.svelte';

  const CONC = 12;

  const studyIdx = $derived(Number(page.params.study_idx));
  let loading = $state(false);
  let record = $state<ApiResult<Record<string, unknown>> | null>(null);
  let access = $state<ApiResult<StudyAccessRow[]> | null>(null);
  let total = $state(0);
  let samples = $state<Biosample[]>([]);
  let sampleErr = $state('');
  let addOpen = $state(false);
  let loadSeq = 0;
  let loadedFor = -1;

  const columns = $derived(metadataColumns(samples));

  // Auto-load when the route idx (or auth) changes.
  $effect(() => {
    const i = studyIdx;
    if (auth.isSet && i && loadedFor !== i) {
      loadedFor = i;
      load(i);
    }
  });

  async function load(i: number) {
    const seq = ++loadSeq;
    loading = true;
    samples = [];
    sampleErr = '';
    access = null;
    record = await api.studyRecord(i);
    // Access list (member+ only) loads alongside — never blocks sample loading.
    api.studyAccess(i).then((r) => {
      if (seq === loadSeq) access = r;
    });
    const list = await api.biosampleIdxs(i);
    if (seq !== loadSeq) return;
    if (!list.ok) {
      sampleErr = `samples: HTTP ${list.status} — ${list.detail}`;
      total = 0;
      loading = false;
      if (settings.rememberRecents)
        addRecent({ idx: i, accessible: false, biosampleCount: null, lastOpened: Date.now() });
      return;
    }
    const idxs = list.data.idxs;
    total = idxs.length;
    if (settings.rememberRecents)
      addRecent({ idx: i, accessible: true, biosampleCount: total, lastOpened: Date.now() });
    samples = idxs.map((x) => bsCache.get(x)).filter((b): b is Biosample => !!b);
    const missing = idxs.filter((x) => !bsCache.has(x));
    for (let k = 0; k < missing.length; k += CONC) {
      const rs = await Promise.all(missing.slice(k, k + CONC).map((x) => api.biosample(x)));
      if (seq !== loadSeq) return;
      const got = rs.flatMap((r) => (r.ok ? [r.data] : []));
      for (const b of got) bsCache.set(b.biosample_idx, b);
      samples = [...samples, ...got];
    }
    loading = false;
  }
</script>

<div class="mb-3">
  <a href="/studies" class="text-sm text-teal-700 hover:underline">← Studies</a>
</div>

<PageHeading title="Study {studyIdx}" subtitle="Samples and metadata.">
  {#snippet actions()}
    {#if auth.isSet}
      <button
        class="rounded-md bg-teal-700 px-4 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-teal-600"
        onclick={() => (addOpen = true)}>Add samples</button>
    {/if}
  {/snippet}
</PageHeading>

{#if !auth.isSet}
  <Card><p class="py-8 text-center text-gray-500">Log in to view a study.</p></Card>
{/if}

{#if record}
  <div class="mb-4">
    <Card title="Study record">
      {#if record.ok}
        <dl class="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
          {#each Object.entries(record.data) as [k, v]}
            <div class="flex gap-2 text-sm">
              <dt class="w-44 shrink-0 font-medium text-gray-500">{k}</dt>
              <dd class="text-gray-900">{v == null ? '—' : String(v)}</dd>
            </div>
          {/each}
        </dl>
      {:else if record.status === 403}
        <div class="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-amber-600/20">
          Study record restricted at your tier — {record.detail}. Sample metadata below is still readable.
        </div>
      {:else}
        <p class="text-sm text-red-700">HTTP {record.status} — {record.detail}</p>
      {/if}
    </Card>
  </div>
{/if}

{#if access?.ok && access.data.length}
  {@const TIER = {
    admin: 'bg-purple-50 text-purple-700 ring-purple-600/20',
    member: 'bg-teal-50 text-teal-700 ring-teal-600/20',
    viewer: 'bg-gray-50 text-gray-600 ring-gray-500/10',
    public: 'bg-gray-50 text-gray-600 ring-gray-500/10'
  }}
  <div class="mb-4">
    <Card title="Access" bodyClass="">
      <table class="min-w-full divide-y divide-gray-200 text-sm">
        <thead class="bg-gray-50">
          <tr>
            {#each ['Principal', 'Tier', 'Granted'] as h}
              <th class="px-4 py-2 text-left text-xs font-semibold tracking-wide text-gray-500 uppercase">{h}</th>
            {/each}
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-100">
          {#each access.data as a (a.principal_idx)}
            <tr class="hover:bg-gray-50">
              <td class="px-4 py-2 text-gray-800">{a.email ?? `principal ${a.principal_idx}`}</td>
              <td class="px-4 py-2">
                <span class="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium capitalize ring-1 ring-inset {TIER[a.access_tier]}">{a.access_tier}</span>
              </td>
              <td class="px-4 py-2 text-gray-500">{new Date(a.granted_at).toLocaleDateString()}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </Card>
  </div>
{:else if access && !access.ok && access.status === 403}
  <div class="mb-4">
    <Card title="Access">
      <p class="text-sm text-gray-500">The access list is visible to members and admins of this study.</p>
    </Card>
  </div>
{/if}

{#if sampleErr}
  <Card><p class="py-6 text-center text-amber-800">{sampleErr}</p></Card>
{:else if samples.length || loading}
  <SampleGrid {samples} {columns} {total} {loading} />
{/if}

<Modal bind:open={addOpen} title="Add samples to study {studyIdx}">
  <SampleUploader studyIdx={Number(studyIdx)} onUploaded={() => load(studyIdx)} />
</Modal>
