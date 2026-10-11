<script lang="ts">
  // One dot per sample: two per-sample counts against each other (e.g. reads vs
  // ASVs), both on log scales since depth spans orders of magnitude. Samples
  // missing either value, or with a zero, can't sit on a log axis and are left
  // out; the legend says how many. A rarefaction depth on the x count draws a
  // line there and greys the samples below it, so a depth's cost is visible.
  import { Plot, Dot, HTMLTooltip, RuleX } from 'svelteplot';
  import DepthSlider from './DepthSlider.svelte';

  type Point = { label: string; x: number; y: number };
  let {
    points,
    xLabel,
    yLabel,
    omitted = 0,
    colorOf = null,
    symbolOf = null,
    initialDepth = null,
    onDepthChange
  }: {
    points: Point[];
    xLabel: string;
    yLabel: string;
    omitted?: number;
    /** Sample label -> fill colour; one colour for all when absent. */
    colorOf?: Record<string, string> | null;
    /** Sample label -> marker symbol; circles when absent. */
    symbolOf?: Record<string, string> | null;
    /** A depth to start at (e.g. the last one chosen); ignored unless a sample has it. */
    initialDepth?: number | null;
    /** Called with each committed depth (null: none). */
    onDepthChange?: (depth: number | null) => void;
  } = $props();

  let depth = $state<number | null>(null);
  // The starting depth applies once the points are in (they can arrive after the
  // first render), and only if a sample has exactly that depth.
  let started = false;
  $effect(() => {
    if (started || !points.length) return;
    started = true;
    if (initialDepth != null && points.some((p) => p.x === initialDepth)) depth = initialDepth;
  });
  const kept = $derived(depth == null ? points : points.filter((p) => p.x >= depth!));
  const below = $derived(depth == null ? [] : points.filter((p) => p.x < depth!));

  // One Dot mark per (colour, shape, side of the depth), each with constants;
  // a sample below the depth keeps its colour but fades.
  const marks = $derived.by(() => {
    const m = new Map<string, { fill: string; symbol: string; opacity: number; pts: Point[] }>();
    for (const [pts, opacity] of [
      [kept, 0.8],
      [below, 0.2]
    ] as const)
      for (const p of pts) {
        const fill = colorOf?.[p.label] ?? '#0d9488';
        const symbol = symbolOf?.[p.label] ?? 'circle';
        const k = `${fill}|${symbol}|${opacity}`;
        if (!m.has(k)) m.set(k, { fill, symbol, opacity, pts: [] });
        m.get(k)!.pts.push(p);
      }
    return [...m.entries()];
  });
</script>

<div class="px-4 pb-4 sm:px-6">
  <p class="mb-2 text-xs font-medium text-gray-500">{yLabel} vs {xLabel} per sample</p>
  <DepthSlider
    depths={points.map((p) => p.x)}
    value={depth}
    allowOff
    unit={xLabel.toLowerCase()}
    onCommit={(d) => {
      depth = d;
      onDepthChange?.(d);
    }}
    onPreview={(d) => (depth = d)}
  />
  <div class="relative mt-2">
    <Plot
      height={360}
      grid
      x={{ type: 'log', label: `${xLabel} →` }}
      y={{ type: 'log', label: `↑ ${yLabel}` }}
    >
      {#each marks as [k, mk] (k)}
        <Dot data={mk.pts} x="x" y="y" r={3.5} fill={mk.fill} symbol={mk.symbol} fillOpacity={mk.opacity} />
      {/each}
      {#if depth != null}
        <RuleX data={[depth]} stroke="#0f766e" strokeDasharray="4 3" />
      {/if}
      <!-- HTML, so it goes in the overlay layer above the SVG: inside the SVG
           with the marks, no browser draws it. -->
      {#snippet overlay()}
        <HTMLTooltip data={points} x="x" y="y">
          {#snippet children({ datum })}
            <!-- The tooltip renders with no datum while nothing is hovered. -->
            {#if datum}
              <div class="rounded bg-white px-2 py-1 text-xs whitespace-nowrap shadow ring-1 ring-gray-200">
                <div class="font-mono text-gray-900">{datum.label}</div>
                <div class="text-gray-500">
                  {xLabel}: {datum.x.toLocaleString()} · {yLabel}: {datum.y.toLocaleString()}
                </div>
              </div>
            {/if}
          {/snippet}
        </HTMLTooltip>
      {/snippet}
    </Plot>
    <!-- Legend, inside the plot area above the x axis. -->
    <div
      class="pointer-events-none absolute right-2 bottom-12 rounded bg-white/90 px-2 py-1 text-[11px] leading-tight text-gray-500 ring-1 ring-gray-200"
    >
      <div class="flex items-center gap-1.5">
        {kept.length} sample{kept.length === 1 ? '' : 's'}{depth != null ? ' at or above depth' : ''}
      </div>
      {#if below.length}
        <div class="flex items-center gap-1.5">
          {below.length} below depth (faded)
        </div>
      {/if}
      {#if omitted}
        <div class="text-gray-400">{omitted} without both counts not shown</div>
      {/if}
    </div>
  </div>
</div>
