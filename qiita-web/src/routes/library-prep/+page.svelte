<script lang="ts">
  // MOCKUP of the Library prep flow: from "a box of tubes was dropped off" to "the
  // amplicon workflow is running", replacing kl-metapool's
  // amplicon_pre_prep_file_generator notebook. The tube codes drive it: scanning the
  // racks is enough to know which samples and studies are in the box, and anything
  // Qiita-miint can't place is settled before the plates are laid out. It ends in
  // the per-study sample sheets kl-run-preflight builds the run's pre-flight from.
  // One task per screen. Local data only (lib/libraryPrep/); nothing is sent.
  import { untrack } from 'svelte';
  import { api, type PrepProtocol } from '$lib/api';
  import PlateMap, { type Well } from '$lib/ui/PlateMap.svelte';
  import {
    RUN_FOLDERS,
    STUDIES,
    WELLS_96,
    demoBox,
    mockGolay,
    parseVisionMate,
    sampleName,
    to384,
    toVisionMate,
    validatePlates,
    type Demo,
    type Rack,
    type Resolution
  } from '$lib/libraryPrep/mock';
  import {
    PLATE_COLUMNS,
    STUDY_COLUMNS,
    buildSheet,
    type Plate,
    type RunFacts,
    type StudyFacts
  } from '$lib/libraryPrep/sampleSheet';

  const STEPS = ['Protocol', 'Scan', 'Fix', 'Plates', 'Details', 'Pre-flight', 'Sequence'];
  let step = $state(0);
  let reached = $state(0);
  const go = (i: number) => {
    step = i;
    reached = Math.max(reached, i);
  };

  // --- 1. protocol ---
  const SUPPORTED_PROTOCOL = 'short_read_amplicon';
  let protocols = $state<string[]>([SUPPORTED_PROTOCOL]);
  $effect(() => {
    api.prepProtocols().then((r) => {
      if (r.ok && r.data.length)
        protocols = r.data
          .filter((p: PrepProtocol) => !p.retired)
          .map((p) => p.name)
          .sort((a, b) => Number(b === SUPPORTED_PROTOCOL) - Number(a === SUPPORTED_PROTOCOL));
    });
  });
  let protocol = $state<string | null>(null);
  const TARGETS = [
    { id: '16S', label: '16S V4 · 515fbc / 806r (EMP Golay)', enabled: true },
    { id: '18S', label: '18S · 1391f / EukBr', enabled: false },
    { id: 'ITS', label: 'ITS · ITS1f / ITS2', enabled: false }
  ];
  let target = $state<string | null>(null);
  const pretty = (s: string) => s.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase());

  // --- 2. scan ---
  let racks = $state<Rack[]>([]);
  let demo = $state.raw<Demo | null>(null);
  let checking = $state(false);
  let dragging = $state(false);

  function check() {
    checking = true;
    setTimeout(() => (checking = false), 600); // the mock's round trip
  }
  function loadDemo() {
    demo = demoBox();
    racks = demo.racks;
    check();
  }
  async function addFiles(files: FileList | null) {
    if (!files?.length) return;
    demo ??= demoBox(); // the mock's Qiita-miint and defaults
    const parsed = await Promise.all([...files].map(async (f) => parseVisionMate(f.name, await f.text())));
    racks = [...racks, ...parsed].slice(0, 4);
    check();
  }
  function download(name: string, text: string) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = name;
    a.click();
  }
  const downloadDemoRacks = () => demoBox().racks.forEach((r) => download(r.fileName, toVisionMate(r)));

  // --- resolution: what Qiita-miint answers for every tube, and the tech's decisions ---
  type Decision = { primary?: number; exclude?: boolean; blank?: boolean };
  let decisions = $state<Record<string, Decision>>({});
  /** Racks of a study Qiita-miint doesn't have, kept for their sample sheet only. */
  let sheetOnly = $state<Record<string, boolean>>({});
  const keyOf = (r: number, well: string) => `${r}:${well}`;
  const decide = (r: number, well: string, d: Decision) =>
    (decisions = { ...decisions, [keyOf(r, well)]: { ...(decisions[keyOf(r, well)] ?? {}), ...d } });

  const OTHER = 'other'; // the study key of sheet-only plates
  type Cell =
    | { state: 'sample'; study: string; qb: string | null }
    | { state: 'blank' }
    | { state: 'excluded' }
    | { state: 'unknown' }
    | { state: 'multi'; studies: number[] }
    | { state: 'duplicate'; other: string };

  const placesOf = $derived.by(() => {
    // A well left out no longer holds its tube, so its twin stops being a duplicate.
    const n = new Map<string, string[]>();
    racks.forEach((r, ri) => {
      for (const t of r.tubes)
        if (!decisions[keyOf(ri, t.well)]?.exclude) n.set(t.tube, [...(n.get(t.tube) ?? []), `${r.rackId} ${t.well}`]);
    });
    return n;
  });

  function cellOf(r: number, well: string, tube: string): Cell {
    const d = decisions[keyOf(r, well)] ?? {};
    if (d.exclude) return { state: 'excluded' };
    if (d.blank) return { state: 'blank' };
    const places = placesOf.get(tube) ?? [];
    if (places.length > 1) {
      const me = `${racks[r].rackId} ${well}`;
      return { state: 'duplicate', other: places.filter((p) => p !== me).join(', ') };
    }
    const res: Resolution | undefined = demo?.registry.get(tube);
    if (!res) return sheetOnly[racks[r].rackId] ? { state: 'sample', study: OTHER, qb: null } : { state: 'unknown' };
    if (res.kind === 'blank') return { state: 'blank' };
    if (res.kind === 'multi')
      return d.primary ? { state: 'sample', study: String(d.primary), qb: res.qb } : { state: 'multi', studies: res.studies };
    return { state: 'sample', study: String(res.study_idx), qb: res.qb };
  }

  const cells = $derived(
    racks.map((rack, r) =>
      Object.fromEntries(rack.tubes.map((t) => [t.well, { tube: t.tube, cell: cellOf(r, t.well, t.tube) }]))
    )
  );
  const all = $derived(cells.flatMap((rc, r) => Object.entries(rc).map(([well, v]) => ({ r, well, ...v }))));
  const unknown = $derived(all.filter((x) => x.cell.state === 'unknown'));
  const multi = $derived(all.filter((x) => x.cell.state === 'multi'));
  const dupes = $derived(all.filter((x) => x.cell.state === 'duplicate'));
  const blanks = $derived(all.filter((x) => x.cell.state === 'blank'));
  const needFix = $derived(unknown.length + multi.length + dupes.length);
  const blanksOn = (r: number) => blanks.filter((x) => x.r === r).length;
  /** The study a rack's samples belong to (its blanks follow it). */
  const studyOfRack = (r: number) =>
    all.find((x) => x.r === r && x.cell.state === 'sample')?.cell as { study: string } | undefined;
  const studyKeys = $derived(
    [...new Set(all.flatMap((x) => (x.cell.state === 'sample' ? [x.cell.study] : [])))]
  );
  const countFor = (key: string) => all.filter((x) => x.cell.state === 'sample' && x.cell.study === key).length;
  const unknownRacks = $derived(
    racks.map((rack, r) => ({ rack, r, n: unknown.filter((x) => x.r === r).length })).filter((x) => x.n >= 24)
  );
  const looseUnknown = $derived(unknown.filter((x) => !unknownRacks.some((u) => u.r === x.r)));

  const PALETTE = ['#0d9488', '#b45309', '#7c3aed', '#2563eb'];
  const colorOf = (key: string) => PALETTE[Math.max(0, studyKeys.indexOf(key)) % PALETTE.length];
  const titleOf = (key: string) =>
    key === OTHER
      ? `${studyFacts[OTHER]?.project_name || 'Sheet-only study'} (not in Qiita-miint)`
      : (STUDIES.find((s) => String(s.study_idx) === key)?.title ?? `#${key}`);

  // --- 4. plates: four quadrants ---
  let rackAt = $state<(number | null)[]>([null, null, null, null]); // position 1..4 → rack index
  let primerAt = $state(['1', '2', '3', '4']);
  // A removed rack frees its position; a new rack takes its demo position, else the first free one.
  $effect(() => {
    const rs = racks;
    untrack(() => {
      const fixed = rackAt.map((r) => (r !== null && r < rs.length ? r : null));
      rs.forEach((rack, r) => {
        if (fixed.includes(r)) return;
        const want = demo?.plates[rack.rackId];
        const at = want && fixed[Number(want.position) - 1] === null ? Number(want.position) - 1 : fixed.indexOf(null);
        if (at < 0) return;
        fixed[at] = r;
        if (want) primerAt[at] = want.facts.primer_plate;
      });
      if (fixed.some((r, i) => r !== rackAt[i])) rackAt = fixed;
    });
  });
  function wellsOf(r: number | null): Record<string, Well> {
    if (r === null) return {};
    const out: Record<string, Well> = {};
    for (const [well, { tube, cell }] of Object.entries(cells[r] ?? {})) {
      if (cell.state === 'sample') out[well] = { fill: colorOf(cell.study), title: `${tube}${cell.qb ? ` · ${cell.qb}` : ''}` };
      else if (cell.state === 'blank') out[well] = { fill: '#9ca3af', title: `blank · ${tube}`, mark: 'B' };
      else if (cell.state === 'excluded') out[well] = { fill: '#e5e7eb', title: `left out · ${tube}`, mark: '×' };
      else out[well] = { fill: '#fecaca', ring: 'ring-red-500', title: `unresolved · ${tube}`, mark: '!' };
    }
    return out;
  }
  const toggleBlank = (r: number, well: string) => {
    if (cells[r]?.[well]) decide(r, well, { blank: !(decisions[keyOf(r, well)]?.blank ?? false) });
  };
  const placed = $derived(rackAt.flatMap((r, i) => (r === null ? [] : [{ r, position: String(i + 1) }])));
  const layoutProblems = $derived.by(() => {
    const p: string[] = [];
    if (new Set(placed.map((x) => x.r)).size !== placed.length) p.push('A rack is in two positions');
    if (new Set(placed.map((x) => x.r)).size !== racks.length) p.push('Every rack needs a position');
    const pp = placed.map((x) => primerAt[Number(x.position) - 1]);
    if (new Set(pp).size !== pp.length) p.push('A primer plate is used twice');
    return p;
  });

  // --- 5. details: per plate, per study, per run ---
  const EMPTY_PLATE = Object.fromEntries(PLATE_COLUMNS.map(([k]) => [k, ''])) as Plate;
  let plateFacts = $state<Record<string, Plate>>({});
  let studyFacts = $state<Record<string, StudyFacts>>({});
  let run = $state<RunFacts>({ run_date: '', instrument_model: '', platemap_generation_date: '' });
  // Seed what the tech would type from the demo's defaults; keep what they've typed.
  $effect(() => {
    const d = demo;
    const rs = racks;
    untrack(() => {
      for (const rack of rs)
        plateFacts[rack.rackId] ??= { ...(d?.plates[rack.rackId]?.facts ?? EMPTY_PLATE) };
      for (const [k, v] of Object.entries(d?.studyFacts ?? {})) studyFacts[k] ??= { ...v };
      if (d && !run.run_date) run = { ...d.run };
    });
  });
  const factsAt = (position: string, r: number): Plate => ({
    ...(plateFacts[racks[r].rackId] ?? EMPTY_PLATE),
    primer_plate: primerAt[Number(position) - 1]
  });
  const messages = $derived(validatePlates(placed.map(({ r, position }) => ({ position, facts: factsAt(position, r) }))));
  const errors = $derived([...new Set(messages.filter((m) => m.level === 'error').map((m) => m.text))]);
  const warnings = $derived([...new Set(messages.filter((m) => m.level === 'warning').map((m) => m.text))]);
  const studyErrors = $derived(
    studyKeys.flatMap((k) =>
      STUDY_COLUMNS.filter(([c]) => !(studyFacts[k]?.[c] ?? '').trim()).map(([, label]) => `${titleOf(k)}: ${label} is empty`)
    )
  );
  const fillRight = (col: (typeof PLATE_COLUMNS)[number][0]) => {
    const first = placed[0];
    if (!first) return;
    const v = plateFacts[racks[first.r].rackId][col];
    for (const { r } of placed) plateFacts[racks[r].rackId][col] = v;
  };

  // --- 6. pre-flight: one sample sheet per study, which kl-run-preflight builds the blob from ---
  const sheetWells = $derived(
    placed.flatMap(({ r, position }) => {
      const plate = factsAt(position, r);
      const rackStudy = studyOfRack(r)?.study;
      return Object.entries(cells[r] ?? {}).flatMap(([well96, v]) => {
        const blank = v.cell.state === 'blank';
        if (!blank && v.cell.state !== 'sample') return [];
        const study = blank ? rackStudy : (v.cell as { study: string }).study;
        if (!study) return [];
        return [
          {
            study,
            position,
            tube: v.tube,
            name: sampleName(v.tube, blank, studyFacts[study]?.project_abbreviation ?? '', plate.sample_plate, well96),
            control: blank ? 'negative_control' : '',
            well96,
            well384: to384(position, well96),
            barcode: demo?.barcodes.get(`${plate.primer_plate}:${well96}`) ?? mockGolay(plate.primer_plate, well96),
            plate
          }
        ];
      });
    })
  );
  const clashes = $derived(sheetWells.length - new Set(sheetWells.map((w) => w.barcode)).size);
  const sheets = $derived(
    studyKeys.map((key) => {
      const wells = sheetWells.filter((w) => w.study === key);
      const f = studyFacts[key];
      const plateNos = [...new Set(wells.map((w) => w.plate.sample_plate.replace(/^\D*/, '')))].join('-');
      return {
        key,
        wells,
        fileName: `${run.run_date.replaceAll('-', '') || 'YYYYMMDD'}_IL515fBC_806_${f?.project_name ?? key}_Plates_${plateNos}.txt`,
        text: f ? buildSheet(wells, f, run) : ''
      };
    })
  );
  let built = $state(false);
  const preflightName = $derived(
    `${run.run_date.replaceAll('-', '') || 'YYYYMMDD'}_IL515fBC_806_${studyKeys.map((k) => studyFacts[k]?.project_abbreviation ?? k).join('_')}.preflight.db`
  );

  // --- 7. sequence ---
  let runFolder = $state<string | null>(null);
  let started = $state(false);

  const canLeave = $derived([
    !!protocol && !!target,
    racks.length > 0 && !checking,
    needFix === 0,
    layoutProblems.length === 0,
    errors.length === 0 && studyErrors.length === 0,
    built,
    true
  ]);
  // With nothing to fix, Scan goes straight to Plates.
  const nextStep = $derived(step === 1 && needFix === 0 ? 3 : step + 1);

  const btn = 'rounded-md bg-white px-2.5 py-1 text-xs font-semibold text-gray-900 shadow-xs ring-1 ring-gray-300 ring-inset hover:bg-gray-50';
  const input = 'block w-full rounded-md bg-white px-2 py-1 text-sm text-gray-900 outline-1 -outline-offset-1 focus:outline-2 focus:-outline-offset-2 focus:outline-teal-600';
