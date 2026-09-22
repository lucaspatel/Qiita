<script lang="ts">
  import { page } from '$app/state';
  import { auth } from '$lib/auth.svelte';
  import {
    api,
    type WorkTicket,
    type WorkTicketStepLogs,
    type ApiResult
  } from '$lib/api';
  import { scopeLabel, STATE_CLASS, when } from '$lib/tickets';
  import PageHeading from '$lib/ui/PageHeading.svelte';
  import Card from '$lib/ui/Card.svelte';

  const idx = $derived(Number(page.params.work_ticket_idx));
  let res = $state<ApiResult<WorkTicket> | null>(null);
  let loadedFor = -1;

  const t = $derived<WorkTicket | null>(res?.ok ? res.data : null);
  const hasContext = $derived(t ? Object.keys(t.action_context ?? {}).length > 0 : false);

  $effect(() => {
    const i = idx;
    if (auth.isSet && i && loadedFor !== i) {
      loadedFor = i;
      api.ticket(i).then((r) => (res = r));
    }
  });

  // Log viewer — the detail record carries no step index, so pick one. A FAILED
  // ticket names the failing step (not its index), shown below as a hint.
  let stepIndex = $state(0);
  let logs = $state<ApiResult<WorkTicketStepLogs> | null>(null);
  let logsLoading = $state(false);

  async function loadLogs() {
    logsLoading = true;
    logs = await api.ticketLogs(idx, stepIndex, { tailLines: 200 });
    logsLoading = false;
  }

  function fields(w: WorkTicket): [string, string][] {
    const rows: [string, string][] = [
      ['Action', `${w.action_id} @${w.action_version}`],
      ['Target', scopeLabel(w.scope_target)],
      ['Originator', `principal ${w.originator_principal_idx}`],
      ['Retries', `${w.retry_count} / ${w.max_retries}`],
      ['Created', when(w.created_at)],
      ['Updated', when(w.updated_at)]
    ];
    if (w.mask_idx != null) rows.push(['Mask', `mask ${w.mask_idx}`]);
    if (w.shard_id != null) rows.push(['Shard', String(w.shard_id)]);
    return rows;
  }
</script>

<div class="mb-3">
  <a href="/tickets" class="text-sm text-teal-700 hover:underline">← Jobs</a>
</div>

<PageHeading title="Ticket #{idx}" subtitle="Work-ticket lifecycle and step logs." />

{#if !auth.isSet}
  <Card><p class="py-8 text-center text-gray-500">Log in to view a ticket.</p></Card>
{:else if res && !res.ok}
  <Card>
    <p class="py-6 text-center text-red-700">HTTP {res.status} — {res.detail}</p>
    {#if res.status === 403 || res.status === 404}
      <p class="pb-4 text-center text-xs text-gray-500">
        You can only see tickets you submitted (wet_lab_admin+ sees all).
      </p>
    {/if}
  </Card>
{:else if t}
  <div class="mb-4">
    <Card title="Lifecycle">
      {#snippet actions()}
        <span class="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium capitalize ring-1 ring-inset {STATE_CLASS[t.state]}">{t.state.replace('_', ' ')}</span>
      {/snippet}
      <dl class="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
        {#each fields(t) as [k, v]}
          <div class="flex gap-2 text-sm">
            <dt class="w-28 shrink-0 font-medium text-gray-500">{k}</dt>
            <dd class="text-gray-900">{v}</dd>
          </div>
        {/each}
      </dl>
    </Card>
  </div>

  {#if t.transient_reason}
    <div class="mb-4">
      <div class="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-amber-600/20">
        Retrying in place — {t.transient_reason}{t.transient_since ? ` (since ${when(t.transient_since)})` : ''}. Still processing, not failed.
      </div>
    </div>
  {/if}

  {#if t.state === 'failed' || t.failure_reason}
    <div class="mb-4">
      <Card title="Failure">
        <dl class="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <div class="flex gap-2"><dt class="w-28 shrink-0 font-medium text-gray-500">Type</dt><dd class="text-gray-900">{t.failure_type ?? '—'}</dd></div>
          <div class="flex gap-2"><dt class="w-28 shrink-0 font-medium text-gray-500">Stage</dt><dd class="text-gray-900">{t.failure_stage ?? '—'}</dd></div>
          {#if t.failure_step_name}
            <div class="flex gap-2"><dt class="w-28 shrink-0 font-medium text-gray-500">Step</dt><dd class="text-gray-900">{t.failure_step_name}</dd></div>
          {/if}
        </dl>
        {#if t.failure_reason}
          <pre class="mt-3 overflow-x-auto rounded-md bg-red-50 p-3 text-xs whitespace-pre-wrap text-red-800 ring-1 ring-red-600/10">{t.failure_reason}</pre>
        {/if}
      </Card>
    </div>
  {/if}

  {#if hasContext}
    <div class="mb-4">
      <Card title="Action context">
        <pre class="overflow-x-auto rounded-md bg-gray-50 p-3 text-xs text-gray-700 ring-1 ring-gray-200">{JSON.stringify(t.action_context, null, 2)}</pre>
      </Card>
    </div>
  {/if}

  <Card title="Step logs">
    {#snippet actions()}
      <div class="flex items-center gap-2 text-sm">
        <label class="flex items-center gap-1 text-gray-500">
          step
          <input type="number" min="0" bind:value={stepIndex} class="w-16 rounded-md border border-gray-300 px-2 py-1" />
        </label>
        <button
          class="rounded-md bg-white px-3 py-1 font-medium text-teal-700 ring-1 ring-teal-600/30 ring-inset hover:bg-teal-50 disabled:opacity-40"
          onclick={loadLogs}
          disabled={logsLoading}>{logsLoading ? 'Loading…' : 'Load logs'}</button
        >
      </div>
    {/snippet}

    {#if !logs}
      <p class="py-6 text-center text-sm text-gray-500">
        Pick a step index and load its stdout/stderr tail.
        {#if t.failure_step_name}<br />Failing step was <span class="font-medium">{t.failure_step_name}</span>.{/if}
      </p>
    {:else if !logs.ok}
      <p class="py-6 text-center text-sm text-red-700">HTTP {logs.status} — {logs.detail}</p>
    {:else}
      <p class="mb-2 text-xs text-gray-500">
        step {logs.data.step_index} · {logs.data.step_name} · attempt {logs.data.attempt}
      </p>
      {#each [['stdout', logs.data.stdout, logs.data.stdout_truncated], ['stderr', logs.data.stderr, logs.data.stderr_truncated]] as [name, body, trunc] (name)}
        <div class="mb-3">
          <div class="mb-1 flex items-center gap-2 text-xs font-semibold tracking-wide text-gray-500 uppercase">
            {name}{#if trunc}<span class="font-normal text-amber-700">(older lines dropped)</span>{/if}
          </div>
          <pre class="max-h-96 overflow-auto rounded-md bg-gray-900 p-3 text-xs whitespace-pre-wrap text-gray-100">{body || '(empty)'}</pre>
        </div>
      {/each}
    {/if}
  </Card>
{/if}
