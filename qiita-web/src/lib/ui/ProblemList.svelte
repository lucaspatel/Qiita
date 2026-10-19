<script lang="ts" module>
  export type { Problem } from '$lib/table/model';
</script>

<script lang="ts">
  import type { Problem } from '$lib/table/model';
  // The problems in a set of tables, grouped so a hundred of one mistake read as one
  // line, with every instance a click away from its cell.
  let {
    problems,
    sheetTitle = (k: string) => k,
    onpick
  }: {
    problems: Problem[];
    sheetTitle?: (key: string) => string;
    onpick?: (p: Problem) => void;
  } = $props();

  const SHOWN = 8; // chips shown per group before "+N more"
  type Group = { key: string; level: Problem['level']; column?: string; message: string; items: Problem[] };

  let show = $state<Record<Problem['level'], boolean>>({ error: true, warning: true });
  let open = $state<Record<string, boolean>>({});

  const groups = $derived.by(() => {
    const by = new Map<string, Group>();
    for (const p of problems) {
      const key = `${p.level}|${p.at?.column ?? ''}|${p.message}`;
      const g = by.get(key) ?? { key, level: p.level, column: p.at?.column, message: p.message, items: [] };
      g.items.push(p);
      by.set(key, g);
    }
    // Errors first, then the biggest groups: the fix that clears the most goes on top.
    return [...by.values()].sort(
      (a, b) => (a.level === b.level ? b.items.length - a.items.length : a.level === 'error' ? -1 : 1)
    );
  });
  const counts = $derived({
    error: problems.filter((p) => p.level === 'error').length,
    warning: problems.filter((p) => p.level === 'warning').length
  });
  const visible = $derived(groups.filter((g) => show[g.level]));
  const multiSheet = $derived(new Set(problems.map((p) => p.at?.sheet).filter(Boolean)).size > 1);
</script>

<section class="min-w-0 text-xs" aria-label="Things to fix">
  <div class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-gray-100 pb-2">
    <h3 class="text-sm font-medium text-gray-700">
      {#if problems.length}
        {problems.length} {problems.length === 1 ? 'thing' : 'things'} to fix
      {:else}
        Nothing to fix
      {/if}
    </h3>
    {#if counts.error && counts.warning}
      {#each ['error', 'warning'] as const as level (level)}
        <label class="flex cursor-pointer items-center gap-1.5 text-gray-500">
          <input type="checkbox" class="size-3 accent-gray-600" bind:checked={show[level]} />
          <span class="size-1.5 rounded-full {level === 'error' ? 'bg-red-400' : 'bg-amber-400'}"></span>
          {counts[level]} {level === 'error' ? 'must fix' : 'worth a look'}
        </label>
      {/each}
    {/if}
    {#if !problems.length}<span class="text-gray-500">every rule passes</span>{/if}
  </div>

  <ul class="divide-y divide-gray-100">
    {#each visible as g (g.key)}
      {@const expanded = !!open[g.key]}
      {@const cells = g.items.filter((p) => p.at)}
      {@const chips = expanded ? cells : cells.slice(0, SHOWN)}
      <li class="flex flex-col gap-1.5 py-2 sm:flex-row sm:items-start sm:gap-4">
        <div class="flex shrink-0 items-baseline gap-2 sm:w-72">
          <span class="relative top-[-1px] size-1.5 shrink-0 rounded-full {g.level === 'error' ? 'bg-red-400' : 'bg-amber-400'}"></span>
          <span class="min-w-0 text-gray-700">
            {#if g.column}<span class="font-mono text-gray-900">{g.column}</span>&nbsp;·&nbsp;{/if}{g.message}
          </span>
          {#if cells.length}<span class="ml-auto text-gray-400 tabular-nums">{g.items.length}</span>{/if}
        </div>
        {#if cells.length}
          <div class="flex min-w-0 flex-1 flex-wrap gap-1">
            {#each chips as p, i (i)}
              <button
                type="button"
                class="max-w-56 truncate rounded bg-gray-50 px-1.5 py-0.5 font-mono text-gray-700 ring-1 ring-gray-200 ring-inset hover:bg-white hover:text-gray-900 hover:ring-gray-400"
                title="{p.at!.value ? `${p.at!.value} — ` : ''}go to this cell"
                onclick={() => onpick?.(p)}
              >
                {p.at!.label || `row ${p.at!.row + 1}`}{#if multiSheet && p.at!.sheet}<span class="text-gray-400"> · {sheetTitle(p.at!.sheet)}</span>{/if}
              </button>
            {/each}
            {#if cells.length > SHOWN}
              <button type="button" class="rounded px-1.5 py-0.5 text-gray-500 hover:text-gray-900" onclick={() => (open[g.key] = !expanded)}>
                {expanded ? 'fewer' : `+${cells.length - SHOWN} more`}
              </button>
            {/if}
          </div>
        {/if}
      </li>
    {/each}
  </ul>
</section>
