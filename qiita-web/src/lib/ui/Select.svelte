<script lang="ts" generics="T extends string | number">
  // Native <select> styled to match the app's text inputs (same border, radius,
  // padding, focus ring) with a custom chevron, so dropdowns don't fall back to
  // the OS look. Generic over T so bind:value type-checks for number- and
  // string-valued option sets alike.
  import type { Snippet } from 'svelte';

  let {
    value = $bindable(),
    children,
    class: extra = ''
  }: { value?: T; children: Snippet; class?: string } = $props();
</script>

<div class="relative inline-block {extra}">
  <select
    bind:value
    class="w-full appearance-none rounded-md border border-gray-300 bg-white py-1.5 pr-9 pl-3 text-sm text-gray-900 focus:border-teal-500 focus:ring-1 focus:ring-teal-500 focus:outline-none"
  >
    {@render children()}
  </select>
  <svg
    viewBox="0 0 20 20"
    fill="currentColor"
    class="pointer-events-none absolute top-1/2 right-2 size-4 -translate-y-1/2 text-gray-400"
  >
    <path
      fill-rule="evenodd"
      d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.168l3.71-3.938a.75.75 0 1 1 1.08 1.04l-4.25 4.5a.75.75 0 0 1-1.08 0l-4.25-4.5a.75.75 0 0 1 .02-1.06Z"
      clip-rule="evenodd"
    />
  </svg>
</div>
