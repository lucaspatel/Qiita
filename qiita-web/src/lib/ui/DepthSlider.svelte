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

<div class="flex items-center gap-3 text-xs text-gray-600">
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
    class="h-1.5 min-w-24 flex-1 cursor-pointer accent-teal-600 disabled:opacity-50"
    aria-label="Rarefaction depth"
  />
  <span class="w-56 shrink-0 text-right whitespace-nowrap tabular-nums">
    {#if depth == null}
      off (relative abundance)
    {:else}
      {depth.toLocaleString()} {unit} · keeps {kept}/{depths.length}
    {/if}
  </span>
</div>
