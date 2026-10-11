<script lang="ts">
  // PC1 against PC2 of a Bray-Curtis PCoA, one dot per sample, in a square frame
  // with both axes on one symmetric range so distance reads the same in every
  // direction. `visible`, when given, limits the dots to those sample labels (a
  // companion table's filter); the ordination itself is of every sample that
  // reaches the depth.
  import { Plot, Dot, HTMLTooltip } from 'svelteplot';
  import type { Pcoa } from '$lib/pyodide/pyodide.svelte';
  import DepthSlider from './DepthSlider.svelte';

  let {
    pcoa,
    visible = null,
    busy = false,
    colorOf = null,
    symbolOf = null,
    displayOf = (k: string) => k,
    onDepth
  }: {
    pcoa: Pcoa;
    visible?: Set<string> | null;
    busy?: boolean;
    /** Sample label -> fill colour; one colour for all when absent. */
    colorOf?: Record<string, string> | null;
    /** Sample label -> marker symbol; circles when absent. */
    symbolOf?: Record<string, string> | null;
    /** A sample key's tooltip text. */
    displayOf?: (key: string) => string;
    onDepth: (depth: number | null) => void;
  } = $props();

  const pct = (i: number) => `${(100 * (pcoa.proportion_explained[i] ?? 0)).toFixed(1)}%`;
  const points = $derived(
    pcoa.samples.flatMap((label, i) =>
      !visible || visible.has(label)
        ? [
            {
              label,
              x: pcoa.axes[0][i],
              y: pcoa.axes[1]?.[i] ?? 0,
              fill: colorOf?.[label] ?? '#0d9488',
              symbol: symbolOf?.[label] ?? 'circle'
            }
          ]
        : []
    )
  );
  // One Dot mark per (colour, shape), each with a constant fill and symbol.
  const byStyle = $derived.by(() => {
    const m = new Map<string, { fill: string; symbol: string; pts: typeof points }>();
    for (const p of points) {
      const k = `${p.fill}|${p.symbol}`;
      if (!m.has(k)) m.set(k, { fill: p.fill, symbol: p.symbol, pts: [] });
      m.get(k)!.pts.push(p);
    }
    return [...m.entries()];
  });
  // One range for both axes, over every placed sample (not just the filtered
  // ones), so filtering doesn't rescale the frame.
  const extent = $derived(
    1.08 * Math.max(...pcoa.axes[0].map(Math.abs), ...(pcoa.axes[1] ?? []).map(Math.abs), 1e-9)
  );
  let width = $state(0);
  const side = $derived(Math.min(width, 560));
</script>

<div class="px-4 pb-4 sm:px-6">
  <p class="mb-2 text-xs font-medium text-gray-500">PCoA · Bray–Curtis</p>
  <DepthSlider depths={pcoa.depths} value={pcoa.depth} allowOff disabled={busy} onCommit={onDepth} />
  <div class="relative mt-2" bind:clientWidth={width}>
    {#if side > 0}
      <div class="relative mx-auto {busy ? 'opacity-40' : ''}" style="width:{side}px">
        <Plot
          width={side}
          height={side}
          grid
          x={{ domain: [-extent, extent], label: `PC1 (${pct(0)}) →` }}
          y={{ domain: [-extent, extent], label: `↑ PC2 (${pct(1)})` }}
        >
          {#each byStyle as [k, st] (k)}
            <Dot data={st.pts} x="x" y="y" r={4} fill={st.fill} symbol={st.symbol} fillOpacity={0.8} />
          {/each}
          <!-- HTML, so it goes in the overlay layer above the SVG: inside the SVG
               with the marks, no browser draws it. -->
          {#snippet overlay()}
            <HTMLTooltip data={points} x="x" y="y">
              {#snippet children({ datum })}
                <!-- The tooltip renders with no datum while nothing is hovered. -->
                {#if datum}
                  <div class="rounded bg-white px-2 py-1 font-mono text-xs whitespace-nowrap text-gray-900 shadow ring-1 ring-gray-200">
                    {displayOf(datum.label)}
                  </div>
                {/if}
              {/snippet}
            </HTMLTooltip>
          {/snippet}
        </Plot>
        <div
          class="pointer-events-none absolute right-2 bottom-12 rounded bg-white/90 px-2 py-1 text-[11px] leading-tight text-gray-500 ring-1 ring-gray-200"
        >
          <div class="flex items-center gap-1.5">
            {points.length} of {pcoa.n_samples} sample{pcoa.n_samples === 1 ? '' : 's'}
          </div>
          <div class="text-gray-400">
            {pcoa.depth == null
              ? 'relative abundance'
              : `rarefied to ${pcoa.depth.toLocaleString()}`}{pcoa.dropped.length
              ? ` · ${pcoa.dropped.length} below depth`
              : ''}
          </div>
          <div class="text-gray-400">{pcoa.n_features.toLocaleString()} features</div>
        </div>
      </div>
    {/if}
  </div>
</div>
