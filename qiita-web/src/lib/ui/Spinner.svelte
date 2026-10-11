<script lang="ts">
  // A small gray spinner with an optional caption, for a pane whose data is loading.
  let { label = '' }: { label?: string } = $props();
</script>

<div class="flex flex-col items-center justify-center gap-3 py-12 text-sm text-gray-400" role="status">
  <svg class="size-6 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" class="opacity-25" />
    <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" stroke-width="3" stroke-linecap="round" />
  </svg>
  {#if label}<span>{label}</span>{/if}
</div>
