<script lang="ts">
  // Top-bar environment control, styled like the account menu beside it.
  // A dot marks the environment (teal = prod, amber = anything else); the menu
  // switches environments in a dev build, and links to the full card on /profile.
  import { current, envs, switchable, switchTo } from '$lib/environment';
  import { deployment, displayName, isProduction } from '$lib/deployment.svelte';
  import { cn } from '$lib/utils';

  let open = $state(false);
  const d = $derived(deployment.value);
  const reported = $derived(
    d.status === 'named'
      ? d.name
      : d.status === 'unnamed'
        ? 'unnamed'
        : d.status === 'unknown'
          ? 'not reported'
          : '…'
  );
  const dot = (prod: boolean) => (prod ? 'bg-teal-500' : 'bg-amber-500');
</script>

<details bind:open class="relative">
  <summary
    class="flex cursor-pointer list-none items-center gap-2 rounded-md px-2 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
    title="server reports: {reported}"
  >
    <span class={cn('size-2 rounded-full', dot(isProduction(d)))}></span>
    <span class="font-medium">{displayName(d)}</span>
    {#if switchable}
      <svg viewBox="0 0 20 20" fill="currentColor" class="size-4 text-gray-400">
        <path
          fill-rule="evenodd"
          d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.168l3.71-3.938a.75.75 0 1 1 1.08 1.04l-4.25 4.5a.75.75 0 0 1-1.08 0l-4.25-4.5a.75.75 0 0 1 .02-1.06Z"
          clip-rule="evenodd"
        />
      </svg>
    {/if}
  </summary>
  <div
    class="absolute right-0 z-20 mt-2 w-64 rounded-md border border-gray-200 bg-white py-1 shadow-lg"
  >
    <p class="px-3 pt-1.5 pb-1 text-xs font-medium text-gray-500">Environment</p>
    {#each envs as env (env.name)}
      {@const active = env.name === current?.name}
      <button
        class={cn(
          'flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-gray-50',
          active ? 'text-gray-900' : 'text-gray-700'
        )}
        onclick={() => {
          open = false;
          switchTo(env.name);
        }}
      >
        <span class={cn('size-2 shrink-0 rounded-full', dot(env.name === 'prod'))}></span>
        <span class="min-w-0 flex-1">
          <span class="block font-medium">{env.name}</span>
          <span class="block truncate font-mono text-xs text-gray-500">{env.origin}</span>
        </span>
        {#if active}
          <svg viewBox="0 0 20 20" fill="currentColor" class="size-4 shrink-0 text-teal-600">
            <path
              fill-rule="evenodd"
              d="M16.704 4.153a.75.75 0 0 1 .143 1.052l-8 10.5a.75.75 0 0 1-1.127.075l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 0 1 1.05-.143Z"
              clip-rule="evenodd"
            />
          </svg>
        {/if}
      </button>
    {:else}
      <p class="px-3 py-2 font-mono text-xs text-gray-500">{location.origin}</p>
    {/each}
    <div class="my-1 border-t border-gray-100"></div>
    <p class="px-3 py-1 text-xs text-gray-500">server reports: {reported}</p>
    <a
      href="/profile#environment"
      class="block px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
      onclick={() => (open = false)}>Manage environments</a
    >
  </div>
</details>
