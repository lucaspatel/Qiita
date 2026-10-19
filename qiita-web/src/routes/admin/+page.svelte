<script lang="ts">
  // The admin console: system-admin actions that otherwise mean dropping to the
  // qiita-admin CLI — change a user's role, revoke their tokens, and retune the
  // dispatch throttle (fan-out). The server enforces every gate (system_admin +
  // scope); this page only shows the controls to a system_admin and reports what
  // the server did. Markup follows Tailwind Plus "Application UI" (action panels,
  // alerts, badges, tables), in the app's teal.
  import { auth } from '$lib/auth.svelte';
  import {
    api,
    SYSTEM_ROLES,
    type FanoutCohort,
    type PrincipalLookup,
    type SystemRole,
    type Whoami
  } from '$lib/api';
  import { isSystemAdmin } from '$lib/roles';
  import PageHeading from '$lib/ui/PageHeading.svelte';
  import Card from '$lib/ui/Card.svelte';
  import Select from '$lib/ui/Select.svelte';
  import Modal from '$lib/ui/Modal.svelte';

  const field =
    'block w-full rounded-md bg-white px-3 py-1.5 text-base text-gray-900 outline-1 -outline-offset-1 outline-gray-300 placeholder:text-gray-400 focus:outline-2 focus:-outline-offset-2 focus:outline-teal-600 sm:text-sm/6';
  const primary =
    'inline-flex items-center justify-center rounded-md bg-teal-600 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-teal-500 disabled:opacity-50';
  const secondary =
    'rounded-md bg-white px-2.5 py-1.5 text-sm font-semibold text-gray-900 shadow-xs ring-1 ring-gray-300 ring-inset hover:bg-gray-50 disabled:opacity-50';

  const roleBadge: Record<SystemRole, string> = {
    user: 'bg-gray-100 text-gray-600',
    wet_lab_admin: 'bg-blue-100 text-blue-700',
    system_admin: 'bg-indigo-100 text-indigo-700'
  };

  let me = $state<Whoami | null>(null);
  let meErr = $state('');
  const authorized = $derived(!!me && isSystemAdmin(me.system_role));
  $effect(() => {
    if (auth.isSet && me === null && !meErr) {
      api.whoami().then((r) => (r.ok ? (me = r.data) : (meErr = `HTTP ${r.status} — ${r.detail}`)));
    } else if (!auth.isSet) {
      me = null;
    }
  });
  $effect(() => {
    if (authorized && cohorts === null) loadFanout();
  });

  // --- principals ------------------------------------------------------------
  let email = $state('');
  let principal = $state<PrincipalLookup | null>(null);
  let lookupErr = $state('');
  let lookingUp = $state(false);
  let roleChoice = $state<SystemRole>('user');
  let reason = $state('');
  let roleBusy = $state(false);
  let roleMsg = $state('');
  let roleErr = $state('');
  let revokeOpen = $state(false);
  let revokeBusy = $state(false);
  let revokeMsg = $state('');

  function resetPrincipalMessages() {
    roleMsg = '';
    roleErr = '';
    revokeMsg = '';
  }

  async function lookup() {
    if (!email.trim() || lookingUp) return;
    lookingUp = true;
    lookupErr = '';
    principal = null;
    resetPrincipalMessages();
    const r = await api.lookupPrincipalByEmail(email.trim());
    if (r.ok) {
      principal = r.data;
      roleChoice = r.data.system_role;
    } else {
      lookupErr = r.status === 404 ? 'No principal with that email (they may not have logged in yet).' : `HTTP ${r.status} — ${r.detail}`;
    }
    lookingUp = false;
  }

  async function changeRole() {
    if (!principal || roleBusy) return;
    roleBusy = true;
    resetPrincipalMessages();
    const r = await api.setPrincipalSystemRole(principal.principal_idx, roleChoice, reason);
    if (r.ok) {
      principal = { ...principal, system_role: roleChoice };
      reason = '';
      roleMsg = `Role set to ${roleChoice}.`;
    } else {
      roleErr = `HTTP ${r.status} — ${r.detail}`;
    }
    roleBusy = false;
  }

  async function revokeAll() {
    if (!principal || revokeBusy) return;
    revokeBusy = true;
    resetPrincipalMessages();
    const r = await api.revokeAllPrincipalTokens(principal.principal_idx);
    revokeOpen = false;
    if (r.ok) {
      revokeMsg = `Revoked ${r.data.revoked_token_idxs.length} token(s)${r.data.already_revoked_count ? ` (${r.data.already_revoked_count} already revoked)` : ''}.`;
    } else {
      roleErr = `Revoke failed: HTTP ${r.status} — ${r.detail}`;
    }
    revokeBusy = false;
  }

  // --- fan-out (dispatch throttle) -------------------------------------------
  let cohorts = $state<FanoutCohort[] | null>(null);
  let fanoutErr = $state('');
  let fanoutMsg = $state('');
  let caps = $state<Record<string, string>>({});
  const ckey = (c: FanoutCohort) => `${c.kind}:${c.key}`;

  async function loadFanout() {
    fanoutErr = '';
    const r = await api.fanoutCohorts();
    if (r.ok) cohorts = r.data.cohorts;
    else {
      cohorts = [];
      fanoutErr = `HTTP ${r.status} — ${r.detail}`;
    }
  }

  async function setCap(c: FanoutCohort, clear = false) {
    fanoutMsg = '';
    fanoutErr = '';
    const raw = caps[ckey(c)];
    const value = clear ? null : Number(raw);
    if (!clear && (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 100)) {
      fanoutErr = 'Cap must be a whole number from 1 to 100.';
      return;
    }
    const r = await api.setFanoutOverride(c.kind, c.key, value);
    if (r.ok) {
      fanoutMsg = `${c.label}: ${clear ? 'override cleared' : `cap ${value}`}, released ${r.data.released.length} ticket(s).`;
      caps = { ...caps, [ckey(c)]: '' };
      await loadFanout();
    } else fanoutErr = `HTTP ${r.status} — ${r.detail}`;
  }

  async function pump(c: FanoutCohort) {
    fanoutMsg = '';
    fanoutErr = '';
    const r = await api.pumpFanout(c.kind, c.key);
    if (r.ok) {
      fanoutMsg = `${c.label}: pumped, released ${r.data.released.length} ticket(s).`;
      await loadFanout();
    } else fanoutErr = `HTTP ${r.status} — ${r.detail}`;
  }
