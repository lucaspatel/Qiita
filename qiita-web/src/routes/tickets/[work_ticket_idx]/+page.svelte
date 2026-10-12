<script lang="ts">
  import { page } from '$app/state';
  import { auth } from '$lib/auth.svelte';
  import {
    api,
    type Reference,
    type WorkTicket,
    type WorkTicketStepLogs,
    type ApiResult
  } from '$lib/api';
  import {
    actionLabel,
    classifyLog,
    stepReceipt,
    contextFields,
    duration,
    scopeLabel,
    STATE_CLASS,
    when
  } from '$lib/tickets';
  import PageHeading from '$lib/ui/PageHeading.svelte';
  import Card from '$lib/ui/Card.svelte';

  const idx = $derived(Number(page.params.work_ticket_idx));
  let res = $state<ApiResult<WorkTicket> | null>(null);
  let loadedFor = -1;
  let me = $state<number | null>(null);

  const t = $derived<WorkTicket | null>(res?.ok ? res.data : null);
  const live = $derived(t ? ['pending', 'queued', 'processing'].includes(t.state) : false);
  const fields = $derived(t ? contextFields(t.action_context ?? {}) : []);
  let showRaw = $state(false);

  // The references an action context names, by idx, for their name and version.
  let refs = $state<Record<number, Reference | null>>({});
  $effect(() => {
    for (const f of fields)
      if (f.kind === 'reference' && !(f.referenceIdx in refs)) {
        const i = f.referenceIdx;
        refs = { ...refs, [i]: null };
        api.reference(i).then((r) => {
          if (r.ok) refs = { ...refs, [i]: r.data };
        });
      }
  });

  // The steps that have run. The server has no step list, but the logs route
  // answers for every step that reached a backend (with its name and latest
  // attempt) and 404s past the last, so the steps are found by asking in order.
  type Step = { index: number; name: string; attempts: number };
  let steps = $state<Step[] | null>(null);
  const MAX_STEPS = 30;

  async function discoverSteps(): Promise<Step[]> {
    const found: Step[] = [];
    for (let i = 0; i < MAX_STEPS; i++) {
      const r = await api.ticketLogs(idx, i, { tailLines: 1 });
      if (!r.ok) break;
      found.push({ index: i, name: r.data.step_name, attempts: r.data.attempt + 1 });
    }
    return found;
  }

  let stepIndex = $state<number | null>(null);
  // null: the latest attempt.
  let attempt = $state<number | null>(null);
  let tailLines = $state(200);
  let logs = $state<ApiResult<WorkTicketStepLogs> | null>(null);
  let logsLoading = $state(false);
  let wrap = $state(true);
  let showStdout = $state(false);

  async function loadLogs() {
    if (stepIndex == null) return;
    logsLoading = true;
    logs = await api.ticketLogs(idx, stepIndex, { attempt: attempt ?? undefined, tailLines });
    logsLoading = false;
  }

  function pick(step: Step) {
    stepIndex = step.index;
    attempt = null;
    tailLines = 200;
    showStdout = false;
    loadLogs();
  }

  async function refresh(first: boolean) {
    const r = await api.ticket(idx);
    res = r;
    if (!r.ok) return;
    steps = await discoverSteps();
    // Open the failing step if one is named, else the latest one.
    if (first && steps.length) {
      const failing = steps.find((s) => s.name === r.data.failure_step_name);
      pick(failing ?? steps[steps.length - 1]);
    } else if (stepIndex != null && attempt == null) loadLogs();
  }

  $effect(() => {
    const i = idx;
    if (auth.isSet && i && loadedFor !== i) {
      loadedFor = i;
      steps = null;
      logs = null;
      stepIndex = null;
      refresh(true);
      api.whoami().then((w) => (me = w.ok ? w.data.principal_idx : null));
    }
  });

  // While the ticket is live, follow it: its state, new steps, the open log.
  $effect(() => {
    if (!live) return;
    const timer = setInterval(() => refresh(false), 15000);
    return () => clearInterval(timer);
  });

  const stderrLines = $derived(logs?.ok ? classifyLog(logs.data.stderr) : []);
  const outcomes = $derived(stderrLines.flatMap((l) => (l.kind === 'outcome' ? [l] : [])));
  const receipt = $derived(logs?.ok ? stepReceipt(logs.data.stdout) : null);
  const selected = $derived(steps?.find((s) => s.index === stepIndex) ?? null);

  let copied = $state(false);
  async function copyLog() {
    if (!logs?.ok) return;
    try {
      await navigator.clipboard.writeText(
        [logs.data.stderr, logs.data.stdout].filter(Boolean).join('\n')
      );
      copied = true;
      setTimeout(() => (copied = false), 1200);
    } catch {
      // No clipboard here: nothing to confirm.
    }
  }

  function lifecycle(w: WorkTicket): [string, string][] {
    const rows: [string, string][] = [
      ['Action', `${actionLabel(w.action_id)} · ${w.action_id} @${w.action_version}`],
      ['Target', scopeLabel(w.scope_target)],
      [
        'Submitted by',
        w.originator_principal_idx === me ? 'you' : `principal ${w.originator_principal_idx}`
      ],
      ['Retries', `${w.retry_count} / ${w.max_retries}`],
      ['Created', when(w.created_at)],
      [
        live ? 'Running for' : 'Took',
        duration(w.created_at, live ? new Date().toISOString() : w.updated_at) || '—'
      ]
    ];
    if (w.mask_idx != null) rows.push(['Mask', `mask ${w.mask_idx}`]);
    if (w.shard_id != null) rows.push(['Shard', String(w.shard_id)]);
    return rows;
  }

  const LEVEL_CLASS = {
    error: 'text-red-300',
    warning: 'text-amber-300',
    info: 'text-gray-100'
  } as const;