</script>

<div class="mb-6">
  <div class="flex items-center justify-between gap-3">
    <h1 class="text-2xl/7 font-bold text-gray-900">Library prep</h1>
    <span class="inline-flex rounded-md bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800 ring-1 ring-amber-600/20 ring-inset">Mockup</span>
  </div>
  <p class="mt-1 text-sm text-gray-500">From a box of tubes to a running amplicon workflow.</p>
</div>

<!-- Steps (Tailwind UI: navigation / progress bars / panels) -->
<nav aria-label="Progress" class="mb-6">
  <ol role="list" class="divide-y divide-gray-300 rounded-md border border-gray-300 bg-white md:flex md:divide-y-0">
    {#each STEPS as label, i}
      <li class="relative md:flex md:flex-1">
        <button
          type="button"
          disabled={i > reached}
          aria-current={i === step ? 'step' : undefined}
          class="group flex w-full items-center px-4 py-3 text-sm font-medium disabled:cursor-not-allowed"
          onclick={() => go(i)}
        >
          {#if i < step}
            <span class="flex size-8 shrink-0 items-center justify-center rounded-full bg-teal-600 group-hover:bg-teal-800">
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" class="size-5 text-white"><path d="M19.916 4.626a.75.75 0 0 1 .208 1.04l-9 13.5a.75.75 0 0 1-1.154.114l-6-6a.75.75 0 0 1 1.06-1.06l5.353 5.353 8.493-12.74a.75.75 0 0 1 1.04-.207Z" clip-rule="evenodd" fill-rule="evenodd" /></svg>
            </span>
            <span class="ml-3 whitespace-nowrap text-gray-900">{label}</span>
          {:else if i === step}
            <span class="flex size-8 shrink-0 items-center justify-center rounded-full border-2 border-teal-600 text-teal-600">{i + 1}</span>
            <span class="ml-3 whitespace-nowrap text-teal-700">{label}</span>
          {:else}
            <span class="flex size-8 shrink-0 items-center justify-center rounded-full border-2 border-gray-300 text-gray-500">{i + 1}</span>
            <span class="ml-3 whitespace-nowrap text-gray-500">{label}</span>
          {/if}
        </button>
        {#if i < STEPS.length - 1}
          <div aria-hidden="true" class="absolute top-0 right-0 hidden h-full w-4 md:block">
            <svg viewBox="0 0 22 80" fill="none" preserveAspectRatio="none" class="size-full text-gray-300"><path d="M0 -2L20 40L0 82" stroke="currentcolor" vector-effect="non-scaling-stroke" stroke-linejoin="round" /></svg>
          </div>
        {/if}
      </li>
    {/each}
  </ol>
</nav>

<div class="rounded-lg bg-white px-4 py-5 shadow-sm ring-1 ring-gray-900/5 sm:p-6">
  {#if step === 0}
    <!-- Tailwind UI: forms / select menus / simple native, side by side -->
    <div class="grid max-w-3xl grid-cols-1 gap-4 sm:grid-cols-2">
      <div>
        <label for="protocol" class="block text-sm/6 font-semibold text-gray-900">Prep protocol</label>
        <div class="mt-2 grid grid-cols-1">
          <select id="protocol" bind:value={protocol} class="col-start-1 row-start-1 w-full appearance-none rounded-md bg-white py-1.5 pr-8 pl-3 text-base text-gray-900 outline-1 -outline-offset-1 outline-gray-300 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-teal-600 sm:text-sm/6">
            <option value={null} disabled>Choose a prep protocol…</option>
            {#each protocols as p (p)}
              <option value={p} disabled={p !== SUPPORTED_PROTOCOL}>
                {pretty(p)}{p !== SUPPORTED_PROTOCOL ? ' — not in this flow yet' : ''}
              </option>
            {/each}
          </select>
          <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" class="pointer-events-none col-start-1 row-start-1 mr-2 size-5 self-center justify-self-end text-gray-500 sm:size-4"><path d="M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z" clip-rule="evenodd" fill-rule="evenodd" /></svg>
        </div>
      </div>
      {#if protocol}
        <div>
          <label for="primers" class="block text-sm/6 font-semibold text-gray-900">Primers</label>
          <div class="mt-2 grid grid-cols-1">
            <select id="primers" bind:value={target} class="col-start-1 row-start-1 w-full appearance-none rounded-md bg-white py-1.5 pr-8 pl-3 text-base text-gray-900 outline-1 -outline-offset-1 outline-gray-300 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-teal-600 sm:text-sm/6">
              <option value={null} disabled>Choose primers…</option>
              {#each TARGETS as t (t.id)}
                <option value={t.id} disabled={!t.enabled}>{t.label}{t.enabled ? '' : ' — not yet'}</option>
              {/each}
            </select>
            <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" class="pointer-events-none col-start-1 row-start-1 mr-2 size-5 self-center justify-self-end text-gray-500 sm:size-4"><path d="M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z" clip-rule="evenodd" fill-rule="evenodd" /></svg>
          </div>
        </div>
      {/if}
    </div>
  {:else if step === 1}
    <h2 class="text-sm/6 font-semibold text-gray-900">Scan the box</h2>
    <p class="mt-1 text-sm text-gray-500">Drop the VisionMate scan of each rack (up to four). Every tube code is checked against Qiita-miint as they land.</p>
    <!-- Tailwind UI: feedback / empty states / with dashed border -->
    <div
      role="region"
      aria-label="Drop rack scans"
      class="mt-4 rounded-lg border-2 border-dashed p-8 text-center transition {dragging ? 'border-teal-500 bg-teal-50' : 'border-gray-300'}"
      ondragover={(e) => (e.preventDefault(), (dragging = true))}
      ondragleave={() => (dragging = false)}
      ondrop={(e) => (e.preventDefault(), (dragging = false), addFiles(e.dataTransfer?.files ?? null))}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true" class="mx-auto size-10 text-gray-400"><path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" /></svg>
      <p class="mt-2 text-sm font-semibold text-gray-900">
        {racks.length ? `${racks.length} of 4 racks — drop more, or continue` : 'Drop rack scans here'}
      </p>
      <p class="mt-1 text-xs text-gray-500">
        <label class="cursor-pointer font-medium text-teal-700 hover:text-teal-600">choose files<input type="file" multiple accept=".tsv,.txt" class="hidden" onchange={(e) => addFiles(e.currentTarget.files)} /></label>
        · <button type="button" class="font-medium text-teal-700 hover:text-teal-600" onclick={loadDemo}>use the demo box</button>
        · <button type="button" class="font-medium text-teal-700 hover:text-teal-600" onclick={downloadDemoRacks}>download its scans</button>
      </p>
    </div>

    {#if racks.length}
      <ul role="list" class="mt-4 divide-y divide-gray-100 rounded-md border border-gray-200 text-sm">
        {#each racks as rack, r}
          <li class="flex items-center justify-between gap-3 px-4 py-2">
            <span><span class="font-medium text-gray-900">{rack.rackId}</span> <span class="text-gray-500">· {rack.tubes.length} tubes</span></span>
            {#each rack.problems as p}<span class="text-xs text-red-700">{p}</span>{/each}
            <button type="button" class="text-xs text-gray-400 hover:text-red-600" onclick={() => (racks = racks.filter((_, i) => i !== r))}>Remove</button>
          </li>
        {/each}
      </ul>
      <div class="mt-4">
        {#if checking}
          <p class="text-sm text-gray-500">Checking {all.length} tube codes…</p>
        {:else if needFix === 0}
          <!-- Tailwind UI: feedback / alerts / with description -->
          <div class="rounded-md bg-green-50 p-4">
            <h3 class="text-sm font-medium text-green-800">All {all.length} tubes are placed</h3>
            <p class="mt-2 text-sm text-green-700">{[...studyKeys.map((k) => `${countFor(k)} from ${titleOf(k)}`), `${blanks.length} blanks`].join(' · ')}</p>
          </div>
        {:else}
          <div class="rounded-md bg-yellow-50 p-4">
            <h3 class="text-sm font-medium text-yellow-800">{needFix} of {all.length} tubes need attention before plating</h3>
            <ul class="mt-2 list-disc space-y-1 pl-5 text-sm text-yellow-700">
              {#if unknown.length}<li>{unknown.length} aren't in Qiita-miint</li>{/if}
              {#if multi.length}<li>{multi.length} belong to more than one study</li>{/if}
              {#if dupes.length}<li>{dupes.length} appear on two racks</li>{/if}
            </ul>
            {#if studyKeys.length}
              <p class="mt-2 text-sm text-yellow-700">The rest: {[...studyKeys.map((k) => `${countFor(k)} from ${titleOf(k)}`), `${blanks.length} blanks`].join(' · ')}</p>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
  {:else if step === 2}
    {#if needFix === 0}
      <div class="rounded-md bg-green-50 p-4">
        <h3 class="text-sm font-medium text-green-800">Nothing to fix</h3>
        <p class="mt-2 text-sm text-green-700">Every tube is a sample of one study, or a blank.</p>
      </div>
    {:else}
      <h2 class="text-sm/6 font-semibold text-gray-900">Settle what Qiita-miint can't place</h2>
      <div class="mt-4 space-y-6">
        {#each unknownRacks as u (u.rack.rackId)}
          <!-- Tailwind UI: feedback / alerts / with actions -->
          <div class="rounded-md bg-red-50 p-4">
            <h3 class="text-sm font-medium text-red-800">{u.n} tubes on {u.rack.rackId} aren't in Qiita-miint</h3>
            <p class="mt-2 text-sm text-red-700">
              A whole rack like this is another study on the run: one not in Qiita-miint, or whose samples lack tube
              codes there. Add the study (or its tube codes) and check again, or carry the rack for its sample sheet
              only.
            </p>
            <div class="mt-4 -mx-2 -my-1.5 flex flex-wrap gap-1">
              <button type="button" class="rounded-md bg-red-50 px-2 py-1.5 text-sm font-medium text-red-800 hover:bg-red-100" onclick={() => download(`${u.rack.rackId}-tube-codes.txt`, unknown.filter((x) => x.r === u.r).map((x) => `${x.well}\t${x.tube}`).join('\n'))}>Download the tube codes</button>
              <a href="/studies" class="rounded-md bg-red-50 px-2 py-1.5 text-sm font-medium text-red-800 hover:bg-red-100">Open studies →</a>
              <button type="button" class="rounded-md bg-red-50 px-2 py-1.5 text-sm font-medium text-red-800 hover:bg-red-100" onclick={() => { sheetOnly = { ...sheetOnly, [u.rack.rackId]: true }; studyFacts[OTHER] ??= { ...(demo?.otherStudy ?? { project_name: '', project_abbreviation: '', center_project_name: '', experiment_design_description: '' }) }; }}>Sample sheet only</button>
            </div>
          </div>
        {/each}

        {#if looseUnknown.length}
          <section>
            <h3 class="text-sm font-medium text-gray-900">{looseUnknown.length} stray tubes not in Qiita-miint</h3>
            <p class="mt-1 text-sm text-gray-500">A mislabelled tube, a sample not yet registered, or a blank.</p>
            <ul role="list" class="mt-2 divide-y divide-gray-100 rounded-md border border-gray-200 text-sm">
              {#each looseUnknown as x (x.r + x.well)}
                <li class="flex flex-wrap items-center gap-3 px-4 py-2">
                  <span class="font-mono text-xs text-gray-700">{racks[x.r].rackId} {x.well}</span>
                  <span class="font-mono text-xs text-gray-500">{x.tube}</span>
                  <span class="ml-auto flex gap-2">
                    <button type="button" class={btn} onclick={() => decide(x.r, x.well, { blank: true })}>Blank</button>
                    <button type="button" class={btn} onclick={() => decide(x.r, x.well, { exclude: true })}>Leave out</button>
                  </span>
                </li>
              {/each}
            </ul>
          </section>
        {/if}

        {#if multi.length}
          <section>
            <h3 class="text-sm font-medium text-gray-900">{multi.length} in more than one study</h3>
            <p class="mt-1 text-sm text-gray-500">Which study is this prep for?</p>
            <ul role="list" class="mt-2 divide-y divide-gray-100 rounded-md border border-gray-200 text-sm">
              {#each multi as x (x.r + x.well)}
                {@const c = x.cell as { studies: number[] }}
                <li class="flex flex-wrap items-center gap-3 px-4 py-2">
                  <span class="font-mono text-xs text-gray-700">{racks[x.r].rackId} {x.well}</span>
                  <span class="ml-auto flex gap-2">
                    {#each c.studies as sid}<button type="button" class={btn} onclick={() => decide(x.r, x.well, { primary: sid })}>{titleOf(String(sid))}</button>{/each}
                  </span>
                </li>
              {/each}
            </ul>
          </section>
        {/if}

        {#if dupes.length}
          <section>
            <h3 class="text-sm font-medium text-gray-900">Tubes on two racks</h3>
            <p class="mt-1 text-sm text-gray-500">A tube can only be in one well. Keep one, leave the other out.</p>
            <ul role="list" class="mt-2 divide-y divide-gray-100 rounded-md border border-gray-200 text-sm">
              {#each dupes as x (x.r + x.well)}
                <li class="flex flex-wrap items-center gap-3 px-4 py-2">
                  <span class="font-mono text-xs text-gray-700">{racks[x.r].rackId} {x.well}</span>
                  <span class="font-mono text-xs text-gray-500">{x.tube}</span>
                  <span class="ml-auto"><button type="button" class={btn} onclick={() => decide(x.r, x.well, { exclude: true })}>Leave this one out</button></span>
                </li>
              {/each}
            </ul>
          </section>
        {/if}
      </div>
    {/if}
  {:else if step === 3}
    <h2 class="text-sm/6 font-semibold text-gray-900">Lay out the plates</h2>
    <p class="mt-1 text-sm text-gray-500">The four positions of the 384-well plate. Click a well to mark or unmark it as a blank.</p>
    <div class="mt-4 grid grid-cols-1 gap-6 xl:grid-cols-2">
      {#each [0, 1, 2, 3] as i}
        <div class="rounded-lg border border-gray-200 p-3">
          <div class="mb-2 flex flex-wrap items-center gap-3 text-sm">
            <span class="font-semibold text-gray-900">Position {i + 1}</span>
            <select aria-label="Rack at position {i + 1}" class="rounded-md border-0 py-1 pr-8 pl-2 text-sm ring-1 ring-gray-300 ring-inset" bind:value={rackAt[i]}>
              <option value={null}>— empty —</option>
              {#each racks as rack, r}<option value={r}>{rack.rackId}</option>{/each}
            </select>
            <label class="ml-auto flex items-center gap-2 text-xs text-gray-600">Primer plate
              <select class="rounded-md border-0 py-1 pr-8 pl-2 text-sm ring-1 ring-gray-300 ring-inset" bind:value={primerAt[i]}>
                {#each Array.from({ length: 10 }, (_, k) => String(k + 1)) as n}<option>{n}</option>{/each}
              </select>
            </label>
          </div>
          <PlateMap wells={wellsOf(rackAt[i])} onpick={(w) => rackAt[i] !== null && toggleBlank(rackAt[i]!, w)} />
          {#if rackAt[i] !== null}
            {@const s = studyOfRack(rackAt[i]!)}
            <p class="mt-1 text-xs {blanksOn(rackAt[i]!) ? 'text-gray-500' : 'text-amber-700'}">
              {s ? titleOf(s.study) : 'no samples'} · {blanksOn(rackAt[i]!) ? `${blanksOn(rackAt[i]!)} blanks` : 'no blank on this plate — is that right?'}
            </p>
          {/if}
        </div>
      {/each}
    </div>
    {#if layoutProblems.length}<p class="mt-3 text-sm text-red-700">{layoutProblems.join(' · ')}</p>{/if}
  {:else if step === 4}
    <h2 class="text-sm/6 font-semibold text-gray-900">Processing details</h2>
    <p class="mt-1 text-sm text-gray-500">Recorded with every sample. Write not_applicable for anything that doesn't apply.</p>
    <div class="mt-4 overflow-x-auto">
      <table class="min-w-full text-sm">
        <thead>
          <tr class="text-left text-xs text-gray-500">
            <th class="py-2 pr-3 font-medium"></th>
            {#each placed as { r, position }}<th class="px-2 py-2 font-medium">Position {position} · {racks[r].rackId}</th>{/each}
            <th></th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-100">
          {#each PLATE_COLUMNS.filter(([k]) => k !== 'primer_plate') as [col, label]}
            <tr>
              <th scope="row" class="py-1.5 pr-3 text-left text-xs font-medium whitespace-nowrap text-gray-700">{label}</th>
              {#each placed as { r }}
                {@const id = racks[r].rackId}
                <td class="px-2 py-1.5">
                  {#if plateFacts[id]}
                    <input aria-label="{label} for {id}" class="{input} {plateFacts[id][col].trim() ? 'outline-gray-300' : 'outline-red-300'}" bind:value={plateFacts[id][col]} />
                  {/if}
                </td>
              {/each}
              <td class="pl-1"><button type="button" class="text-xs text-teal-700 hover:underline" title="Use the first plate's value on every plate" onclick={() => fillRight(col)}>same for all</button></td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    <h3 class="mt-8 text-sm font-semibold text-gray-900">Studies</h3>
    <div class="mt-2 grid grid-cols-1 gap-4 lg:grid-cols-2">
      {#each studyKeys as k}
        <div class="rounded-lg border border-gray-200 p-3">
          <p class="mb-2 text-sm font-medium text-gray-900"><span class="mr-2 inline-block size-3 rounded-full align-middle" style="background:{colorOf(k)}"></span>{titleOf(k)}</p>
          {#if studyFacts[k]}
            <div class="grid grid-cols-2 gap-2">
              {#each STUDY_COLUMNS as [col, label]}
                <label class="text-xs text-gray-600 {col === 'experiment_design_description' ? 'col-span-2' : ''}">{label}
                  <input class="{input} mt-0.5 {studyFacts[k][col].trim() ? 'outline-gray-300' : 'outline-red-300'}" bind:value={studyFacts[k][col]} />
                </label>
              {/each}
            </div>
          {/if}
        </div>
      {/each}
    </div>

    <h3 class="mt-8 text-sm font-semibold text-gray-900">Run</h3>
    <div class="mt-2 grid max-w-2xl grid-cols-3 gap-3">
      <label class="text-xs text-gray-600">Run date<input class="{input} mt-0.5 outline-gray-300" bind:value={run.run_date} /></label>
      <label class="text-xs text-gray-600">Instrument<input class="{input} mt-0.5 outline-gray-300" bind:value={run.instrument_model} /></label>
      <label class="text-xs text-gray-600">Plate map date<input class="{input} mt-0.5 outline-gray-300" bind:value={run.platemap_generation_date} /></label>
    </div>

    {#if errors.length || studyErrors.length || warnings.length}
      <ul class="mt-4 space-y-1 text-sm">
        {#each [...errors, ...studyErrors] as t}<li class="text-red-700">{t}</li>{/each}
        {#each warnings as t}<li class="text-amber-700">{t}</li>{/each}
      </ul>
    {/if}
  {:else if step === 5}
    <h2 class="text-sm/6 font-semibold text-gray-900">Build the pre-flight</h2>
    <p class="mt-1 text-sm text-gray-500">
      One sample sheet per study, from which kl-run-preflight builds the run's pre-flight: the SQLite file the
      sequencing step submits with.
    </p>
    <ul role="list" class="mt-4 divide-y divide-gray-100 rounded-md border border-gray-200 text-sm">
      {#each sheets as s (s.key)}
        <li class="px-4 py-3">
          <div class="flex flex-wrap items-center gap-3">
            <span class="size-3 rounded-full" style="background:{colorOf(s.key)}"></span>
            <span class="font-medium text-gray-900">{titleOf(s.key)}</span>
            <span class="text-gray-500">{s.wells.length} wells ({s.wells.filter((w) => w.control).length} blanks)</span>
            <span class="ml-auto font-mono text-xs text-gray-500">{s.fileName}</span>
          </div>
          <details class="mt-2">
            <summary class="cursor-pointer text-xs text-teal-700">Show the sheet</summary>
            <pre data-sheet={s.key} class="mt-2 max-h-64 overflow-auto rounded bg-gray-50 p-2 text-[11px] leading-4">{s.text}</pre>
          </details>
        </li>
      {/each}
    </ul>
    <p class="mt-4 text-sm {clashes ? 'text-red-700' : 'text-gray-600'}">
      {clashes ? `${clashes} wells share a Golay barcode` : `${sheetWells.length} wells, each with its own Golay barcode.`}
    </p>
    <div class="mt-4 flex flex-wrap items-center gap-3">
      <button type="button" class="rounded-md bg-teal-600 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-teal-500 disabled:opacity-50" disabled={built || clashes > 0} onclick={() => (built = true)}>
        {built ? 'Pre-flight built' : 'Build pre-flight'}
      </button>
      {#if built}
        <button type="button" class="rounded-md bg-white px-3 py-2 text-sm font-semibold text-gray-900 shadow-xs ring-1 ring-gray-300 ring-inset hover:bg-gray-50 disabled:opacity-50" disabled title="Built by kl-run-preflight on the server in the real flow">Download {preflightName}</button>
      {/if}
    </div>
  {:else if step === 6}
    <h2 class="text-sm/6 font-semibold text-gray-900">Sequence</h2>
    <p class="mt-1 text-sm text-gray-500">When the run has finished, pick its folder.</p>
    <fieldset class="mt-4 space-y-2">
      {#each RUN_FOLDERS as f}
        <label class="flex items-center gap-3 rounded-md border border-gray-200 px-4 py-2 text-sm has-checked:border-teal-600 has-checked:bg-teal-50">
          <input type="radio" name="run" value={f.id} bind:group={runFolder} class="size-4 accent-teal-600" />
          <span class="font-mono text-xs text-gray-900">{f.id}</span>
          <span class="ml-auto text-xs text-gray-500">{f.instrument} · {f.cycles} · {f.when}</span>
        </label>
      {/each}
    </fieldset>
    {#if runFolder}
      <div class="mt-6">
        {#if !started}
          <button type="button" class="rounded-md bg-teal-600 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-teal-500" onclick={() => (started = true)}>Start demux → amplicon</button>
        {:else}
          <ol class="space-y-2 text-sm">
            <li class="flex items-center gap-2"><span class="size-2 rounded-full bg-blue-500"></span>golay-demux — queued with {preflightName}: {sheetWells.filter((w) => w.study !== OTHER).length} Qiita-miint wells</li>
            <li class="flex items-center gap-2"><span class="size-2 rounded-full bg-gray-300"></span>amplicon — starts when demux completes (trim 150, deblur → ASVs → feature table)</li>
          </ol>
        {/if}
      </div>
    {/if}
  {/if}

  <div class="mt-8 flex items-center justify-between border-t border-gray-100 pt-4">
    <button type="button" class="rounded-md bg-white px-3 py-2 text-sm font-semibold text-gray-900 shadow-xs ring-1 ring-gray-300 ring-inset hover:bg-gray-50 disabled:invisible" disabled={step === 0} onclick={() => go(step - 1)}>Back</button>
    {#if step < STEPS.length - 1}
      <button type="button" class="rounded-md bg-teal-600 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-teal-500 disabled:opacity-40" disabled={!canLeave[step]} onclick={() => go(nextStep)}>Next: {STEPS[nextStep]}</button>
    {/if}
  </div>
</div>
