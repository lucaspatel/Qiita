<script lang="ts">
  import type { Snippet } from 'svelte';
  let {
    open = $bindable(false),
    title = '',
    size = 'md',
    children
  }: {
    open?: boolean;
    title?: string;
    /** `full` fills the viewport, for a dialog whose content is a table, and
     *  drops the body padding so the table runs edge to edge as in a Card. */
    size?: 'md' | 'full';
    children: Snippet;
  } = $props();

  function onkey(e: KeyboardEvent) {
    if (e.key === 'Escape') open = false;
  }
</script>

<svelte:window onkeydown={onkey} />

{#if open}
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
    <button
      type="button"
      class="absolute inset-0 bg-gray-900/50"
      aria-label="Close"
      onclick={() => (open = false)}
    ></button>
    <div
      class="relative z-10 flex w-full flex-col overflow-hidden rounded-lg bg-white shadow-xl {size === 'full'
        ? 'h-[calc(100vh-2rem)] max-w-none'
        : 'max-h-[85vh] max-w-5xl'}"
    >
      <div class="flex items-center justify-between border-b border-gray-200 px-4 py-3">
        <h3 class="text-sm font-semibold text-gray-900">{title}</h3>
        <button
          class="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          onclick={() => (open = false)}
          aria-label="Close">✕</button
        >
      </div>
      <div class="min-h-0 flex-1 overflow-auto {size === 'full' ? '' : 'p-4'}">
        {@render children()}
      </div>
    </div>
  </div>
{/if}
