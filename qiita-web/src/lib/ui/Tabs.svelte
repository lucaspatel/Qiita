<script lang="ts">
  import { cn } from '$lib/utils';

  type Tab = { id: string; label: string };
  let { tabs, active = $bindable() }: { tabs: Tab[]; active: string } = $props();
</script>

<div class="grid grid-cols-1 sm:hidden">
  <select
    bind:value={active}
    aria-label="Select a tab"
    class="col-start-1 row-start-1 w-full appearance-none rounded-md bg-white py-2 pr-8 pl-3 text-base text-gray-900 outline-1 -outline-offset-1 outline-gray-300 focus:outline-2 focus:-outline-offset-2 focus:outline-teal-600"
  >
    {#each tabs as t (t.id)}<option value={t.id}>{t.label}</option>{/each}
  </select>
  <svg
    viewBox="0 0 16 16"
    fill="currentColor"
    aria-hidden="true"
    class="pointer-events-none col-start-1 row-start-1 mr-2 size-5 self-center justify-self-end fill-gray-500"
  >
    <path
      d="M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z"
      clip-rule="evenodd"
      fill-rule="evenodd"
    />
  </svg>
</div>
<div class="hidden sm:block">
  <nav aria-label="Tabs" class="-mb-px flex space-x-8">
    {#each tabs as t (t.id)}
      <button
        type="button"
        aria-current={active === t.id ? 'page' : undefined}
        onclick={() => (active = t.id)}
        class={cn(
          'border-b-2 px-1 py-4 text-sm font-medium whitespace-nowrap',
          active === t.id
            ? 'border-teal-500 text-teal-600'
            : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700'
        )}>{t.label}</button
      >
    {/each}
  </nav>
</div>
