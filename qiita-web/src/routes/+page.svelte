<script lang="ts">
  // Home: what needs the signed-in user and where they were. Each card loads on its own,
  // so a slow or failing read empties one card, with a retry, and never the page.
  import { onMount } from 'svelte';
  import { auth } from '$lib/auth.svelte';
  import { api, type ApiResult, type StudySummaryList, type Whoami, type WorkTicketListResponse } from '$lib/api';
  import { pageOf, recentTickets, sharedWithMe, stats } from '$lib/features/dashboard/summary';
  import { listDrafts } from '$lib/features/library-prep/drafts';
  import { getRecents, type RecentStudy } from '$lib/recents';
  import { isAdminRole } from '$lib/roles';
  import { actionLabel, STATE_CLASS, ticketSubject, when } from '$lib/tickets';
  import Card from '$lib/ui/Card.svelte';
  import PageHeading from '$lib/ui/PageHeading.svelte';
  import Spinner from '$lib/ui/Spinner.svelte';
  import Tabs from '$lib/ui/Tabs.svelte';

  const JOBS_PER_PAGE = 8;

  let me = $state<Whoami | null>(null);
  let ticketsRes = $state<ApiResult<WorkTicketListResponse> | null>(null);
  let studiesRes = $state<ApiResult<StudySummaryList> | null>(null);
  let recents = $state<RecentStudy[]>([]);
  let drafts = $state(0);
  let jobsPage = $state(0);
  let studyTab = $state<'recent' | 'shared'>('recent');

  const loadTickets = async () => {
    ticketsRes = null;
    ticketsRes = await api.tickets({ limit: 50 });
  };
  const loadStudies = async () => {
    studiesRes = null;
    // Owned or shared with the caller: a tier above public is only ever their own grant.
    studiesRes = await api.studies({ min_tier: 'viewer', limit: 500 });
  };

  onMount(() => {
    recents = getRecents();
    if (!recents.length) studyTab = 'shared';
    drafts = listDrafts().length;
    if (!auth.isSet) return;
    api.whoami().then((r) => (me = r.ok ? r.data : null));
    void loadTickets();
    void loadStudies();
  });

  const tickets = $derived(ticketsRes?.ok ? ticketsRes.data.tickets : []);
  const studies = $derived(studiesRes?.ok ? studiesRes.data.studies : []);
  const counts = $derived(stats(tickets, studies, Date.now()));
  const titleOf = $derived(new Map(studies.map((s) => [s.study_idx, s.title])));
  const staff = $derived(isAdminRole(me?.system_role));
  const jobs = $derived(pageOf(recentTickets(tickets), jobsPage, JOBS_PER_PAGE));
  const shared = $derived(sharedWithMe(studies, 10));
  const newUser = $derived(ticketsRes?.ok && studiesRes?.ok && !tickets.length && !studies.length && !recents.length);
</script>

<PageHeading title="Home" subtitle={me ? `Signed in as ${me.email}` : ''} />

