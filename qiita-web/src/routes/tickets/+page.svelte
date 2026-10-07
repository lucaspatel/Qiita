<script lang="ts">
  import { auth } from '$lib/auth.svelte';
  import { api, type WorkTicketSummary, type ApiResult, type WorkTicketListResponse } from '$lib/api';
  import { scopeLabel, STATE_CLASS, ticketSubject, when } from '$lib/tickets';
  import { isAdminRole } from '$lib/roles';
  import PageHeading from '$lib/ui/PageHeading.svelte';
  import Card from '$lib/ui/Card.svelte';
  import Select from '$lib/ui/Select.svelte';

  const FILTERS = ['all', 'active', 'completed', 'failed', 'no_data', 'cancelled'] as const;
  let filter = $state<(typeof FILTERS)[number]>('all');
  let loading = $state(false);
  let res = $state<ApiResult<WorkTicketListResponse> | null>(null);
  let loadSeq = 0;
  // Admins can list everyone's tickets (the server's `all=true`, wet_lab_admin+):
  // e.g. an ENA import that reused a download ticket another admin started.
  let me = $state<{ principal_idx: number; admin: boolean } | null>(null);
  let everyone = $state(false);

  const tickets = $derived<WorkTicketSummary[]>(res?.ok ? res.data.tickets : []);

  async function load() {
    const seq = ++loadSeq;
    loading = true;
    const q =
      filter === 'all' ? {} : filter === 'active' ? { active: true } : { state: filter };
    const r = await api.tickets({ ...q, all: everyone || undefined, limit: 200 });
    if (seq === loadSeq) {
      res = r;
      loading = false;
    }
  }

  $effect(() => {
    if (!auth.isSet) {
      me = null;
      everyone = false;
      return;
    }
    api.whoami().then((r) => {
      me = r.ok ? { principal_idx: r.data.principal_idx, admin: isAdminRole(r.data.system_role) } : null;
    });
  });

  // (Re)load when auth arrives or the filter / scope changes.
  $effect(() => {
    filter;
    everyone;
    if (auth.isSet) load();
    else res = null;
  });
</script>

<PageHeading
  title="Jobs"
  subtitle={everyone
    ? "Everyone's work tickets — pipeline runs, newest activity first."
    : 'Work tickets you submitted — pipeline runs, newest activity first.'}
>
  {#snippet actions()}
    {#if me?.admin}
      <span class="inline-flex rounded-md shadow-sm ring-1 ring-gray-300 ring-inset">
        {#each [['Mine', false], ['Everyone', true]] as [label, value]}
          <button
            class="px-3 py-1.5 text-sm font-medium first:rounded-l-md last:rounded-r-md {everyone ===
            value
              ? 'bg-teal-700 text-white'
              : 'bg-white text-gray-700 hover:bg-gray-50'}"
            onclick={() => (everyone = value as boolean)}>{label}</button
          >
        {/each}
      </span>
    {/if}
    <Select bind:value={filter} class="w-40 capitalize">
      {#each FILTERS as f}
        <option value={f}>{f.replace('_', ' ')}</option>
      {/each}
    </Select>
    <button
      class="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-teal-700 ring-1 ring-teal-600/30 ring-inset hover:bg-teal-50 disabled:opacity-40"
      onclick={load}
      disabled={!auth.isSet || loading}>{loading ? 'Loading…' : 'Refresh'}</button
    >
  {/snippet}
</PageHeading>

{#if !auth.isSet}
  <Card><p class="py-8 text-center text-gray-500">Log in to see your jobs.</p></Card>
{:else if res && !res.ok}
  <Card><p class="py-6 text-center text-red-700">HTTP {res.status} — {res.detail}</p></Card>
{:else}
  <Card bodyClass="">
    {#if tickets.length}
      <div class="overflow-x-auto">
        <table class="min-w-full divide-y divide-gray-200 text-sm">
          <thead class="bg-gray-50">
            <tr>
              {#each ['Ticket', 'Action', 'Target', ...(everyone ? ['Submitted by'] : []), 'State', 'Current step', 'Compute', 'Updated'] as h}
                <th class="px-3 py-2 text-left text-xs font-semibold tracking-wide whitespace-nowrap text-gray-500 uppercase">{h}</th>
              {/each}
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            {#each tickets as t (t.work_ticket_idx)}
              <tr class="hover:bg-gray-50">
                <td class="px-3 py-2 font-medium whitespace-nowrap">
                  <a href="/tickets/{t.work_ticket_idx}" class="text-teal-700 hover:underline">#{t.work_ticket_idx}</a>
                </td>
                <td class="px-3 py-2 whitespace-nowrap text-gray-700">
                  {t.action_id}<span class="text-gray-400"> @{t.action_version}</span>
                </td>
                <td class="px-3 py-2 whitespace-nowrap text-gray-600">
                  {#if ticketSubject(t)}
                    <span class="font-medium text-gray-800">{ticketSubject(t)}</span>
                    <span class="block text-xs text-gray-400">{scopeLabel(t.scope_target)}</span>
                  {:else}{scopeLabel(t.scope_target)}{/if}
                </td>
                {#if everyone}
                  <td class="px-3 py-2 whitespace-nowrap text-gray-500">
                    {t.originator_principal_idx === me?.principal_idx ? 'you' : `principal ${t.originator_principal_idx}`}
                  </td>
                {/if}
                <td class="px-3 py-2">
                  <span class="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium capitalize ring-1 ring-inset {STATE_CLASS[t.state]}">{t.state.replace('_', ' ')}</span>
                </td>
                <td class="px-3 py-2 whitespace-nowrap text-gray-600">
                  {#if t.current_step_name}
                    {t.current_step_name}
                    {#if t.step_state}<span class="text-gray-400"> · {t.step_state}</span>{/if}
                  {:else}<span class="text-gray-400">—</span>{/if}
                </td>
                <td class="px-3 py-2 whitespace-nowrap text-gray-500">
                  {#if t.compute_target}
                    {t.compute_target}{#if t.slurm_job_id}<span class="text-gray-400"> · {t.slurm_job_id}</span>{/if}
                  {:else}—{/if}
                </td>
                <td class="px-3 py-2 whitespace-nowrap text-gray-500">{when(t.updated_at)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if res?.ok && res.data.truncated}
        <p class="border-t border-gray-100 px-4 py-2 text-xs text-amber-700">
          Showing the first {res.data.count} — result was capped. Narrow with a state filter.
        </p>
      {/if}
    {:else}
      <p class="px-4 py-10 text-center text-gray-500">
        {loading ? 'Loading…' : everyone ? 'No jobs match.' : 'No jobs yet — tickets you submit will show up here.'}
      </p>
    {/if}
  </Card>
{/if}
