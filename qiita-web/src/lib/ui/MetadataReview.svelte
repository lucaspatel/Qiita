<script lang="ts">
  // The metadata validation loop: the sheet as an editable grid coloured by
  // metameq's findings, a fix popover on each problem cell, the issues grouped
  // underneath for bulk fixes, and a preview of what metameq's extension would add.
  // Edits and "keep as delivered" marks hold until the next validation, which
  // always re-checks the whole sheet (a fixed host type changes a row's rules).
  import {
    AUTO_FIX_RULES,
    KIND_STYLE,
    cellKey,
    groupIssues,
    perCellRule,
    placeIssues,
    type CellIssue,
    type Issue,
    type IssueGroup,
    type Review
  } from '$lib/metadataReview';

  let {
    headers = $bindable(),
    rows = $bindable(),
    review,
    extended,
    idCol,
    tubeCol,
    validating,
    validatingLabel = 'Checking…',
    onRevalidate
  }: {
    headers: string[];
    rows: string[][];
    review: Review | null;
    /** metameq's extended rows (keyed by sample_name), for applying its additions. */
    extended: Record<string, unknown>[] | null;
    idCol: number;
    tubeCol: number;
    validating: boolean;
    /** What the toolbar says while a check runs. */
    validatingLabel?: string;
    onRevalidate: () => void;
  } = $props();

  const PAGE = 50;

  // Cells changed since the review (cleared by each new review), and curation
  // findings kept as delivered — kept by (sample, field, value), so a keep survives
  // re-validation until the value changes, and is dropped when a new sheet loads.
  let edited = $state(new Set<string>());
  let keptFindings = $state(new Set<string>());
  const findingKey = (i: { sample: string; field: string; value: string | null }) =>
    `${i.sample}\u0000${i.field}\u0000${i.value ?? ''}`;
  let lastReview: Review | null = null;
  $effect(() => {
    if (review !== lastReview) {
      if (!review) keptFindings = new Set();
      lastReview = review;
      edited = new Set();
      focus = null;
      view = review && review.issues.length ? 'problems' : 'all';
      page = 0;
    }
  });

  const placed = $derived<{ cells: Map<string, CellIssue>; unplaced: Issue[] }>(
    review ? placeIssues(review, headers, rows) : { cells: new Map(), unplaced: [] }
  );
  const kept = $derived(
    new Set([...placed.cells.values()].filter((ci) => keptFindings.has(findingKey(ci))).map((ci) => cellKey(ci.r, ci.c)))
  );
  const open = $derived(
    [...placed.cells.values()].filter((ci) => !edited.has(cellKey(ci.r, ci.c)) && !kept.has(cellKey(ci.r, ci.c)))
  );
  const openByCell = $derived(new Map(open.map((ci) => [cellKey(ci.r, ci.c), ci])));
  const groups = $derived(groupIssues(open));
  const counts = $derived({
    error: open.filter((i) => i.kind === 'error').length,
    type: open.filter((i) => i.kind === 'type').length,
    curation: open.filter((i) => i.kind === 'curation').length
  });
  const safeFixes = $derived(open.filter((i) => i.suggestions[0] && AUTO_FIX_RULES.has(i.suggestions[0].rule)));

  // --- which rows show -------------------------------------------------------
  let view = $state<'all' | 'problems' | string>('all'); // 'all', 'problems', or a group key
  let page = $state(0);
  const visibleRows = $derived.by(() => {
    if (view === 'all') return rows.map((_, r) => r);
    const set = new Set<number>();
    if (view === 'problems') {
      for (const ci of open) set.add(ci.r);
      for (const k of edited) set.add(Number(k.split(':')[0]));
    } else {
      for (const ci of open) if (ci.group === view) set.add(ci.r);
    }
    return [...set].sort((a, b) => a - b);
  });
  const pageCount = $derived(Math.max(1, Math.ceil(visibleRows.length / PAGE)));
  const clamped = $derived(Math.min(page, pageCount - 1));
  const pagedRows = $derived(visibleRows.slice(clamped * PAGE, clamped * PAGE + PAGE));
  const viewGroup = $derived(groups.find((g) => g.key === view) ?? null);
  // The id column fits its longest id, so ids are never cut off.
  const idWidth = $derived(Math.min(48, Math.max(12, ...rows.map((cells) => (cells[idCol] ?? '').length))) + 2);

  // Which columns show: in a problem view, only the id column and those with an
  // open issue or an edit on this page (so the red is on screen, not off to the
  // right); "All rows" shows every column.
  const visibleCols = $derived.by(() => {
    const all = headers.map((_, c) => c);
    if (view === 'all') return all;
    // From the rows on this page, so every column shown has something to fix here.
    const keep = new Set<number>([idCol]);
    const shown = new Set(pagedRows);
    for (const ci of open) if (shown.has(ci.r) && (view === 'problems' || ci.group === view)) keep.add(ci.c);
    for (const k of edited) {
      const [r, c] = k.split(':').map(Number);
      if (shown.has(r)) keep.add(c);
    }
    return all.filter((c) => keep.has(c));
  });

  // --- edits -----------------------------------------------------------------
  function setCell(r: number, c: number, value: string) {
    rows[r][c] = value;
    edited = new Set(edited).add(cellKey(r, c));
  }
  function applyEach(cells: CellIssue[], valueOf: (ci: CellIssue) => string | undefined) {
    const next = new Set(edited);
    for (const ci of cells) {
      const v = valueOf(ci);
      if (v === undefined) continue;
      rows[ci.r][ci.c] = v;
      next.add(cellKey(ci.r, ci.c));
    }
    edited = next;
  }
  const applyValue = (cells: CellIssue[], value: string) => applyEach(cells, () => value);
  const applyRule = (cells: CellIssue[], rule: string) =>
    applyEach(cells, (ci) => ci.suggestions.find((s) => s.rule === rule)?.value);
  function keep(cells: CellIssue[]) {
    const next = new Set(keptFindings);
    for (const ci of cells) next.add(findingKey(ci));
    keptFindings = next;
  }
  function applySafeFixes() {
    applyEach(safeFixes, (ci) => ci.suggestions[0].value);
  }

  // --- the cell popover ------------------------------------------------------
  let focus = $state<{ r: number; c: number; x: number; y: number } | null>(null);
  // The cell the popover belongs to: it follows the cell when anything scrolls
  // (focusing an input scrolls it into view, so closing on scroll would close
  // the popover as it opens).
  let anchor: HTMLElement | null = null;
  function place() {
    if (!focus || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    focus = { ...focus, x: rect.left, y: rect.bottom + 4 };
  }
  const focused = $derived(focus ? (openByCell.get(cellKey(focus.r, focus.c)) ?? null) : null);
  const focusedGroup = $derived(focused ? (groups.find((g) => g.key === focused.group) ?? null) : null);
  let customValue = $state('');
  function openPopover(e: Event, r: number, c: number) {
    if (!openByCell.has(cellKey(r, c))) {
      focus = null;
      return;
    }
    anchor = e.currentTarget as HTMLElement;
    const rect = anchor.getBoundingClientRect();
    focus = { r, c, x: rect.left, y: rect.bottom + 4 };
    customValue = rows[r][c] ?? '';
  }
  function closePopover() {
    focus = null;
    anchor = null;
  }

  // --- group list ------------------------------------------------------------
  let replaceWith = $state<Record<string, string>>({});
  const groupTitle = (g: IssueGroup) =>
    perCellRule(g) === 'iso-date'
      ? `${g.cells.length} dates in month/day/year form`
      : g.value === null || g.value === ''
        ? '(empty)'
        : `'${g.value}'`;

  // --- metameq's extension ---------------------------------------------------
  let useSource = $state<Record<string, boolean>>({});
  const extensionSize = $derived(
    review?.extension
      ? review.extension.added.length +
          review.extension.filled.reduce((n, f) => n + f.count, 0)
      : 0
  );
  function applyExtension() {
    if (!review?.extension || !extended) return;
    const nameCol = headers.indexOf('sample_name');
    const extByName = new Map(extended.map((e) => [String(e.sample_name ?? ''), e]));
    const next = new Set(edited);
    for (const a of review.extension.added) {
      if (headers.includes(a.column)) continue;
      const flag = review.extension.flags.find((f) => f.column === a.column);
      const sourceCol = flag && useSource[a.column] ? headers.indexOf(flag.source) : -1;
      headers.push(a.column);
      const c = headers.length - 1;
      rows.forEach((cells, r) => {
        const fromExt = String(extByName.get(cells[nameCol] ?? '')?.[a.column] ?? '');
        cells[c] = sourceCol >= 0 && cells[sourceCol] ? cells[sourceCol] : fromExt;
        next.add(cellKey(r, c));
      });
    }
    for (const f of review.extension.filled) {
      const c = headers.indexOf(f.column);
      if (c < 0) continue;
      rows.forEach((cells, r) => {
        if ((cells[c] ?? '').trim()) return;
        const v = String(extByName.get(cells[nameCol] ?? '')?.[f.column] ?? '');
        if (v) {
          cells[c] = v;
          next.add(cellKey(r, c));
        }
      });
    }
    edited = next;
  }
  function addColumn(name: string) {
    if (headers.includes(name)) return;
    headers.push(name);
    rows.forEach((cells) => cells.push(''));
  }
</script>

<!-- Escape closes an open popover and stops there: in capture, so the dialog this
     sits in (which also closes on Escape) never sees it. -->
<svelte:window
  onkeydowncapture={(e) => {
    if (e.key === 'Escape' && focus) {
      e.stopImmediatePropagation();
      e.preventDefault();
      closePopover();
    }
  }}
  onscrollcapture={place}
/>

<div class="flex min-h-0 flex-1 flex-col">
  <!-- One toolbar: which rows, what's open, the fixes that need no judgement, re-check. -->
  <div class="flex flex-wrap items-center gap-2 border-b border-gray-200 bg-gray-50 px-4 py-2 text-xs text-gray-600">
    <div class="inline-flex overflow-hidden rounded-md ring-1 ring-gray-300">
      {#each [['problems', 'Problems'], ['all', 'All rows']] as [v, label]}
        <button
          class="px-2.5 py-1 {view === v || (v === 'problems' && viewGroup) ? 'bg-gray-800 text-white' : 'bg-white hover:bg-gray-50'} disabled:opacity-40"
          disabled={v === 'problems' && !review}
          onclick={() => {
            view = v;
            page = 0;
          }}>{label}</button
        >
      {/each}
    </div>
    {#if viewGroup}
      <span class="rounded-md bg-white px-2 py-1 ring-1 ring-gray-200">
        {viewGroup.field} {groupTitle(viewGroup)}
        <button class="ml-1 text-gray-400 hover:text-gray-700" onclick={() => (view = 'problems')} aria-label="Show all problems">✕</button>
      </span>
    {/if}
    <span class="text-gray-400">{visibleRows.length} of {rows.length} rows</span>
    {#if review}
      {#each Object.entries(counts) as [kind, n]}
        {#if n}
          <span class="rounded-full px-2 py-0.5 font-medium ring-1 ring-inset {KIND_STYLE[kind as keyof typeof KIND_STYLE].chip}">
            {n} {KIND_STYLE[kind as keyof typeof KIND_STYLE].label}
          </span>
        {/if}
      {/each}
      {#if !open.length}
        <span class="font-medium text-green-700">No open issues{edited.size ? ' — re-check to confirm' : ''}</span>
      {/if}
      {#if kept.size}<span class="text-amber-700">{kept.size} kept as delivered</span>{/if}
    {/if}
    {#if validating}<span class="text-gray-500">{validatingLabel}</span>{/if}
    <span class="ml-auto flex items-center gap-2">
      {#if review && safeFixes.length}
        <button
          class="rounded-md bg-teal-600 px-2.5 py-1 font-medium text-white hover:bg-teal-500"
          title="ISO dates, spellings of the allowed value, and host types inferred from the sample type"
          onclick={applySafeFixes}>Apply {safeFixes.length} safe fixes</button
        >
      {/if}
      {#if review && edited.size}
        <button
          class="rounded-md bg-white px-2.5 py-1 font-medium text-teal-700 ring-1 ring-teal-600/30 ring-inset hover:bg-teal-50 disabled:opacity-40"
          onclick={onRevalidate}
          disabled={validating}>Re-check {edited.size} edit{edited.size === 1 ? '' : 's'}</button
        >
      {/if}
      {#if pageCount > 1}
        <button class="rounded bg-white px-2 py-0.5 ring-1 ring-gray-200 disabled:opacity-40" disabled={clamped === 0} onclick={() => (page = clamped - 1)}>Prev</button>
        <span>{clamped + 1} / {pageCount}</span>
        <button class="rounded bg-white px-2 py-0.5 ring-1 ring-gray-200 disabled:opacity-40" disabled={clamped >= pageCount - 1} onclick={() => (page = clamped + 1)}>Next</button>
      {/if}
    </span>
  </div>

  <div class="flex min-h-0 flex-1 flex-col lg:flex-row">
  <!-- The grid, edge to edge, with column lines -->
  <div class="min-h-64 min-w-0 flex-1 overflow-auto" onscroll={place}>
    <table class="min-w-full border-separate border-spacing-0 text-xs">
      <thead class="sticky top-0 z-10 bg-gray-50">
        <tr>
          {#each visibleCols as i (i)}
            {@const h = headers[i]}
            <th
              class="border-r border-b border-gray-200 px-2 py-1.5 text-left font-semibold whitespace-nowrap {i === idCol
                ? 'sticky left-0 z-10 bg-gray-50 text-teal-700'
                : i === tubeCol
                  ? 'text-amber-700'
                  : 'text-gray-500'}"
            >
              {h}{#if i === tubeCol}<span class="font-normal"> · tube</span>{/if}
            </th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each pagedRows as r (r)}
          <tr>
            {#each visibleCols as c (c)}
              {@const key = cellKey(r, c)}
              {@const issue = openByCell.get(key)}
              <td class="border-r border-b border-gray-100 p-0 {c === idCol ? 'sticky left-0 z-[5] border-r-gray-200 bg-white' : ''}">
                <input
                  value={rows[r][c] ?? ''}
                  readonly={c === idCol}
                  oninput={(e) => setCell(r, c, (e.currentTarget as HTMLInputElement).value)}
                  onclick={(e) => openPopover(e, r, c)}
                  onfocus={(e) => openPopover(e, r, c)}
                  title={issue?.message ?? (c === idCol ? 'The sample id: fix it in the sheet' : edited.has(key) ? 'Edited — re-check to confirm' : kept.has(key) ? 'Kept as delivered' : '')}
                  style={c === idCol ? `width:${idWidth}ch` : undefined}
                  class="{c === idCol ? 'font-mono' : 'w-full min-w-28'} border-0 px-2 py-1 text-xs focus:bg-white focus:ring-1 focus:ring-teal-500 focus:outline-none focus:ring-inset {issue
                    ? `${KIND_STYLE[issue.kind].cell} cursor-pointer`
                    : edited.has(key)
                      ? 'bg-teal-50 text-teal-900'
                      : kept.has(key)
                        ? 'bg-amber-50/40 text-gray-700'
                        : 'bg-transparent text-gray-700'}"
                />
              </td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
<!-- The fix popover, beside the clicked cell -->
{#if focus && focused}
  <div
    class="fixed z-50 w-80 rounded-lg bg-white p-3 text-xs shadow-lg ring-1 ring-gray-200"
    style="left:{Math.min(focus.x, (typeof window !== 'undefined' ? window.innerWidth : 1200) - 340)}px;top:{focus.y}px"
    role="dialog"
    aria-label="Fix this cell"
  >
    <div class="mb-1.5 flex items-center gap-2">
      <span class="rounded-full px-2 py-0.5 font-medium ring-1 ring-inset {KIND_STYLE[focused.kind].chip}">{KIND_STYLE[focused.kind].label}</span>
      <span class="font-mono text-gray-500">{focused.field}</span>
      <button class="ml-auto text-gray-400 hover:text-gray-700" onclick={closePopover} aria-label="Close">✕</button>
    </div>
    <p class="mb-2 text-gray-700">{focused.message}</p>
    {#if focused.suggestions.length}
      <div class="mb-2 flex flex-wrap gap-1.5">
        {#each focused.suggestions.slice(0, 6) as s}
          <span class="inline-flex overflow-hidden rounded-md ring-1 ring-teal-600/30">
            <button class="bg-teal-50 px-2 py-0.5 text-teal-800 hover:bg-teal-100" onclick={() => { setCell(focused.r, focused.c, s.value); closePopover(); }}>{s.label}</button>
            {#if focusedGroup && focusedGroup.cells.length > 1}
              <button
                class="border-l border-teal-600/20 bg-white px-1.5 text-teal-700 hover:bg-teal-50"
                title="Apply to all {focusedGroup.cells.length} like this"
                onclick={() => { if (perCellRule(focusedGroup) === s.rule) applyRule(focusedGroup.cells, s.rule); else applyValue(focusedGroup.cells, s.value); closePopover(); }}
                >×{focusedGroup.cells.length}</button
              >
            {/if}
          </span>
        {/each}
      </div>
    {/if}
    <form
      class="flex gap-1.5"
      onsubmit={(e) => { e.preventDefault(); setCell(focused.r, focused.c, customValue); closePopover(); }}
    >
      <input bind:value={customValue} class="min-w-0 flex-1 rounded border border-gray-300 px-2 py-1" aria-label="New value" />
      <button class="rounded bg-gray-800 px-2 py-1 text-white">Set</button>
      {#if focusedGroup && focusedGroup.cells.length > 1}
        <button type="button" class="rounded bg-white px-2 py-1 ring-1 ring-gray-300" onclick={() => { applyValue(focusedGroup.cells, customValue); closePopover(); }}>All {focusedGroup.cells.length}</button>
      {/if}
    </form>
    {#if focused.kind === 'curation'}
      <div class="mt-2 flex gap-1.5 border-t border-gray-100 pt-2">
        <button class="rounded bg-amber-50 px-2 py-1 text-amber-800 ring-1 ring-amber-600/20" onclick={() => { keep([focused]); closePopover(); }}>Keep as delivered</button>
        {#if focusedGroup && focusedGroup.cells.length > 1}
          <button class="rounded bg-white px-2 py-1 text-amber-800 ring-1 ring-amber-600/20" onclick={() => { keep(focusedGroup.cells); closePopover(); }}>Keep all {focusedGroup.cells.length}</button>
        {/if}
      </div>
    {/if}
  </div>
{/if}

{#if review && (groups.length || placed.unplaced.length || (review.extension && extensionSize))}
  <!-- Fixes, beside the grid: issues grouped by shared fix, then the standard's defaults. -->
  <aside class="max-h-[45%] shrink-0 overflow-auto border-t border-gray-200 lg:max-h-none lg:w-[26rem] lg:border-t-0 lg:border-l">
  {#if groups.length || placed.unplaced.length}
    <div>
      <div class="sticky top-0 z-10 border-b border-gray-200 bg-gray-50 px-3 py-1.5 text-xs font-semibold text-gray-600">
        Fixes ({groups.length} group{groups.length === 1 ? '' : 's'})
      </div>
      <ul class="divide-y divide-gray-100">
        {#each placed.unplaced.filter((i, k, a) => a.findIndex((j) => j.field === i.field) === k) as u}
          <li class="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
            <span class="rounded-full px-2 py-0.5 font-medium ring-1 ring-inset {KIND_STYLE[u.kind].chip}">{KIND_STYLE[u.kind].label}</span>
            <span class="font-mono text-gray-700">{u.field}</span>
            <span class="text-gray-600">not a column of this sheet: {u.message}</span>
            <button class="ml-auto rounded bg-white px-2 py-0.5 ring-1 ring-gray-300" onclick={() => addColumn(u.field)}>Add column</button>
          </li>
        {/each}
        {#each groups as g (g.key)}
          {@const rule = perCellRule(g)}
          <li class="space-y-1.5 px-3 py-2 text-xs {view === g.key ? 'bg-teal-50/50' : ''}">
            <button
              class="flex w-full flex-wrap items-center gap-x-2 gap-y-1 text-left hover:underline"
              title="Show these rows"
              onclick={() => { view = view === g.key ? 'problems' : g.key; page = 0; }}
            >
              <span class="rounded-full px-2 py-0.5 font-medium ring-1 ring-inset {KIND_STYLE[g.kind].chip}">{KIND_STYLE[g.kind].label}</span>
              <span class="font-mono text-gray-700">{g.field}</span>
              <span class="text-gray-800">{groupTitle(g)}</span>
              <span class="text-gray-400">{g.cells.length}</span>
            </button>
            <p class="text-gray-600">{rule === 'iso-date' ? 'Dates must be YYYY-MM-DD[ HH:MM].' : g.message}</p>
            <div class="flex flex-wrap items-center gap-1.5">
              {#if rule === 'iso-date'}
                <button class="rounded-md bg-teal-50 px-2 py-0.5 text-teal-800 ring-1 ring-teal-600/30 hover:bg-teal-100" onclick={() => applyRule(g.cells, 'iso-date')}>Convert all {g.cells.length} to ISO</button>
              {:else}
                {#each g.suggestions.slice(0, 5) as s}
                  <button class="rounded-md bg-teal-50 px-2 py-0.5 text-teal-800 ring-1 ring-teal-600/30 hover:bg-teal-100" onclick={() => applyValue(g.cells, s.value)}>{s.label}{g.cells.length > 1 ? ` ×${g.cells.length}` : ''}</button>
                {/each}
              {/if}
              {#if g.kind === 'curation'}
                <button class="rounded-md bg-amber-50 px-2 py-0.5 text-amber-800 ring-1 ring-amber-600/20" onclick={() => keep(g.cells)}>Keep all as delivered</button>
              {/if}
              <form
                class="inline-flex gap-1"
                onsubmit={(e) => { e.preventDefault(); applyValue(g.cells, replaceWith[g.key] ?? ''); }}
              >
                <input
                  placeholder="replace with…"
                  value={replaceWith[g.key] ?? ''}
                  oninput={(e) => (replaceWith = { ...replaceWith, [g.key]: (e.currentTarget as HTMLInputElement).value })}
                  class="w-36 rounded border border-gray-300 px-2 py-0.5"
                />
                <button class="rounded bg-gray-800 px-2 py-0.5 text-white disabled:opacity-40" disabled={!replaceWith[g.key]}>Apply</button>
              </form>
            </div>
          </li>
        {/each}
      </ul>
    </div>
  {/if}

  <!-- What metameq's extension would add -->
  {#if review.extension && extensionSize}
    <div class="border-t border-gray-200">
      <div class="sticky top-0 z-10 flex items-center gap-2 border-b border-gray-200 bg-gray-50 px-3 py-1.5 text-xs">
        <span class="font-semibold text-gray-600" title="Nothing changes until you apply them">Standard's defaults</span>
        <button class="ml-auto rounded-md bg-white px-2.5 py-1 font-medium text-teal-700 ring-1 ring-teal-600/30 ring-inset hover:bg-teal-50 disabled:opacity-40" disabled={!extended} onclick={applyExtension}>Apply these additions</button>
      </div>
      <div class="space-y-2 px-3 py-2 text-xs">
        {#each review.extension.flags as f}
          <div class="rounded-md bg-amber-50 px-2.5 py-1.5 text-amber-900 ring-1 ring-amber-600/20">
            ⚠ {f.message}
            <label class="mt-1 flex items-center gap-1.5">
              <input type="checkbox" class="accent-teal-600" checked={useSource[f.column] ?? false} onchange={(e) => (useSource = { ...useSource, [f.column]: (e.currentTarget as HTMLInputElement).checked })} />
              Fill '{f.column}' from '{f.source}' instead
            </label>
          </div>
        {/each}
        {#if review.extension.added.length}
          <p class="text-gray-700">
            <span class="font-medium">Adds column{review.extension.added.length === 1 ? '' : 's'}:</span>
            {#each review.extension.added as a, k}{k ? ', ' : ''}<span class="font-mono">{a.column}</span> ({Object.entries(a.values).map(([v, n]) => `${v} ${n}`).join(', ')}){/each}
          </p>
        {/if}
        {#if review.extension.filled.length}
          <p class="text-gray-700"><span class="font-medium">Fills blanks in {review.extension.filled.length} columns:</span></p>
          <ul class="space-y-0.5 text-gray-600">
            {#each review.extension.filled.slice(0, 12) as f}
              <li><span class="font-mono">{f.column}</span> · {f.count} → {Object.keys(f.values).join(' / ')}</li>
            {/each}
          </ul>
          {#if review.extension.filled.length > 12}<p class="text-gray-400">and {review.extension.filled.length - 12} more columns</p>{/if}
        {/if}
      </div>
    </div>
  {/if}
  </aside>
{/if}
  </div>
</div>
