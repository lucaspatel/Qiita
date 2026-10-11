<script lang="ts">
  // Reusable dashed drag-and-drop file box. Parent owns the selected file; this
  // just reports a chosen file via onfile and shows the current name.
  let {
    accept = '',
    fileName = '',
    hint = 'Drop a file here, or click to browse',
    onfile
  }: { accept?: string; fileName?: string; hint?: string; onfile: (f: File) => void } = $props();

  let dragging = $state(false);
  let input: HTMLInputElement;

  function pick(f: File | undefined) {
    if (f) onfile(f);
  }
</script>

<div
  role="button"
  tabindex="0"
  aria-label="Upload a file"
  ondragover={(e) => {
    e.preventDefault();
    dragging = true;
  }}
  ondragleave={() => (dragging = false)}
  ondrop={(e) => {
    e.preventDefault();
    dragging = false;
    pick(e.dataTransfer?.files?.[0]);
  }}
  onclick={() => input.click()}
  onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && input.click()}
  class="flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-6 text-center transition-colors {dragging
    ? 'border-teal-500 bg-teal-50'
    : 'border-gray-300 bg-gray-50 hover:bg-gray-100'}"
>
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="size-7 text-gray-400">
    <path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" />
  </svg>
  {#if fileName}
    <p class="mt-2 text-sm font-medium text-teal-700">{fileName}</p>
    <p class="text-xs text-gray-500">drop another to replace</p>
  {:else}
    <p class="mt-2 text-sm font-medium text-gray-700">{hint}</p>
    {#if accept}<p class="text-xs text-gray-400">{accept}</p>{/if}
  {/if}
  <input
    bind:this={input}
    type="file"
    {accept}
    onchange={(e) => {
      const el = e.target as HTMLInputElement;
      pick(el.files?.[0]);
      el.value = ''; // allow re-picking the same file after a reset
    }}
    class="hidden"
  />
</div>