</script>

<div class="mb-3">
  <a href="/tickets" class="text-sm text-teal-700 hover:underline">← Jobs</a>
</div>

<PageHeading
  title="Ticket #{idx}{t ? ` · ${actionLabel(t.action_id)}` : ''}"
  subtitle="Work-ticket lifecycle and step logs."
/>

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
        {#if live}<span class="text-xs text-gray-400">refreshing every 15s</span>{/if}
        <span
          class="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium capitalize ring-1 ring-inset {STATE_CLASS[
            t.state
          ]}">{t.state.replace('_', ' ')}</span
        >
      {/snippet}
      <dl class="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
        {#each lifecycle(t) as [k, v]}
          <div class="flex gap-2 text-sm">
            <dt class="w-28 shrink-0 font-medium text-gray-500">{k}</dt>
            <dd class="min-w-0 text-gray-900">{v}</dd>
          </div>
        {/each}
      </dl>
      <!-- A no-data end is recorded only in the step's log: say so here. -->
      {#if t.state === 'no_data'}
        {#each outcomes as o}
          <p class="mt-3 rounded-md bg-gray-50 px-3 py-2 text-sm text-gray-700 ring-1 ring-gray-200">
            Ended with no data{o.step ? ` at ${o.step}` : ''}: {o.reason}
          </p>
        {/each}
      {/if}
    </Card>
  </div>

  {#if t.transient_reason}
    <div class="mb-4">
      <div class="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-amber-600/20">
        Retrying in place — {t.transient_reason}{t.transient_since
          ? ` (since ${when(t.transient_since)})`
          : ''}. Still processing, not failed.
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

  {#if fields.length}
    <div class="mb-4">
      <Card title="Action context">
        {#snippet actions()}
          <button class="text-xs text-teal-700 hover:underline" onclick={() => (showRaw = !showRaw)}
            >{showRaw ? 'Fields' : 'Raw JSON'}</button
          >
        {/snippet}
        {#if showRaw}
          <pre class="overflow-x-auto rounded-md bg-gray-50 p-3 text-xs text-gray-700 ring-1 ring-gray-200">{JSON.stringify(t.action_context, null, 2)}</pre>
        {:else}
          <dl class="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            {#each fields as f (f.key)}
              <div class="flex min-w-0 gap-2 {f.kind === 'rows' || f.kind === 'json' ? 'sm:col-span-2' : ''}">
                <dt class="w-28 shrink-0 font-medium text-gray-500" title={f.key}>{f.label}</dt>
                <dd class="min-w-0 flex-1 text-gray-900">
                  {#if f.kind === 'text'}{f.text}
                  {:else if f.kind === 'reference'}
                    {@const r = refs[f.referenceIdx]}
                    <a href="/references/{f.referenceIdx}" class="text-teal-700 hover:underline"
                      >{r ? `${r.name} ${r.version}` : `reference ${f.referenceIdx}`}</a
                    >
                  {:else if f.kind === 'link'}
                    <a href={f.href} target="_blank" rel="noopener" class="text-teal-700 hover:underline"
                      >{f.text} ↗</a
                    >
                  {:else if f.kind === 'rows'}
                    {@const cols = Object.keys(f.rows[0])}
                    <details>
                      <summary class="cursor-pointer text-gray-700">{f.rows.length} entries</summary>
                      <div class="mt-2 max-h-72 overflow-auto rounded-md ring-1 ring-gray-200">
                        <table class="min-w-full text-xs">
                          <thead class="sticky top-0 bg-gray-50">
                            <tr>
                              {#each cols as c}<th class="px-2 py-1 text-left font-medium text-gray-500">{c}</th>{/each}
                            </tr>
                          </thead>
                          <tbody class="divide-y divide-gray-100 font-mono">
                            {#each f.rows as row}
                              <tr>
                                {#each cols as c}<td class="px-2 py-1 whitespace-nowrap text-gray-700">{String(row[c] ?? '')}</td>{/each}
                              </tr>
                            {/each}
                          </tbody>
                        </table>
                      </div>
                    </details>
                  {:else}
                    <pre class="overflow-x-auto rounded-md bg-gray-50 p-2 text-xs text-gray-700 ring-1 ring-gray-200">{JSON.stringify(f.value, null, 2)}</pre>
                  {/if}
                </dd>
              </div>
            {/each}
          </dl>
        {/if}
      </Card>
    </div>
  {/if}

  <Card title="Steps" bodyClass="">
    {#if steps === null}
      <p class="px-4 py-6 text-center text-sm text-gray-500">Finding steps…</p>
    {:else if !steps.length}
      <p class="px-4 py-6 text-center text-sm text-gray-500">
        No step has reached a backend yet{live ? ' — this page follows the ticket' : ''}.
      </p>
    {:else}
      <!-- One button per step that has run; the failing one is marked red. -->
      <div class="flex flex-wrap gap-2 border-b border-gray-200 px-4 py-3 sm:px-6">
        {#each steps as s (s.index)}
          {@const failing = s.name === t.failure_step_name}
          <button
            type="button"
            onclick={() => pick(s)}
            class="rounded-md px-3 py-1.5 text-sm ring-1 ring-inset {stepIndex === s.index
              ? 'bg-teal-700 text-white ring-teal-700'
              : failing
                ? 'bg-red-50 text-red-700 ring-red-600/20 hover:bg-red-100'
                : 'bg-white text-gray-700 ring-gray-300 hover:bg-gray-50'}"
          >
            <span class="opacity-60">{s.index + 1}.</span>
            {s.name}{#if s.attempts > 1}<span class="opacity-60">&nbsp;· {s.attempts} attempts</span>{/if}
          </button>
        {/each}
      </div>

      {#if selected}
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 text-xs text-gray-500 sm:px-6">
          {#if selected.attempts > 1}
            <span class="flex items-center gap-1">
              Attempt
              {#each Array.from({ length: selected.attempts }, (_, a) => a) as a}
                {@const on = (attempt ?? selected.attempts - 1) === a}
                <button
                  type="button"
                  class="rounded px-1.5 py-0.5 ring-1 ring-inset {on
                    ? 'bg-gray-800 text-white ring-gray-800'
                    : 'ring-gray-300 hover:bg-gray-50'}"
                  onclick={() => {
                    attempt = a === selected.attempts - 1 ? null : a;
                    loadLogs();
                  }}>{a + 1}</button
                >
              {/each}
            </span>
          {/if}
          <span class="flex-1"></span>
          <label class="flex items-center gap-1"><input type="checkbox" bind:checked={wrap} /> Wrap</label>
          <button type="button" class="text-teal-700 hover:underline" onclick={copyLog}
            >{copied ? 'Copied' : 'Copy'}</button
          >
          <button
            type="button"
            class="text-teal-700 hover:underline disabled:opacity-40"
            onclick={loadLogs}
            disabled={logsLoading}>{logsLoading ? 'Loading…' : 'Reload'}</button
          >
        </div>

        <div class="px-4 pb-4 sm:px-6">
          {#if !logs}
            <p class="py-6 text-center text-sm text-gray-500">Loading logs…</p>
          {:else if !logs.ok}
            <p class="py-6 text-center text-sm text-red-700">HTTP {logs.status} — {logs.detail}</p>
          {:else}
            {@const d = logs.data}
            {#if receipt}
              <div
                class="mb-3 rounded-md px-3 py-2 text-sm ring-1 {receipt.outcome === 'completed'
                  ? 'bg-teal-50 text-teal-900 ring-teal-200'
                  : receipt.outcome === 'no_data'
                    ? 'bg-gray-50 text-gray-700 ring-gray-200'
                    : 'bg-red-50 text-red-900 ring-red-200'}"
              >
                <span class="font-medium">{receipt.outcome.replace('_', ' ')}</span
                >{receipt.reason ? `: ${receipt.reason}` : ''}
                {#if receipt.summary.length}
                  <dl class="mt-1 flex flex-wrap gap-x-5 gap-y-1">
                    {#each receipt.summary as f (f.label)}
                      <div class="flex gap-1.5">
                        <dt class="text-xs opacity-70">{f.label}</dt>
                        <dd class="text-xs font-medium tabular-nums">{f.value}</dd>
                      </div>
                    {/each}
                  </dl>
                {/if}
              </div>
            {:else}
              {#each outcomes as o}
                <p class="mb-2 rounded-md bg-gray-50 px-3 py-2 text-sm text-gray-700 ring-1 ring-gray-200">
                  <span class="font-medium">{o.outcome.replace('_', ' ')}</span>{o.step
                    ? ` at ${o.step}`
                    : ''}: {o.reason}
                </p>
              {/each}
            {/if}
            <!-- The step's narrative is on stderr, so it leads; stdout holds the receipt above. -->
            <div class="mb-1 flex items-center gap-2 text-xs font-semibold tracking-wide text-gray-500 uppercase">
              stderr
              {#if d.stderr_truncated}
                <span class="font-normal text-amber-700 normal-case">last {tailLines} lines</span>
                {#if tailLines < 5000}
                  <button
                    type="button"
                    class="font-normal text-teal-700 normal-case hover:underline"
                    onclick={() => {
                      tailLines = tailLines < 1000 ? 1000 : 5000;
                      loadLogs();
                    }}>show more</button
                  >
                {/if}
              {/if}
            </div>
            {#if d.stderr}
              <pre
                class="max-h-[32rem] overflow-auto rounded-md bg-gray-900 p-3 text-xs {wrap
                  ? 'break-all whitespace-pre-wrap'
                  : 'whitespace-pre'}">{#each stderrLines as l}<span
                    class={l.kind === 'outcome' ? 'text-sky-300' : LEVEL_CLASS[l.level]}>{l.text}</span
                  >{'\n'}{/each}</pre>
            {:else}
              <p class="text-sm text-gray-400">(empty)</p>
            {/if}
            <div class="mt-3 text-xs font-semibold tracking-wide text-gray-500 uppercase">
              {#if d.stdout}
                <button
                  type="button"
                  class="tracking-wide uppercase hover:text-gray-700"
                  onclick={() => (showStdout = !showStdout)}
                  >{showStdout ? '▾' : '▸'} stdout{d.stdout_truncated ? ' (older lines dropped)' : ''}</button
                >
              {:else}
                stdout <span class="font-normal text-gray-400 normal-case">(empty)</span>
              {/if}
            </div>
            {#if d.stdout && showStdout}
              <pre
                class="mt-1 max-h-96 overflow-auto rounded-md bg-gray-900 p-3 text-xs text-gray-100 {wrap
                  ? 'break-all whitespace-pre-wrap'
                  : 'whitespace-pre'}">{d.stdout}</pre>
            {/if}
          {/if}
        </div>
      {/if}
    {/if}
  </Card>
{/if}
