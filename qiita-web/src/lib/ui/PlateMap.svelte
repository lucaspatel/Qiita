<script lang="ts" module>
  export type Well = { fill: string; ring?: string; title: string; mark?: string };
</script>

<script lang="ts">
  // A 96- or 384-well plate drawn as a grid of wells. Each filled well has a fill
  // colour, an optional ring (a problem) and a tooltip; clicking one calls `onpick`.
  import { COLS_384, COLS_96, ROWS_384, ROWS_96 } from '$lib/libraryPrep/mock';

  let {
    format = 96,
    wells,
    selected = null,
    onpick
  }: {
    format?: 96 | 384;
    wells: Record<string, Well>;
    selected?: string | null;
    onpick?: (well: string) => void;
  } = $props();

  const rows = $derived(format === 96 ? ROWS_96 : ROWS_384);
  const cols = $derived(format === 96 ? COLS_96 : COLS_384);
  const size = $derived(format === 96 ? 'size-7' : 'size-[15px]');
</script>

<div class="inline-block rounded-xl border border-gray-300 bg-gray-50 p-2 shadow-inner">
  <div class="grid gap-[3px]" style="grid-template-columns: auto repeat({cols.length}, min-content)">
    <span></span>
    {#each cols as c}
      <span class="text-center text-[9px] leading-3 text-gray-400">{c}</span>
    {/each}
    {#each rows as r}
      <span class="pr-1 text-right text-[9px] leading-none text-gray-400 self-center">{r}</span>
      {#each cols as c}
        {@const id = `${r}${c}`}
        {@const w = wells[id]}
        <button
          type="button"
          class="{size} flex items-center justify-center rounded-full text-[8px] font-semibold text-white transition
            {w ? '' : 'border border-dashed border-gray-300 bg-white'}
            {selected === id ? 'ring-2 ring-gray-900 ring-offset-1' : w?.ring ? `ring-2 ${w.ring}` : ''}"
          style={w ? `background:${w.fill}` : ''}
          title={w ? `${id} · ${w.title}` : `${id} · empty`}
          aria-label={w ? `${id} ${w.title}` : `${id} empty`}
          onclick={() => onpick?.(id)}
        >
          {w?.mark ?? ''}
        </button>
      {/each}
    {/each}
  </div>
</div>