{#snippet failed(res: { status: number; detail: string }, retry: () => void)}
  <div class="flex items-center justify-between gap-3 px-4 py-4 text-sm sm:px-6">
    <span class="text-red-700">Couldn't load: HTTP {res.status} — {res.detail}</span>
    <button class="shrink-0 font-medium text-teal-700 hover:underline" onclick={retry}>Retry</button>
  </div>
{/snippet}

{#snippet link(href: string, label: string, detail: string)}
  <li class="relative px-4 py-3 hover:bg-gray-50 sm:px-6">
    <a {href} class="text-sm font-medium text-gray-900"><span class="absolute inset-0"></span>{label}</a>
    <p class="mt-0.5 text-xs text-gray-500">{detail}</p>
  </li>
{/snippet}

{#if !auth.isSet}
  <Card><p class="py-8 text-center text-gray-500">Log in to see your jobs and studies.</p></Card>
{:else if newUser}
  <Card title="Where to start">
    <ul class="-mx-4 -my-4 divide-y divide-gray-100 sm:-mx-6">
      {@render link('/studies', 'Create or open a study', 'Studies hold samples and their metadata.')}
      {@render link('/workflows', 'Run a workflow', 'Profile, assemble or import from ENA.')}
      {#if staff}{@render link('/library-prep', 'Start a library prep', 'From the scanned racks to the sample sheet.')}{/if}
    </ul>
  </Card>
{:else}
  <dl class="mb-6 grid grid-cols-2 divide-gray-200 overflow-hidden rounded-lg bg-white shadow-sm ring-1 ring-gray-200 md:grid-cols-4 md:divide-x" aria-label="At a glance">
    {#each [
      { label: 'Running jobs', value: counts.running, href: '/tickets', ready: ticketsRes?.ok },
      { label: 'Failed this week', value: counts.failedThisWeek, href: '/tickets', ready: ticketsRes?.ok, alarm: counts.failedThisWeek > 0 },
      { label: 'Your studies', value: counts.ownStudies, href: '/studies', ready: studiesRes?.ok },
      { label: 'Shared with you', value: counts.sharedStudies, href: '/studies', ready: studiesRes?.ok }
    ] as s (s.label)}
      <a href={s.href} class="block px-4 py-4 hover:bg-gray-50 sm:px-6">
        <dt class="text-sm text-gray-600">{s.label}</dt>
        <dd class="mt-1 text-2xl font-semibold {s.alarm ? 'text-red-700' : 'text-teal-700'}">{s.ready ? s.value : '—'}</dd>
      </a>
    {/each}
  </dl>

  <div class="grid grid-cols-1 gap-6 lg:grid-cols-3">
    <div class="lg:col-span-2">
      <Card title="Your jobs" bodyClass="">
        {#snippet actions()}<a href="/tickets" class="text-sm font-medium text-teal-700 hover:underline">All jobs</a>{/snippet}
        {#if !ticketsRes}
          <div class="py-6"><Spinner /></div>
        {:else if !ticketsRes.ok}
          {@render failed(ticketsRes, loadTickets)}
        {:else if tickets.length}
          <ul class="divide-y divide-gray-100" aria-label="Your jobs">
            {#each jobs.items as t (t.work_ticket_idx)}
              <li class="relative flex items-center justify-between gap-x-4 px-4 py-3 hover:bg-gray-50 sm:px-6">
                <div class="min-w-0">
                  <a href="/tickets/{t.work_ticket_idx}" class="text-sm font-medium text-gray-900">
                    <span class="absolute inset-0"></span>{actionLabel(t.action_id)}
                  </a>
                  <p class="mt-0.5 truncate text-xs text-gray-500">
                    {ticketSubject(t) ?? `#${t.work_ticket_idx}`} · {when(t.updated_at)}
                    {#if t.state === 'failed' && t.failure_step_name}· failed at {t.failure_step_name}{/if}
                  </p>
                </div>
                <span class="inline-flex shrink-0 items-center rounded-md px-2 py-0.5 text-xs font-medium capitalize ring-1 ring-inset {STATE_CLASS[t.state]}">{t.state.replace('_', ' ')}</span>
              </li>
            {/each}
          </ul>
          {#if jobs.pages > 1}
            <nav class="flex items-center justify-between border-t border-gray-200 px-4 py-3 sm:px-6" aria-label="Jobs pages">
              <p class="text-sm text-gray-700">
                {jobs.from}–{jobs.to} of {tickets.length}{#if ticketsRes.data.truncated}
                  latest · <a href="/tickets" class="font-medium text-teal-700 hover:underline">all jobs</a>{/if}
              </p>
              <div class="flex gap-3">
                {#each [{ label: 'Previous', to: jobs.page - 1, off: jobs.page === 0 }, { label: 'Next', to: jobs.page + 1, off: jobs.page === jobs.pages - 1 }] as b (b.label)}
                  <button
                    class="rounded-md bg-white px-3 py-1.5 text-sm font-semibold text-gray-900 ring-1 ring-gray-300 ring-inset hover:bg-gray-50 disabled:opacity-40 disabled:hover:bg-white"
                    disabled={b.off}
                    onclick={() => (jobsPage = b.to)}>{b.label}</button
                  >
                {/each}
              </div>
            </nav>
          {/if}
        {:else}
          <p class="px-4 py-6 text-center text-sm text-gray-500 sm:px-6">No jobs yet. <a href="/workflows" class="text-teal-700 hover:underline">Run a workflow</a>.</p>
        {/if}
      </Card>
    </div>

    <div class="flex flex-col gap-6">
      <Card bodyClass="">
        <div class="border-b border-gray-200 px-4 sm:px-6">
          <Tabs
            label="Studies"
            bind:active={studyTab}
            tabs={[
              { id: 'recent', label: 'Recent' },
              { id: 'shared', label: 'Shared', count: studiesRes?.ok ? counts.sharedStudies : undefined }
            ]}
          />
        </div>
        {#if studyTab === 'recent'}
          {#if recents.length}
            <ul class="divide-y divide-gray-100" aria-label="Recently opened">
              {#each recents.slice(0, 10) as r (r.idx)}
                {@render link(`/studies/${r.idx}`, titleOf.get(r.idx) ?? `Study ${r.idx}`, `Opened ${when(new Date(r.lastOpened).toISOString())}`)}
              {/each}
            </ul>
          {:else}
            <p class="px-4 py-6 text-center text-sm text-gray-500 sm:px-6">Studies you open show here. <a href="/studies" class="text-teal-700 hover:underline">Browse studies</a>.</p>
          {/if}
        {:else if !studiesRes}
          <div class="py-6"><Spinner /></div>
        {:else if !studiesRes.ok}
          {@render failed(studiesRes, loadStudies)}
        {:else if shared.length}
          <ul class="divide-y divide-gray-100" aria-label="Shared with you">
            {#each shared as s (s.study_idx)}
              {@render link(`/studies/${s.study_idx}`, s.title, s.granted_at ? `Shared ${when(s.granted_at)} · ${s.caller_tier}` : s.caller_tier)}
            {/each}
          </ul>
        {:else}
          <p class="px-4 py-6 text-center text-sm text-gray-500 sm:px-6">Nothing shared with you yet.</p>
        {/if}
      </Card>

      <Card title="Start" bodyClass="">
        <ul class="divide-y divide-gray-100">
          {#if staff}
            {@render link('/library-prep', drafts ? `Library prep · ${drafts} saved` : 'Start a library prep', drafts ? 'Resume a saved prep or start one.' : 'From the scanned racks to the sample sheet.')}
          {/if}
          {@render link('/studies', 'Open or create a study', 'Upload and check its metadata on the Samples tab.')}
          {@render link('/workflows', 'Run a workflow', 'Profile, assemble or import from ENA.')}
        </ul>
      </Card>

      <Card title="Catalogs" bodyClass="">
        <ul class="divide-y divide-gray-100">
          {@render link('/references', 'Reference databases', 'What profiling and alignment run against.')}
          {@render link('/prep-protocols', 'Prep protocols', 'The library-prep methods this deployment knows.')}
        </ul>
      </Card>
    </div>
  </div>
{/if}
