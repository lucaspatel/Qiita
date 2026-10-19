<script lang="ts">
  import { page } from '$app/state';
  import { auth } from '$lib/auth.svelte';
  import { api, type ApiResult, type StudyAccessRow, type StudySequencedPool } from '$lib/api';
  import { addRecent } from '$lib/recents';
  import PageHeading from '$lib/ui/PageHeading.svelte';
  import Card from '$lib/ui/Card.svelte';
  import Modal from '$lib/ui/Modal.svelte';
  import SampleUploader from '$lib/features/metadata/SampleUploader.svelte';
  import SampleGrid from '$lib/features/metadata/SampleGrid.svelte';
  import StudyPools from '$lib/ui/StudyPools.svelte';
  import Tabs from '$lib/ui/Tabs.svelte';
  import Spinner from '$lib/ui/Spinner.svelte';
  import { metadataColumns } from '$lib/features/metadata/samples';
  import { studyMetadata } from '$lib/studyMetadata.svelte';
  import { settings } from '$lib/settings.svelte';
  import { humanizeLabel, fmtDate } from '$lib/utils';
  import { insdcAccessionUrl } from '$lib/ena';


  // --- study record, split across tabs ---
  let tab = $state('overview');
  // Overview shows the prose fields full-width; everything else (except the title,
  // which is the page heading) falls to Details, so a new field is never dropped.
  const OVERVIEW_KEYS = ['description', 'abstract'];
  const DETAILS_EXCLUDE = new Set(['title', ...OVERVIEW_KEYS]);
  const ACCESSION_KEYS = new Set(['ena_study_accession', 'bioproject_accession']);
  const TIER_CLASS: Record<string, string> = {
    admin: 'bg-purple-50 text-purple-700 ring-purple-600/20',
    member: 'bg-teal-50 text-teal-700 ring-teal-600/20',
    viewer: 'bg-gray-50 text-gray-600 ring-gray-500/10',
    public: 'bg-gray-50 text-gray-600 ring-gray-500/10'
  };
  const label = (k: string) => (settings.humanizeLabels ? humanizeLabel(k) : k);

  const studyIdx = $derived(Number(page.params.study_idx));
  let loading = $state(false);
  let record = $state<ApiResult<Record<string, unknown>> | null>(null);
  let access = $state<ApiResult<StudyAccessRow[]> | null>(null);
  let pools = $state<StudySequencedPool[]>([]);
  // The study's biosamples live in the shared store, loaded once per study.
  const samples = $derived(studyMetadata.studyIdx === studyIdx ? studyMetadata.samples : []);
  const total = $derived(studyMetadata.studyIdx === studyIdx ? studyMetadata.total : 0);
  const sampleErr = $derived(studyMetadata.studyIdx === studyIdx ? studyMetadata.error : '');
  const samplesLoading = $derived(studyMetadata.studyIdx !== studyIdx || studyMetadata.loading);
  let addOpen = $state(false);
  let loadSeq = 0;
  let loadedFor = -1;

  // Built once the samples are in, not on every streamed batch.
  const columns = $derived(samplesLoading ? [] : metadataColumns(samples));
  // The grid mounts a frame after its tab is selected, so the tab moves first and
  // a spinner covers the render.
  let gridReady = $state(false);
  $effect(() => {
    if (tab !== 'samples' || samplesLoading) {
      gridReady = false;
      return;
    }
    const id = requestAnimationFrame(() => requestAnimationFrame(() => (gridReady = true)));
    return () => cancelAnimationFrame(id);
  });
  const rec = $derived(record?.ok ? record.data : null);
  const studyTitle = $derived(
    rec && typeof rec.title === 'string' && rec.title ? rec.title : `Study ${studyIdx}`
  );
  const overviewFields = $derived(OVERVIEW_KEYS.filter((k) => rec && k in rec));
  const hasOverview = $derived(!!rec && OVERVIEW_KEYS.some((k) => rec[k] != null && rec[k] !== ''));
  const detailFields = $derived(rec ? Object.keys(rec).filter((k) => !DETAILS_EXCLUDE.has(k)) : []);
  const poolsSummary = $derived.by(() => {
    if (!pools.length) return null;
    const platforms = [...new Set(pools.map((p) => p.instrument_model).filter(Boolean))].join(', ');
    const n = pools.reduce((a, p) => a + p.sample_count, 0);
    return `${pools.length} · ${platforms || 'unknown platform'} · ${n} samples`;
  });
  const TABS = $derived([
    { id: 'overview', label: 'Overview' },
    { id: 'samples', label: total ? `Samples (${total})` : 'Samples' },
    { id: 'details', label: 'Details' },
    { id: 'access', label: 'Access' }
  ]);

  // Auto-load when the route idx (or auth) changes.
  $effect(() => {
    const i = studyIdx;
    if (auth.isSet && i && loadedFor !== i) {
      loadedFor = i;
      load(i);
    }
  });

  async function load(i: number, { force = false } = {}) {
    const seq = ++loadSeq;
    loading = true;
    access = null;
    pools = [];
    // Metadata starts loading now, alongside the record, for every tab and plot.
    const listed = studyMetadata.load(i, { force });
    record = await api.studyRecord(i);
    // Access list (member+ only) loads alongside — never blocks sample loading.
    api.studyAccess(i).then((r) => {
      if (seq === loadSeq) access = r;
    });
    // Pools summary for the Details tab; non-blocking.
    api.studyPools(i).then((r) => {
      if (seq === loadSeq) pools = r.ok ? r.data.sequenced_pool : [];
    });
    const ok = await listed;
    if (seq !== loadSeq) return;
    if (settings.rememberRecents)
      addRecent({
        idx: i,
        accessible: ok,
        biosampleCount: ok ? studyMetadata.total : null,
        lastOpened: Date.now()
      });
    loading = false;
  }
