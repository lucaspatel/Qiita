<script lang="ts">
  // One dot per sample: two per-sample counts against each other (e.g. reads vs
  // ASVs). Each axis is log (depth spans orders of magnitude) or linear from
  // zero; clicking its label switches it. Samples missing either value are left
  // out, and on a log axis so is a zero; the legend says how many. A rarefaction
  // depth on the x count draws a line there and greys the samples below it, so a
  // depth's cost is visible.
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
    onDepthChange,
    xLog = $bindable(true),
    yLog = $bindable(true)
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
    /** Each axis's scale: log, or linear from zero. */
    xLog?: boolean;
    yLog?: boolean;
  } = $props();

  // A log axis can't place a zero; a linear one places everything.
  const shown = $derived(points.filter((p) => (!xLog || p.x > 0) && (!yLog || p.y > 0)));
  const zeros = $derived(points.length - shown.length);

  // Round ticks for a log axis: 1-2-5 per decade, or every integer step when the
  // data spans less than a decade (the default ticks then land on odd values).
  function logTicks(values: number[]): number[] {
    const pos = values.filter((v) => v > 0);
    if (!pos.length) return [];
    const lo = Math.min(...pos);
    const hi = Math.max(...pos);
    const steps = hi / lo < 10 ? [1, 2, 3, 4, 5, 6, 7, 8, 9] : hi / lo < 1e3 ? [1, 2, 5] : [1];
    const out: number[] = [];
    for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++)
      for (const m of steps) {
        const t = m * 10 ** e;
        // Inside the data's range: the axis ends there, and a tick past it draws
        // over the label.
        if (t >= lo && t <= hi) out.push(t);
      }
    return out;
  }
  const scale = (log: boolean, values: number[]) =>
    log ? { type: 'log' as const, ticks: logTicks(values), label: false as const } : { type: 'linear' as const, zero: true, nice: true, label: false as const };
  const xScale = $derived(scale(xLog, shown.map((p) => p.x)));
  const yScale = $derived(scale(yLog, shown.map((p) => p.y)));

  let depth = $state<number | null>(null);
  // The starting depth applies once the points are in (they can arrive after the
  // first render), and only if a sample has exactly that depth.
  let started = false;
  $effect(() => {
    if (started || !points.length) return;
    started = true;
    if (initialDepth != null && points.some((p) => p.x === initialDepth)) depth = initialDepth;
  });
  const kept = $derived(depth == null ? shown : shown.filter((p) => p.x >= depth!));
  const below = $derived(depth == null ? [] : shown.filter((p) => p.x < depth!));

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
    <!-- The axis labels are buttons over the plot: a click switches that axis
         between log and linear. -->
    <button
      type="button"
      class="absolute top-0 left-0 z-10 rounded px-1 text-xs text-gray-500 hover:bg-gray-100 hover:text-gray-800"
      title="Switch to a {yLog ? 'linear' : 'log'} scale"
      onclick={() => (yLog = !yLog)}>↑ {yLabel}{yLog ? ' (log)' : ''}</button
    >
    <button
      type="button"
      class="absolute right-0 bottom-0 z-10 rounded px-1 text-xs text-gray-500 hover:bg-gray-100 hover:text-gray-800"
      title="Switch to a {xLog ? 'linear' : 'log'} scale"
      onclick={() => (xLog = !xLog)}>{xLabel}{xLog ? ' (log)' : ''} →</button
    >
    <Plot height={360} grid marginTop={28} marginRight={20} marginBottom={40} x={xScale} y={yScale}>
      {#each marks as [k, mk] (k)}
        <Dot data={mk.pts} x="x" y="y" r={3.5} fill={mk.fill} symbol={mk.symbol} fillOpacity={mk.opacity} />
      {/each}
      {#if depth != null}
        <RuleX data={[depth]} stroke="#0f766e" strokeDasharray="4 3" />
      {/if}
      <!-- HTML, so it goes in the overlay layer above the SVG: inside the SVG
           with the marks, no browser draws it. -->
      {#snippet overlay()}
        <HTMLTooltip data={shown} x="x" y="y">
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
      {#if zeros}
        <div class="text-gray-400">{zeros} with a zero not shown on a log axis</div>
      {/if}
    </div>
  </div>
</div>