</script>

{#snippet alert(kind: 'error' | 'success', text: string)}
  <div class="border-l-4 p-3 text-sm {kind === 'error' ? 'border-red-400 bg-red-50 text-red-700' : 'border-green-400 bg-green-50 text-green-700'}">
    {text}
  </div>
{/snippet}

<PageHeading title="Admin" subtitle="System administration — users, roles, and dispatch throttle." />

{#if !auth.isSet}
  <Card><p class="py-8 text-center text-gray-500">Log in to use the admin console.</p></Card>
{:else if meErr}
  <Card><p class="py-8 text-center text-red-700">{meErr}</p></Card>
{:else if me && !authorized}
  <Card><p class="py-8 text-center text-gray-500">This console is for system administrators. You are signed in as <span class="font-medium">{me.system_role}</span>.</p></Card>
{:else if authorized}
  <div class="space-y-6">
    <!-- Principals: look up by email, then change role / revoke tokens. -->
    <Card title="Principals">
      <div class="max-w-xl text-sm text-gray-500">Find a user by email to change their system role or revoke their tokens.</div>
      <form class="mt-4 sm:flex sm:items-center sm:gap-3" onsubmit={(e) => { e.preventDefault(); lookup(); }}>
        <div class="w-full sm:max-w-xs">
          <input type="email" placeholder="you@example.com" aria-label="Email" bind:value={email} class={field} />
        </div>
        <button type="submit" class="{primary} mt-3 w-full sm:mt-0 sm:w-auto" disabled={lookingUp || !email.trim()}>{lookingUp ? 'Looking up…' : 'Look up'}</button>
      </form>
      {#if lookupErr}<div class="mt-3">{@render alert('error', lookupErr)}</div>{/if}

      {#if principal}
        <div class="mt-5 border-t border-gray-100 pt-5">
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span class="font-medium text-gray-900">{email.trim()}</span>
            <span class="text-gray-400">principal #{principal.principal_idx}</span>
            <span class="inline-flex items-center rounded-full px-2 py-1 text-xs font-medium {roleBadge[principal.system_role]}">{principal.system_role}</span>
            {#if principal.disabled}<span class="inline-flex items-center rounded-full bg-red-100 px-2 py-1 text-xs font-medium text-red-700">disabled</span>{/if}
            {#if principal.retired}<span class="inline-flex items-center rounded-full bg-gray-100 px-2 py-1 text-xs font-medium text-gray-600">retired</span>{/if}
          </div>

          <div class="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-[auto_1fr_auto] sm:items-center">
            <Select bind:value={roleChoice} class="w-full sm:w-48">
              {#each SYSTEM_ROLES as r (r)}<option value={r}>{r}</option>{/each}
            </Select>
            <input placeholder="Reason (recorded in the audit log)" aria-label="Reason" bind:value={reason} class={field} />
            <button class={primary} onclick={changeRole} disabled={roleBusy || roleChoice === principal.system_role}>{roleBusy ? 'Saving…' : 'Change role'}</button>
          </div>

          <div class="mt-4 flex flex-wrap items-center gap-3">
            <button class="rounded-md bg-red-600 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-red-500" onclick={() => (revokeOpen = true)}>Revoke all tokens</button>
            <span class="text-xs text-gray-400">Signs the user out of every session and CLI.</span>
          </div>

          {#if roleMsg}<div class="mt-3">{@render alert('success', roleMsg)}</div>{/if}
          {#if roleErr}<div class="mt-3">{@render alert('error', roleErr)}</div>{/if}
          {#if revokeMsg}<div class="mt-3">{@render alert('success', revokeMsg)}</div>{/if}
        </div>
      {/if}
    </Card>

    <!-- Dispatch throttle: per-cohort in-flight cap + pump. -->
    <Card title="Dispatch throttle" bodyClass="">
      <div class="flex items-center justify-between px-4 py-3 sm:px-6">
        <p class="max-w-xl text-sm text-gray-500">Fan-out cohorts with held or in-flight work, or a set override. Retune the in-flight cap, or pump to release more now.</p>
        <button class={secondary} onclick={loadFanout}>Refresh</button>
      </div>
      {#if fanoutErr}<div class="px-4 pb-3 sm:px-6">{@render alert('error', fanoutErr)}</div>{/if}
      {#if fanoutMsg}<div class="px-4 pb-3 sm:px-6">{@render alert('success', fanoutMsg)}</div>{/if}
      {#if cohorts === null}
        <p class="px-4 py-6 text-center text-sm text-gray-500 sm:px-6">Loading…</p>
      {:else if !cohorts.length}
        <p class="px-4 py-10 text-center text-sm text-gray-500 sm:px-6">No cohorts are holding work. Nothing to throttle right now.</p>
      {:else}
        <div class="overflow-x-auto border-t border-gray-200">
          <table class="min-w-full divide-y divide-gray-200 text-sm">
            <thead class="bg-gray-50">
              <tr>
                {#each ['Cohort', 'Held', 'Running', 'Failed', 'Cap', 'New cap', ''] as h}
                  <th class="px-3 py-2 text-left text-xs font-semibold tracking-wide text-gray-500 uppercase whitespace-nowrap">{h}</th>
                {/each}
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-100">
              {#each cohorts as c (ckey(c))}
                <tr class="hover:bg-gray-50 {c.fail_stopped ? 'bg-red-50/40' : ''}">
                  <td class="px-3 py-2">
                    <div class="font-medium text-gray-900">{c.label}</div>
                    <div class="font-mono text-xs text-gray-400">{c.kind} · {c.key}</div>
                  </td>
                  <td class="px-3 py-2 tabular-nums text-gray-700">{c.held}</td>
                  <td class="px-3 py-2 tabular-nums text-gray-700">{c.running}</td>
                  <td class="px-3 py-2 tabular-nums {c.failed ? 'font-medium text-red-700' : 'text-gray-700'}">{c.failed}</td>
                  <td class="px-3 py-2 whitespace-nowrap text-gray-700">
                    {c.max_inflight}
                    {#if c.override !== null}<span class="ml-1 inline-flex items-center rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-700">override</span>{/if}
                  </td>
                  <td class="px-3 py-2">
                    <input type="number" min="1" max="100" placeholder="1–100" aria-label="New cap for {c.label}" bind:value={caps[ckey(c)]} class="{field} w-24 py-1" />
                  </td>
                  <td class="px-3 py-2 text-right whitespace-nowrap">
                    <button class="{secondary} mr-1" onclick={() => setCap(c)} disabled={!caps[ckey(c)]}>Set</button>
                    {#if c.override !== null}<button class="{secondary} mr-1" onclick={() => setCap(c, true)}>Clear</button>{/if}
                    <button class={secondary} onclick={() => pump(c)}>Pump</button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </Card>

    <p class="text-xs text-gray-400">
      Ticket cancellation lives on each job's page; mask deletion is a destructive CLI action. Both are gated to system_admin on the server.
    </p>
  </div>
{/if}

<Modal bind:open={revokeOpen} title="Revoke all tokens?">
  <div class="p-4">
    <p class="text-sm text-gray-700">Revoke every token for <span class="font-medium">{email.trim()}</span> (principal #{principal?.principal_idx}). They'll be signed out of every session and CLI and must log in again. This can't be undone.</p>
    <div class="mt-4 flex justify-end gap-2">
      <button class={secondary} onclick={() => (revokeOpen = false)}>Cancel</button>
      <button class="rounded-md bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-500 disabled:opacity-50" onclick={revokeAll} disabled={revokeBusy}>{revokeBusy ? 'Revoking…' : 'Revoke all'}</button>
    </div>
  </div>
</Modal>
