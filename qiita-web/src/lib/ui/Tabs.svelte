<script lang="ts">
  // Underline tabs at every width. On a narrow screen the row scrolls sideways
  // rather than collapsing into a select, which read as a box nested in the card.
  import { cn } from '$lib/utils';

  type Tab = { id: string; label: string };
  let { tabs, active = $bindable() }: { tabs: Tab[]; active: string } = $props();
</script>

<nav aria-label="Tabs" class="-mb-px flex gap-x-6 overflow-x-auto sm:gap-x-8 [&::-webkit-scrollbar]:hidden">
  {#each tabs as t (t.id)}
    <button
      type="button"
      aria-current={active === t.id ? 'page' : undefined}
      onclick={() => (active = t.id)}
      class={cn(
        'shrink-0 border-b-2 px-1 py-3 text-sm font-medium whitespace-nowrap sm:py-4',
        active === t.id
          ? 'border-teal-500 text-teal-600'
          : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700'
      )}>{t.label}</button
    >
  {/each}
</nav>
