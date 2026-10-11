<script lang="ts">
  // A rarefaction depth picker over the depths samples actually have: step k
  // rarefies to the k-th shallowest sample's depth, so each step keeps one fewer.
  // Step 0, when `allowOff`, means no rarefaction. Fires `onCommit` on release,
  // not on every move, since each depth is a recompute.
  let {
    depths,
    value,
    allowOff = false,
    unit = 'counts',
    disabled = false,
    onCommit,
    onPreview
  }: {
    depths: number[];
    value: number | null;
    allowOff?: boolean;
    unit?: string;
    disabled?: boolean;
    onCommit: (depth: number | null) => void;
    onPreview?: (depth: number | null) => void;
  } = $props();

  const sorted = $derived([...new Set(depths)].sort((a, b) => a - b));
  const offset = $derived(allowOff ? 1 : 0);
  const max = $derived(sorted.length - 1 + offset);
  const toDepth = (i: number) => (allowOff && i === 0 ? null : sorted[i - offset]);
  const toIndex = (d: number | null) => (d == null ? 0 : Math.max(0, sorted.indexOf(d)) + offset);

  let index = $state(0);
  $effect(() => {
    index = toIndex(value);
  });
  const depth = $derived(toDepth(index));
  const kept = $derived(depth == null ? depths.length : depths.filter((d) => d >= depth).length);
</script>

<!-- One row on a wide screen; on a narrow one the label and value share the first
     line (the value right-aligned with the plot's edge) and the slider takes the
     second. -->
<div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-600 sm:flex-nowrap">
  <span class="shrink-0 font-medium text-gray-500">Rarefaction depth</span>
  <input
    type="range"
    min="0"
    {max}
    step="1"
    bind:value={index}
    {disabled}
    oninput={() => onPreview?.(depth)}
    onchange={() => onCommit(depth)}
    class="order-last h-1.5 w-full min-w-24 cursor-pointer accent-teal-600 disabled:opacity-50 sm:order-none sm:w-auto sm:flex-1"
    aria-label="Rarefaction depth"
  />
  <span class="ml-auto shrink-0 text-right whitespace-nowrap tabular-nums sm:ml-0 sm:w-56">
    {#if depth == null}
      off (relative abundance)
    {:else}
      {depth.toLocaleString()} {unit} · keeps {kept}/{depths.length}
    {/if}
  </span>
</div>
