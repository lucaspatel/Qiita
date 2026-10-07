<script lang="ts">
  // Environment picker for /profile. Also shown signed out: the fix for "no
  // token here" is often "switch to where you have one".
  import { current, envs, switchable, switchTo } from '$lib/environment';
  import { deployment } from '$lib/deployment.svelte';
  import { hasTokenFor } from '$lib/auth.svelte';
  import Card from './Card.svelte';

  const d = $derived(deployment.value);
  const reported = $derived(
    d.status === 'named'
      ? d.name
      : d.status === 'unnamed'
        ? 'unnamed'
        : d.status === 'unknown'
          ? `unknown (${d.detail})`
          : '…'
  );

</script>

<div id="environment">
  <Card title="Environment">
    {#if current === null}
      <p class="text-sm text-gray-700">
        This site talks to its own control plane at <span class="font-mono">{location.origin}</span>
        (deployment reports: <span class="font-medium">{reported}</span>).
      </p>
    {:else}
      <ul class="divide-y divide-gray-100 rounded-md ring-1 ring-gray-200">
        {#each envs as env (env.name)}
          {@const active = env.name === current.name}
          <li class="flex items-center justify-between gap-3 px-3 py-2 text-sm">
            <div class="min-w-0">
              <p class="font-medium text-gray-900">
                {env.name}
                {#if active}<span class="ml-1 text-xs font-normal text-teal-700">active</span>{/if}
              </p>
              <p class="truncate font-mono text-xs text-gray-500">{env.origin}</p>
              {#if active}
                <p class="text-xs text-gray-500">deployment reports: {reported}</p>
              {/if}
            </div>
            <div class="flex shrink-0 items-center gap-3">
              <span class="text-xs {hasTokenFor(env.name) ? 'text-green-700' : 'text-gray-400'}"
                >{hasTokenFor(env.name) ? 'token set' : 'no token'}</span
              >
              {#if !active && switchable}
                <button
                  class="rounded-md bg-white px-2.5 py-1 text-xs font-semibold text-gray-900 shadow-sm ring-1 ring-gray-300 ring-inset hover:bg-gray-50"
                  onclick={() => switchTo(env.name)}>Switch</button
                >
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </Card>
</div>
