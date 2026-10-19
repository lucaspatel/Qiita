<script lang="ts">
  // Underline tabs at every width. On a narrow screen the row scrolls sideways
  // rather than collapsing into a select, which read as a box nested in the card.
  import { cn } from '$lib/utils';

  /** `count`, when set, shows as a pill after the label (Tailwind UI: tabs with badges). */
  type Tab = { id: string; label: string; count?: number };
  let { tabs, active = $bindable(), label = 'Tabs' }: { tabs: Tab[]; active: string; label?: string } = $props();
</script>

<nav aria-label={label} class="-mb-px flex gap-x-6 overflow-x-auto sm:gap-x-8 [&::-webkit-scrollbar]:hidden">
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
      )}
      >{t.label}{#if t.count}<span
          class={cn(
            'ml-2 rounded-full px-2 py-0.5 text-xs font-medium',
            active === t.id ? 'bg-teal-100 text-teal-600' : 'bg-gray-100 text-gray-900'
          )}>{t.count}</span
        >{/if}</button
    >
  {/each}
</nav>
