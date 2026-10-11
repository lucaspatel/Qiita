<script lang="ts">
  // Beside a plot of samples: which metadata variables colour and shape its
  // markers, their legends, and (for an ordination) a PERMANOVA by the colour.
  import { GRADIENT_CSS, type LegendEntry, type ShapeEntry } from '$lib/colorBy';
  import type { Permanova } from '$lib/pyodide/pyodide.svelte';
  import Select from './Select.svelte';

  let {
    variables,
    value = $bindable(),
    legend,
    gradient = null,
    continuous = $bindable(false),
    shape = $bindable(''),
    shapeLegend = [],
    shapeRepeats = false,
    permanova = undefined,
    loading = false
  }: {
    variables: string[];
    value: string;
    legend: LegendEntry[];
    /** A numeric variable's gradient ends, on the continuous palette. */
    gradient?: { min: string; max: string } | null;
    continuous?: boolean;
    /** The variable markers are shaped by; '' for none. */
    shape?: string;
    shapeLegend?: ShapeEntry[];
    shapeRepeats?: boolean;
    /** null while computing; a string when there is no test to run; absent
     *  (undefined) where no test applies, which hides the block. */
    permanova?: Permanova | string | null;
    loading?: boolean;
  } = $props();

  const fmtP = (p: number, perms: number) =>
    p <= 1 / (perms + 1) ? `< ${(1 / (perms + 1)).toFixed(3)}` : p.toFixed(3);
</script>

<div class="space-y-4 px-4 pb-4 text-sm sm:px-6">
  <label class="block">
    <span class="mb-1 block text-xs font-medium text-gray-500">Color by</span>
    {#if loading}
      <span class="text-xs text-gray-400">Loading sample metadata…</span>
    {:else}
      <Select bind:value class="w-full">
        {#each variables as v (v)}<option value={v}>{v}</option>{/each}
      </Select>
    {/if}
  </label>

  {#if !loading}
    <label class="flex cursor-pointer items-center gap-2 text-xs text-gray-600 select-none">
      <input type="checkbox" bind:checked={continuous} class="size-3.5 rounded border-gray-300 accent-teal-600" />
      Continuous palette
    </label>
  {/if}

  {#if !loading && gradient}
    <div>
      <div class="h-2.5 rounded-sm" style="background:{GRADIENT_CSS}"></div>
      <div class="mt-0.5 flex justify-between text-[11px] tabular-nums text-gray-500">
        <span>{gradient.min}</span><span>{gradient.max}</span>
      </div>
    </div>
  {/if}

  {#if !loading && legend.length}
    <ul class="max-h-64 space-y-1 overflow-y-auto">
      {#each legend as e (e.label)}
        <li class="flex items-center gap-2 text-xs text-gray-700">
          <span class="inline-block size-2.5 shrink-0 rounded-full" style="background:{e.color}"></span>
          <span class="min-w-0 flex-1 truncate" title={e.label}>{e.label}</span>
          <span class="tabular-nums text-gray-400">{e.n}</span>
        </li>
      {/each}
    </ul>
  {/if}

  <label class="block">
    <span class="mb-1 block text-xs font-medium text-gray-500">Shape by</span>
    {#if !loading}
      <Select bind:value={shape} class="w-full">
        <option value="">none</option>
        {#each variables as v (v)}<option value={v}>{v}</option>{/each}
      </Select>
    {/if}
  </label>

  {#if !loading && shape && shapeLegend.length}
    <ul class="max-h-48 space-y-1 overflow-y-auto">
      {#each shapeLegend as e (e.label)}
        <li class="flex items-center gap-2 text-xs text-gray-700">
          <span class="inline-block w-2.5 shrink-0 text-center text-[11px] leading-none text-gray-500">{e.glyph}</span>
          <span class="min-w-0 flex-1 truncate" title={e.label}>{e.label}</span>
          <span class="tabular-nums text-gray-400">{e.n}</span>
        </li>
      {/each}
    </ul>
    {#if shapeRepeats}
      <p class="text-[11px] text-gray-400">More than six values: shapes repeat.</p>
    {/if}
  {/if}

  {#if !loading && permanova !== undefined}
    <div class="rounded-md bg-gray-50 px-3 py-2 text-xs ring-1 ring-gray-200">
      <div class="mb-1 font-medium text-gray-700">PERMANOVA (Bray–Curtis)</div>
      {#if permanova == null}
        <span class="text-gray-400">Computing…</span>
      {:else if typeof permanova === 'string'}
        <span class="text-gray-500">{permanova}</span>
      {:else if permanova.skipped}
        <span class="text-gray-500">No test: {permanova.skipped}.</span>
      {:else}
        <dl class="grid grid-cols-2 gap-x-3 gap-y-0.5 text-gray-600">
          <dt>pseudo-F</dt>
          <dd class="text-right tabular-nums">{permanova.test_statistic?.toFixed(3)}</dd>
          <dt>p-value</dt>
          <dd class="text-right tabular-nums">{fmtP(permanova.p_value!, permanova.permutations)}</dd>
          <dt>groups</dt>
          <dd class="text-right tabular-nums">{permanova.number_of_groups}</dd>
          <dt>samples</dt>
          <dd class="text-right tabular-nums">
            {permanova.sample_size}{permanova.excluded ? ` (+${permanova.excluded} missing)` : ''}
          </dd>
          <dt>permutations</dt>
          <dd class="text-right tabular-nums">{permanova.permutations}</dd>
        </dl>
      {/if}
    </div>
  {/if}
</div>
