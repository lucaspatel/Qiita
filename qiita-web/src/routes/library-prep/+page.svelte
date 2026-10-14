<script lang="ts">
  // MOCKUP of the Library prep flow: from "a box of tubes was dropped off" to "the
  // amplicon workflow is running", replacing kl-metapool's
  // amplicon_pre_prep_file_generator notebook. The tube codes drive it: scanning the
  // racks is enough to know which samples and studies are in the box, and anything
  // Qiita can't place is fixed before the plates are laid out. One task per screen;
  // each screen shows only what that task needs. Local, mocked data
  // (lib/libraryPrep/mock.ts); each step notes what runs where.
  import { untrack } from 'svelte';
  import { api, type PrepProtocol } from '$lib/api';
  import PlateMap, { type Well } from '$lib/ui/PlateMap.svelte';
  import {
    DETAIL_FIELDS,
    RUN_FOLDERS,
    SOIL_STUDY,
    STUDIES,
    WELLS_96,
    demoBox,
    mockGolay,
    parseVisionMate,
    toVisionMate,
    validateDetails,
    type PlateDetails,
    type Rack,
    type Resolution
  } from '$lib/libraryPrep/mock';

  const STEPS = ['Protocol', 'Scan', 'Fix', 'Plates', 'Details', 'Register', 'Sequence'];
  const WHERE: { client: string; server: string }[] = [
    { client: 'Show the choices.', server: 'GET /prep-protocol; which protocols this flow supports.' },
    {
      client: 'Read the VisionMate files and normalise tube codes.',
      server: 'POST /biosample/resolve-roster with every tube: sample, QB and study for each, every problem at once.'
    },
    {
      client: 'Group the problems and offer the fixes.',
      server: 'Re-check after metadata is added; keep the decisions (blanks, exclusions, chosen study) on the prep draft.'
    },
    {
      client: 'Draw the quadrants, take clicks on wells.',
      server: 'The EMP primer plates and the compression rule, so barcodes have one implementation (golay-demux checks them later).'
    },
    { client: 'Validate as you type, for feedback.', server: 'The same checks on save; they gate the pre-flight.' },
    {
      client: 'Show what will be written; offer the legacy pre-prep file.',
      server: 'Register blanks as samples, write the pre-flight, link each sample to its study.'
    },
    {
      client: 'Pick the run; show progress.',
      server: 'Inspect the run folder, create run + pool from the stored pre-flight, submit golay-demux → amplicon.'
    }
  ];

  let step = $state(0);
  let reached = $state(0);
  const go = (i: number) => {
    step = i;
    reached = Math.max(reached, i);
  };

  // --- 1. protocol ---
  const SUPPORTED_PROTOCOL = 'short_read_amplicon';
  const FALLBACK_PROTOCOLS = [
    'short_read_amplicon',
    'short_read_metagenomics',
    'long_read_metagenomics',
    'short_read_transcriptomics'
  ];
  let protocols = $state<{ name: string }[]>(FALLBACK_PROTOCOLS.map((name) => ({ name })));
  $effect(() => {
    api.prepProtocols().then((r) => {
      if (r.ok && r.data.length)
        protocols = r.data
          .filter((p: PrepProtocol) => !p.retired)
          .map((p) => ({ name: p.name }))
          .sort((a, b) => Number(b.name === SUPPORTED_PROTOCOL) - Number(a.name === SUPPORTED_PROTOCOL));
    });
  });
  let protocol = $state<string | null>(null);
  const TARGETS = [
    { id: '16S', label: '16S rRNA (V4)', note: '515F / 806R, EMP Golay barcodes', enabled: true },
    { id: '18S', label: '18S rRNA', note: 'not yet', enabled: false },
    { id: 'ITS', label: 'ITS', note: 'not yet', enabled: false }
  ];
  let target = $state<string | null>(null);
  const pretty = (s: string) => s.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase());

  // --- 2. scan ---
  let racks = $state<Rack[]>([]);
  let registry = $state.raw(new Map<string, Resolution>());
  let checking = $state(false);
  let dragging = $state(false);
  let soilMetadataAdded = $state(false);

  function check() {
    checking = true;
    setTimeout(() => (checking = false), 700); // the mock's round trip
  }
  function loadDemo() {
    const box = demoBox();
    racks = box.racks;
    registry = box.registry;
    check();
  }
  async function addFiles(files: FileList | null) {
    if (!files?.length) return;
    if (registry.size === 0) registry = demoBox().registry; // the mock's Qiita
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

  // --- resolution (what the server answers for every tube) ---
  type Decision = { primary?: number; exclude?: boolean; blank?: boolean };
  let decisions = $state<Record<string, Decision>>({});
  const keyOf = (r: number, well: string) => `${r}:${well}`;
  const decide = (r: number, well: string, d: Decision) =>
    (decisions = { ...decisions, [keyOf(r, well)]: { ...(decisions[keyOf(r, well)] ?? {}), ...d } });

  type Cell =
    | { state: 'sample'; sample: string; qb: string; study: number }
    | { state: 'blank' }
    | { state: 'excluded' }
    | { state: 'unknown' }
    | { state: 'multi'; sample: string; studies: number[] }
    | { state: 'duplicate'; other: string };

  const placesOf = $derived.by(() => {
    // A well left out no longer holds its tube, so its twin stops being a duplicate.
    const n = new Map<string, string[]>();
    racks.forEach((r, ri) => {
      for (const t of r.tubes)
        if (!decisions[keyOf(ri, t.well)]?.exclude)
          n.set(t.tube, [...(n.get(t.tube) ?? []), `${r.rackId} ${t.well}`]);
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
    const res = registry.get(tube);
    if (!res) {
      // The mock's stand-in for the soil study's metadata gaining its tube codes.
      if (racks[r].rackId === 'SC0004' && soilMetadataAdded)
        return { state: 'sample', sample: `13001.soil.${well}`, qb: `QB${9100 + WELLS_96.indexOf(well)}`, study: SOIL_STUDY };
      return { state: 'unknown' };
    }
    if (res.kind === 'blank') return { state: 'blank' };
    if (res.kind === 'unknown') return { state: 'unknown' };
    if (res.kind === 'multi')
      return d.primary
        ? { state: 'sample', sample: res.sample, qb: res.qb, study: d.primary }
        : { state: 'multi', sample: res.sample, studies: res.studies };
    return { state: 'sample', sample: res.sample, qb: res.qb, study: res.study_idx };
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
  const byStudy = $derived(
    STUDIES.map((s) => ({
      s,
      n: all.filter((x) => x.cell.state === 'sample' && x.cell.study === s.study_idx).length
    })).filter((x) => x.n)
  );
  const blanksOn = (r: number) => blanks.filter((x) => x.r === r).length;
  // Unknown tubes that sit together on one rack: most likely one study without tube codes.
  const unknownRacks = $derived(
    racks.map((rack, r) => ({ rack, n: unknown.filter((x) => x.r === r).length })).filter((x) => x.n >= 24)
  );
  const looseUnknown = $derived(
    unknown.filter((x) => !unknownRacks.some((u) => u.rack.rackId === racks[x.r].rackId))
  );

  const STUDY_COLOR: Record<number, string> = { 15663: '#0d9488', 12986: '#7c3aed', 13001: '#b45309' };
  const studyName = (id: number) => STUDIES.find((s) => s.study_idx === id)?.title ?? `#${id}`;

  // --- 4. plates: four quadrants ---
  let rackAt = $state<(number | null)[]>([null, null, null, null]); // position 1..4 → rack index
  let primerAt = $state(['1', '2', '3', '4']);
  // A removed rack leaves its position empty; a new rack takes the first empty one.
  $effect(() => {
    const n = racks.length;
    untrack(() => {
      const fixed = rackAt.map((r) => (r !== null && r < n ? r : null));
      for (let r = 0; r < n; r++)
        if (!fixed.includes(r)) {
          const free = fixed.indexOf(null);
          if (free >= 0) fixed[free] = r;
        }
      if (fixed.some((r, i) => r !== rackAt[i])) rackAt = fixed;
    });
  });
  function wellsOf(r: number | null): Record<string, Well> {
    if (r === null) return {};
    const out: Record<string, Well> = {};
    for (const [well, { tube, cell }] of Object.entries(cells[r] ?? {})) {
      if (cell.state === 'sample')
        out[well] = { fill: STUDY_COLOR[cell.study], title: `${cell.sample} · ${cell.qb} · ${tube}` };
      else if (cell.state === 'blank') out[well] = { fill: '#9ca3af', title: `blank · ${tube}`, mark: 'B' };
      else if (cell.state === 'excluded') out[well] = { fill: '#e5e7eb', title: `left out · ${tube}`, mark: '×' };
      else out[well] = { fill: '#fecaca', ring: 'ring-red-500', title: `unresolved · ${tube}`, mark: '!' };
    }
    return out;
  }
  const toggleBlank = (r: number, well: string) => {
    if (cells[r]?.[well]) decide(r, well, { blank: !(decisions[keyOf(r, well)]?.blank ?? false) });
  };
  const layoutProblems = $derived.by(() => {
    const p: string[] = [];
    const placed = rackAt.filter((r) => r !== null);
    if (new Set(placed).size !== placed.length) p.push('A rack is in two positions');
    if (new Set(placed).size !== racks.length) p.push('Every rack needs a position');
    const pp = rackAt.flatMap((r, i) => (r !== null ? [primerAt[i]] : []));
    if (new Set(pp).size !== pp.length) p.push('A primer plate is used twice');
    return p;
  });

  // --- 5. details: one shared form, plus each plate's name ---
  const SHARED = DETAIL_FIELDS.filter(([k]) => k !== 'samplePlate');
  let shared = $state(
    Object.fromEntries(SHARED.map(([k, , ex]) => [k, k === 'plating' ? '' : ex])) as Record<string, string>
  );
  let platesNamed = $state(['Plate_16', 'Plate_17', 'Plate_18', 'Plate_19']);
  const plateDetails = $derived(
    rackAt.flatMap((r, i) =>
      r === null
        ? []
        : [
            {
              ...(shared as unknown as PlateDetails),
              position: String(i + 1),
              primerPlate: primerAt[i],
              samplePlate: platesNamed[i],
              project: ''
            }
          ]
    )
  );
  const detailMessages = $derived(validateDetails(plateDetails).flat());
  const detailErrors = $derived([...new Set(detailMessages.filter((m) => m.level === 'error').map((m) => m.text))]);
  const detailWarnings = $derived([
    ...new Set(detailMessages.filter((m) => m.level === 'warning').map((m) => m.text))
  ]);

  // --- 6. register ---
  const placedWells = $derived(
    rackAt.flatMap((r, i) =>
      r === null
        ? []
        : Object.entries(cells[r] ?? {})
            .filter(([, v]) => v.cell.state === 'sample' || v.cell.state === 'blank')
            .map(([well, v]) => ({ i, r, well, ...v, barcode: mockGolay(primerAt[i], well) }))
    )
  );
  const clashes = $derived(placedWells.length - new Set(placedWells.map((w) => w.barcode)).size);
  let registered = $state<string | null>(null);
  function downloadPrePrep() {
    const head = ['sample_name', 'tube_id', 'qiita_study_id', 'sample_plate', 'well_id_96', 'plate_position', 'primer_plate', 'barcode'];
    const rows = placedWells.map((w) =>
      [
        w.cell.state === 'sample' ? w.cell.sample : `BLANK.${platesNamed[w.i]}.${w.well}`,
        w.tube,
        w.cell.state === 'sample' ? w.cell.study : '',
        platesNamed[w.i],
        w.well,
        w.i + 1,
        primerAt[w.i],
        w.barcode
      ].join('\t')
    );
    download('pre-prep.txt', [head.join('\t'), ...rows].join('\n'));
  }

  // --- 7. sequence ---
  let runFolder = $state<string | null>(null);
  let started = $state(false);

  const canLeave = $derived([
    !!protocol && !!target,
    racks.length > 0 && !checking,
    needFix === 0,
    layoutProblems.length === 0,
    detailErrors.length === 0,
    !!registered,
    true
  ]);
  // With nothing to fix, Scan goes straight to Plates.
  const nextStep = $derived(step === 1 && needFix === 0 ? 3 : step + 1);
</script>

<div class="mb-6">
  <h1 class="text-2xl/7 font-bold text-gray-900">Library prep</h1>
  <p class="mt-1 text-sm text-gray-500">From a box of tubes to a running amplicon workflow.</p>
  <p class="mt-2 inline-flex rounded-md bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800 ring-1 ring-amber-600/20 ring-inset">
    Mockup — local made-up data, nothing is sent to Qiita
  </p>
</div>

<!-- Steps (Tailwind UI: navigation / progress bars / panels) -->
<nav aria-label="Progress" class="mb-6">
  <ol role="list" class="divide-y divide-gray-300 rounded-md border border-gray-300 bg-white md:flex md:divide-y-0">
    {#each STEPS as label, i}
      {@const done = i < step}
      {@const current = i === step}
      <li class="relative md:flex md:flex-1">
        <button
          type="button"
          disabled={i > reached}
          aria-current={current ? 'step' : undefined}
          class="group flex w-full items-center px-4 py-3 text-sm font-medium disabled:cursor-not-allowed"
          onclick={() => go(i)}
        >
          {#if done}
            <span class="flex size-8 shrink-0 items-center justify-center rounded-full bg-teal-600 group-hover:bg-teal-800">
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" class="size-5 text-white"><path d="M19.916 4.626a.75.75 0 0 1 .208 1.04l-9 13.5a.75.75 0 0 1-1.154.114l-6-6a.75.75 0 0 1 1.06-1.06l5.353 5.353 8.493-12.74a.75.75 0 0 1 1.04-.207Z" clip-rule="evenodd" fill-rule="evenodd" /></svg>
            </span>
            <span class="ml-3 text-gray-900">{label}</span>
          {:else if current}
            <span class="flex size-8 shrink-0 items-center justify-center rounded-full border-2 border-teal-600 text-teal-600">{i + 1}</span>
            <span class="ml-3 text-teal-700">{label}</span>
          {:else}
            <span class="flex size-8 shrink-0 items-center justify-center rounded-full border-2 border-gray-300 text-gray-500">{i + 1}</span>
            <span class="ml-3 text-gray-500">{label}</span>
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
    <!-- Tailwind UI: forms / radio groups / cards -->
    <fieldset>
      <legend class="text-sm/6 font-semibold text-gray-900">What is being prepared?</legend>
      <div class="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {#each protocols as p (p.name)}
          {@const enabled = p.name === SUPPORTED_PROTOCOL}
          <label class="group relative flex rounded-lg border border-gray-300 bg-white p-4 has-checked:outline-2 has-checked:-outline-offset-2 has-checked:outline-teal-600 has-disabled:bg-gray-50 has-disabled:opacity-50">
            <input type="radio" name="protocol" value={p.name} disabled={!enabled} bind:group={protocol} class="absolute inset-0 appearance-none focus:outline-none" />
            <span class="flex-1">
              <span class="block text-sm font-medium text-gray-900">{pretty(p.name)}</span>
              <span class="mt-1 block text-xs text-gray-500">{enabled ? 'Rapid 16S, Golay-barcoded' : 'not in this flow yet'}</span>
            </span>
            <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" class="invisible size-5 text-teal-600 group-has-checked:visible"><path d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm3.857-9.809a.75.75 0 0 0-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 1 0-1.06 1.061l2.5 2.5a.75.75 0 0 0 1.137-.089l4-5.5Z" clip-rule="evenodd" fill-rule="evenodd" /></svg>
          </label>
        {/each}
      </div>
    </fieldset>
    {#if protocol}
      <fieldset class="mt-8">
        <legend class="text-sm/6 font-semibold text-gray-900">Target</legend>
        <div class="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          {#each TARGETS as t (t.id)}
            <label class="group relative flex rounded-lg border border-gray-300 bg-white p-4 has-checked:outline-2 has-checked:-outline-offset-2 has-checked:outline-teal-600 has-disabled:bg-gray-50 has-disabled:opacity-50">
              <input type="radio" name="target" value={t.id} disabled={!t.enabled} bind:group={target} class="absolute inset-0 appearance-none focus:outline-none" />
              <span class="flex-1">
                <span class="block text-sm font-medium text-gray-900">{t.label}</span>
                <span class="mt-1 block text-xs text-gray-500">{t.note}</span>
              </span>
              <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" class="invisible size-5 text-teal-600 group-has-checked:visible"><path d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm3.857-9.809a.75.75 0 0 0-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 1 0-1.06 1.061l2.5 2.5a.75.75 0 0 0 1.137-.089l4-5.5Z" clip-rule="evenodd" fill-rule="evenodd" /></svg>
            </label>
          {/each}
        </div>
      </fieldset>
    {/if}
  {:else if step === 1}
    <h2 class="text-sm/6 font-semibold text-gray-900">Scan the box</h2>
    <p class="mt-1 text-sm text-gray-500">Drop the VisionMate scan of each rack (up to four). Qiita checks every tube code as they land.</p>
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
        · <button type="button" class="font-medium text-teal-700 hover:text-teal-600" onclick={downloadDemoRacks}>download demo scans</button>
      </p>
    </div>

    {#if racks.length}
      <ul role="list" class="mt-4 divide-y divide-gray-100 rounded-md border border-gray-200 text-sm">
        {#each racks as rack, r}
          <li class="flex items-center justify-between px-4 py-2">
            <span><span class="font-medium text-gray-900">{rack.rackId}</span> <span class="text-gray-500">· {rack.tubes.length} tubes</span></span>
            {#each rack.problems as p}<span class="text-xs text-red-700">{p}</span>{/each}
            <button type="button" class="text-xs text-gray-400 hover:text-red-600" onclick={() => (racks = racks.filter((_, i) => i !== r))}>Remove</button>
          </li>
        {/each}
      </ul>

      <div class="mt-4">
        {#if checking}
          <p class="text-sm text-gray-500">Checking {all.length} tube codes against Qiita…</p>
        {:else if needFix === 0}
          <!-- Tailwind UI: feedback / alerts / with description -->
          <div class="rounded-md bg-green-50 p-4">
            <h3 class="text-sm font-medium text-green-800">All {all.length} tubes are in Qiita</h3>
            <p class="mt-2 text-sm text-green-700">
              {[...byStudy.map((x) => `${x.n} from ${x.s.title}`), ...(blanks.length ? [`${blanks.length} blanks`] : [])].join(' · ')}
            </p>
          </div>
        {:else}
          <div class="rounded-md bg-yellow-50 p-4">
            <h3 class="text-sm font-medium text-yellow-800">{needFix} of {all.length} tubes need attention before plating</h3>
            <ul class="mt-2 list-disc space-y-1 pl-5 text-sm text-yellow-700">
              {#if unknown.length}<li>{unknown.length} aren't in Qiita</li>{/if}
              {#if multi.length}<li>{multi.length} belong to more than one study</li>{/if}
              {#if dupes.length}<li>{dupes.length} appear on two racks</li>{/if}
            </ul>
            {#if byStudy.length}
              <p class="mt-2 text-sm text-yellow-700">The rest: {byStudy.map((x) => `${x.n} from ${x.s.title}`).join(' · ')}</p>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
  {:else if step === 2}
    {#if needFix === 0}
      <div class="rounded-md bg-green-50 p-4">
        <h3 class="text-sm font-medium text-green-800">Nothing to fix</h3>
        <p class="mt-2 text-sm text-green-700">Every tube is a known sample in exactly one study, or a blank.</p>
      </div>
    {:else}
      <h2 class="text-sm/6 font-semibold text-gray-900">Fix what Qiita can't place</h2>
      <div class="mt-4 space-y-6">
        {#each unknownRacks as u (u.rack.rackId)}
          <!-- Tailwind UI: feedback / alerts / with actions -->
          <div class="rounded-md bg-red-50 p-4">
            <h3 class="text-sm font-medium text-red-800">{u.n} tubes on {u.rack.rackId} aren't in Qiita</h3>
            <p class="mt-2 text-sm text-red-700">
              A whole rack of unknown tubes almost always means its study's sample metadata isn't in Qiita with tube
              codes yet. Add the tube codes to that study's samples, then check again.
            </p>
            <div class="mt-4 -mx-2 -my-1.5 flex flex-wrap gap-1">
              <button type="button" class="rounded-md bg-red-50 px-2 py-1.5 text-sm font-medium text-red-800 hover:bg-red-100" onclick={() => download(`${u.rack.rackId}-tube-codes.txt`, unknown.filter((x) => racks[x.r].rackId === u.rack.rackId).map((x) => `${x.well}\t${x.tube}`).join('\n'))}>Download the tube codes</button>
              <a href="/studies" class="rounded-md bg-red-50 px-2 py-1.5 text-sm font-medium text-red-800 hover:bg-red-100">Open studies →</a>
              <button type="button" class="rounded-md bg-red-50 px-2 py-1.5 text-sm font-medium text-red-800 hover:bg-red-100" onclick={() => ((soilMetadataAdded = true), check())}>(mock) metadata added — check again</button>
            </div>
          </div>
        {/each}

        {#if looseUnknown.length}
          <section>
            <h3 class="text-sm font-medium text-gray-900">{looseUnknown.length} stray tubes not in Qiita</h3>
            <p class="mt-1 text-sm text-gray-500">A mislabelled tube, a sample not yet registered, or a blank.</p>
            <ul role="list" class="mt-2 divide-y divide-gray-100 rounded-md border border-gray-200 text-sm">
              {#each looseUnknown as x (x.r + x.well)}
                <li class="flex flex-wrap items-center gap-3 px-4 py-2">
                  <span class="font-mono text-xs text-gray-700">{racks[x.r].rackId} {x.well}</span>
                  <span class="font-mono text-xs text-gray-500">{x.tube}</span>
                  <span class="ml-auto flex gap-2">
                    <button type="button" class="rounded-md bg-white px-2.5 py-1 text-xs font-semibold text-gray-900 shadow-xs ring-1 ring-gray-300 ring-inset hover:bg-gray-50" onclick={() => decide(x.r, x.well, { blank: true })}>Blank</button>
                    <button type="button" class="rounded-md bg-white px-2.5 py-1 text-xs font-semibold text-gray-900 shadow-xs ring-1 ring-gray-300 ring-inset hover:bg-gray-50" onclick={() => decide(x.r, x.well, { exclude: true })}>Leave out</button>
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
                {@const c = x.cell as { sample: string; studies: number[] }}
                <li class="flex flex-wrap items-center gap-3 px-4 py-2">
                  <span class="font-mono text-xs text-gray-700">{racks[x.r].rackId} {x.well}</span>
                  <span class="text-gray-700">{c.sample}</span>
                  <span class="ml-auto flex gap-2">
                    {#each c.studies as sid}
                      <button type="button" class="rounded-md bg-white px-2.5 py-1 text-xs font-semibold text-gray-900 shadow-xs ring-1 ring-gray-300 ring-inset hover:bg-gray-50" onclick={() => decide(x.r, x.well, { primary: sid })}>{studyName(sid)}</button>
                    {/each}
                  </span>
                </li>
              {/each}
            </ul>
          </section>
        {/if}

        {#if dupes.length}
          <section>
            <h3 class="text-sm font-medium text-gray-900">{dupes.length / 2} tube{dupes.length === 2 ? '' : 's'} on two racks</h3>
            <p class="mt-1 text-sm text-gray-500">A tube can only be in one well. Keep one, leave the other out.</p>
            <ul role="list" class="mt-2 divide-y divide-gray-100 rounded-md border border-gray-200 text-sm">
              {#each dupes as x (x.r + x.well)}
                <li class="flex flex-wrap items-center gap-3 px-4 py-2">
                  <span class="font-mono text-xs text-gray-700">{racks[x.r].rackId} {x.well}</span>
                  <span class="font-mono text-xs text-gray-500">{x.tube}</span>
                  <span class="ml-auto"><button type="button" class="rounded-md bg-white px-2.5 py-1 text-xs font-semibold text-gray-900 shadow-xs ring-1 ring-gray-300 ring-inset hover:bg-gray-50" onclick={() => decide(x.r, x.well, { exclude: true })}>Leave this one out</button></span>
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
            <p class="mt-1 text-xs {blanksOn(rackAt[i]!) ? 'text-gray-500' : 'text-amber-700'}">
              {blanksOn(rackAt[i]!) ? `${blanksOn(rackAt[i]!)} blanks` : 'No blank on this plate — is that right?'}
            </p>
          {/if}
        </div>
      {/each}
    </div>
    <div class="mt-4 flex flex-wrap gap-4 text-xs text-gray-600">
      {#each byStudy as x}<span class="flex items-center gap-1"><span class="size-3 rounded-full" style="background:{STUDY_COLOR[x.s.study_idx]}"></span>{x.s.title}</span>{/each}
      <span class="flex items-center gap-1"><span class="size-3 rounded-full bg-gray-400"></span>blank</span>
    </div>
    {#if layoutProblems.length}<p class="mt-3 text-sm text-red-700">{layoutProblems.join(' · ')}</p>{/if}
  {:else if step === 4}
    <h2 class="text-sm/6 font-semibold text-gray-900">Processing details</h2>
    <p class="mt-1 text-sm text-gray-500">Recorded with every sample. Write "not applicable" for anything that doesn't apply.</p>
    <div class="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {#each SHARED as [key, label]}
        <div>
          <label for="f-{key}" class="block text-sm/6 font-medium text-gray-900">{label}</label>
          <input id="f-{key}" class="mt-1 block w-full rounded-md bg-white px-3 py-1.5 text-sm text-gray-900 outline-1 -outline-offset-1 {shared[key].trim() ? 'outline-gray-300' : 'outline-red-300'} focus:outline-2 focus:-outline-offset-2 focus:outline-teal-600" bind:value={shared[key]} />
        </div>
      {/each}
    </div>
    <h3 class="mt-8 text-sm font-medium text-gray-900">Plate names</h3>
    <div class="mt-2 grid grid-cols-2 gap-4 lg:grid-cols-4">
      {#each rackAt as r, i}
        {#if r !== null}
          <div>
            <label for="p-{i}" class="block text-xs text-gray-600">Position {i + 1} · {racks[r]?.rackId}</label>
            <input id="p-{i}" class="mt-1 block w-full rounded-md bg-white px-3 py-1.5 text-sm outline-1 -outline-offset-1 outline-gray-300 focus:outline-2 focus:outline-teal-600" bind:value={platesNamed[i]} />
          </div>
        {/if}
      {/each}
    </div>
    {#if detailErrors.length || detailWarnings.length}
      <ul class="mt-4 space-y-1 text-sm">
        {#each detailErrors as t}<li class="text-red-700">{t}</li>{/each}
        {#each detailWarnings as t}<li class="text-amber-700">{t}</li>{/each}
      </ul>
    {/if}
  {:else if step === 5}
    <h2 class="text-sm/6 font-semibold text-gray-900">Register the prep</h2>
    <!-- Tailwind UI: data display / stats -->
    <dl class="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-4">
      {#each byStudy as x}
        <div class="overflow-hidden rounded-lg bg-gray-50 px-4 py-4">
          <dt class="truncate text-sm text-gray-500">{x.s.title}</dt>
          <dd class="mt-1 text-2xl font-semibold text-gray-900">{x.n}</dd>
        </div>
      {/each}
      <div class="overflow-hidden rounded-lg bg-gray-50 px-4 py-4">
        <dt class="truncate text-sm text-gray-500">Blanks</dt>
        <dd class="mt-1 text-2xl font-semibold text-gray-900">{blanks.length}</dd>
      </div>
    </dl>
    <p class="mt-4 text-sm {clashes ? 'text-red-700' : 'text-gray-600'}">
      {clashes ? `${clashes} wells share a barcode` : `${placedWells.length} wells, each with its own EMP Golay barcode.`}
    </p>
    <p class="mt-1 text-sm text-gray-600">Registering adds the blanks as samples in their plate's study and stores the plates, barcodes and processing details with Qiita.</p>
    <div class="mt-6 flex flex-wrap gap-3">
      <button type="button" class="rounded-md bg-teal-600 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-teal-500 disabled:opacity-50" disabled={!!registered || clashes > 0} onclick={() => (registered = 'PREP-0042')}>
        {registered ? `Registered as ${registered}` : 'Register prep'}
      </button>
      {#if registered}
        <button type="button" class="rounded-md bg-white px-3 py-2 text-sm font-semibold text-gray-900 shadow-xs ring-1 ring-gray-300 ring-inset hover:bg-gray-50" onclick={downloadPrePrep}>Download pre-prep file</button>
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
            <li class="flex items-center gap-2"><span class="size-2 rounded-full bg-blue-500"></span>golay-demux — queued: split the run into {placedWells.length} samples</li>
            <li class="flex items-center gap-2"><span class="size-2 rounded-full bg-gray-300"></span>amplicon — starts when demux completes (trim 150, deblur → ASVs → feature table)</li>
          </ol>
        {/if}
      </div>
    {/if}
  {/if}

  <div class="mt-8 flex items-center justify-between border-t border-gray-100 pt-4">
    <button type="button" class="rounded-md bg-white px-3 py-2 text-sm font-semibold text-gray-900 shadow-xs ring-1 ring-gray-300 ring-inset hover:bg-gray-50 disabled:invisible" disabled={step === 0} onclick={() => go(step - 1)}>Back</button>
    {#if step < STEPS.length - 1}
      <button type="button" class="rounded-md bg-teal-600 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-teal-500 disabled:opacity-40" disabled={!canLeave[step]} onclick={() => go(nextStep)}>
        Next: {STEPS[nextStep]}
      </button>
    {/if}
  </div>
</div>

<details class="mt-4 text-xs text-gray-500">
  <summary class="cursor-pointer">Where this step runs</summary>
  <p class="mt-2"><span class="font-medium text-gray-700">Browser:</span> {WHERE[step].client}</p>
  <p class="mt-1"><span class="font-medium text-gray-700">Server:</span> {WHERE[step].server}</p>
</details>