</script>

<div class="mb-3">
  <a href="/studies" class="text-sm text-teal-700 hover:underline">← Studies</a>
</div>

<PageHeading title={studyTitle}>
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

{#snippet fieldRow(k: string, v: unknown)}
  <div class="flex gap-2 text-sm">
    <dt class="w-44 shrink-0 font-medium text-gray-500">{label(k)}</dt>
    <dd class="min-w-0 break-words text-gray-900">
      {#if v == null || v === ''}
        —
      {:else if ACCESSION_KEYS.has(k)}
        <a
          href={insdcAccessionUrl(String(v))}
          target="_blank"
          rel="noopener"
          class="text-teal-700 hover:underline"
          >{v}<svg class="ml-0.5 inline size-3 align-[-1px]" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M11 3a1 1 0 100 2h2.586l-6.293 6.293a1 1 0 101.414 1.414L15 6.414V9a1 1 0 102 0V4a1 1 0 00-1-1h-5z" /><path d="M5 5a2 2 0 00-2 2v8a2 2 0 002 2h8a2 2 0 002-2v-3a1 1 0 10-2 0v3H5V7h3a1 1 0 000-2H5z" /></svg></a
        >
      {:else if k.endsWith('_at')}
        {fmtDate(v)}
      {:else if typeof v === 'object'}
        {@const entries = Object.entries(v as Record<string, unknown>)}
        {#if entries.length}
          <dl class="space-y-0.5">
            {#each entries as [sk, sv]}
              <div class="flex gap-2">
                <dt class="w-40 shrink-0 text-gray-400">{label(sk)}</dt>
                <dd class="min-w-0 break-words text-gray-700">{sv == null || sv === '' ? '—' : String(sv)}</dd>
              </div>
            {/each}
          </dl>
        {:else}
          <span class="text-gray-400">(empty)</span>
        {/if}
      {:else}
        {String(v)}
      {/if}
    </dd>
  </div>
{/snippet}

{#if record}
  <div class="mb-4">
    {#if record.ok}
      <Card bodyClass="">
        <div class="border-b border-gray-200 px-4 pt-1 sm:px-6">
          <Tabs tabs={TABS} bind:active={tab} />
        </div>
        <!-- The samples grid runs flush to the card edges; other tabs are padded. -->
        <div class={tab === 'samples' ? '' : 'px-4 py-4 sm:px-6'}>
          {#if tab === 'overview'}
            {#if hasOverview}
              <dl class="space-y-4">
                {#each overviewFields as k (k)}
                  <div>
                    <dt class="mb-1 text-sm font-medium text-gray-500">{label(k)}</dt>
                    <dd class="text-sm whitespace-pre-wrap break-words text-gray-900">
                      {record.data[k] == null || record.data[k] === '' ? '—' : String(record.data[k])}
                    </dd>
                  </div>
                {/each}
              </dl>
            {:else}
              <p class="text-sm text-gray-500">No description or abstract for this study.</p>
            {/if}
          {:else if tab === 'samples'}
            {#if sampleErr}
              <p class="px-4 py-6 text-center text-amber-800">{sampleErr}</p>
            {:else if samplesLoading || (samples.length && !gridReady)}
              <Spinner label={samplesLoading ? `Loading ${samples.length} of ${total} samples…` : ''} />
            {:else if samples.length}
              <SampleGrid {samples} {columns} {total} bare />
            {:else}
              <p class="px-4 py-6 text-center text-gray-500">No samples linked to this study.</p>
            {/if}
          {:else if tab === 'details'}
            <dl class="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
              {#if pools.length}
                <div class="flex gap-2 text-sm">
                  <dt class="w-44 shrink-0 font-medium text-gray-500">Sequenced pools</dt>
                  <dd class="min-w-0 break-words text-gray-900">
                    <p class="text-gray-500">{poolsSummary}</p>
                    <ul class="mt-1 space-y-0.5">
                      {#each pools as p (p.sequenced_pool_idx)}
                        <li>
                          <a class="font-medium text-teal-700 hover:text-teal-800 hover:underline" href="/sequencing/pool/{p.sequencing_run_idx}/{p.sequenced_pool_idx}">pool #{p.sequenced_pool_idx}</a>
                          <span class="text-gray-500"> · {p.instrument_model || 'unknown platform'} · {p.sample_count} samples</span>
                        </li>
                      {/each}
                    </ul>
                  </dd>
                </div>
              {/if}
              {#each detailFields as k (k)}{@render fieldRow(k, record.data[k])}{/each}
            </dl>
          {:else if tab === 'access'}
            {#if access?.ok && access.data.length}
              <table class="min-w-full divide-y divide-gray-200 text-sm">
                <thead>
                  <tr>
                    {#each ['Principal', 'Tier', 'Granted'] as h}
                      <th class="py-2 pr-4 text-left text-xs font-semibold tracking-wide text-gray-500 uppercase">{h}</th>
                    {/each}
                  </tr>
                </thead>
                <tbody class="divide-y divide-gray-100">
                  {#each access.data as a (a.principal_idx)}
                    <tr>
                      <td class="py-2 pr-4 text-gray-800">{a.email ?? `principal ${a.principal_idx}`}</td>
                      <td class="py-2 pr-4">
                        <span class="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium capitalize ring-1 ring-inset {TIER_CLASS[a.access_tier]}">{a.access_tier}</span>
                      </td>
                      <td class="py-2 pr-4 text-gray-500">{fmtDate(a.granted_at)}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            {:else if access && !access.ok && access.status === 403}
              <p class="text-sm text-gray-500">The access list is visible to members and admins of this study.</p>
            {:else}
              <p class="text-sm text-gray-500">{access ? 'No access entries.' : 'Loading…'}</p>
            {/if}
          {/if}
        </div>
      </Card>
    {:else if record.status === 403}
      <Card title="Study record">
        <div class="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-amber-600/20">
          Study record restricted at your tier — {record.detail}. Sample metadata below is still readable.
        </div>
      </Card>
    {:else}
      <Card title="Study record">
        <p class="text-sm text-red-700">HTTP {record.status} — {record.detail}</p>
      </Card>
    {/if}
  </div>
{/if}

{#if auth.isSet}
  <StudyPools {studyIdx} />
{/if}

<Modal bind:open={addOpen} size="full" title="Add samples to study {studyIdx}">
  <SampleUploader studyIdx={Number(studyIdx)} onUploaded={() => load(studyIdx, { force: true })} />
</Modal>
