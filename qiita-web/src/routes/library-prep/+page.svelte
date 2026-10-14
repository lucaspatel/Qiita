<script lang="ts">
  // MOCKUP of the Library prep flow: from "a box of tubes was dropped off" to "the
  // amplicon workflow is running", replacing kl-metapool's
  // amplicon_pre_prep_file_generator notebook. One task per screen. Everything here
  // is local and mocked (lib/libraryPrep/mock.ts); each step says what of it runs in
  // the browser and what the server must own.
  import PageHeading from '$lib/ui/PageHeading.svelte';
  import Card from '$lib/ui/Card.svelte';
  import Select from '$lib/ui/Select.svelte';
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
    to384,
    toVisionMate,
    validateDetails,
    type PlateDetails,
    type Rack,
    type Resolution
  } from '$lib/libraryPrep/mock';

  const STEPS = [
    { title: 'Intake', task: 'Name the prep, check the studies are ready, scan the racks' },
    { title: 'Identify', task: 'Resolve every tube to its sample and study' },
    { title: 'Controls', task: 'Confirm the blanks' },
    { title: 'Plate details', task: 'Positions, primer plates and processing facts' },
    { title: 'Compress', task: 'Check the 384-well layout and barcodes' },
    { title: 'Register', task: 'Register the prep with Qiita' },
    { title: 'Sequence', task: 'Point at the run and start the amplicon workflow' }
  ];
  // Where each step's work belongs; shown beside it.
  const WHERE: { client: string[]; server: string[] }[] = [
    {
      client: ['Parse VisionMate .tsv, normalise tube codes, draw the racks', 'Flag in-file problems (bad wells, repeats)'],
      server: ['Which studies have tube-coded metadata (study reads)', 'Create the prep draft so a multi-day prep resumes on any machine']
    },
    {
      client: ['Show resolutions and offer the fixes'],
      server: ['POST /biosample/resolve-roster: tube → biosample (QB) → study, every problem at once', 'Record the choices (primary study, exclusions) on the draft']
    },
    {
      client: ['Pick which wells are blanks'],
      server: ['Register blanks as biosamples in each plate\'s study (they are samples downstream)']
    },
    {
      client: ['Live validation for feedback (the notebook\'s validate_plate_metadata rules)'],
      server: ['The same rules again on save: they gate the pre-flight']
    },
    {
      client: ['Draw the 384 map from the server\'s answer'],
      server: ['Compress (interleaved quadrants) and assign EMP Golay barcodes from the primer plates — the barcodes golay-demux later checks, so one implementation, not two']
    },
    {
      client: ['Show what will be written; offer the legacy pre-prep .txt'],
      server: ['Write the pre-flight (what kl-run-preflight holds today) and link each sample to its studies', 'Mint the prep\'s identifiers']
    },
    {
      client: ['Pick the run, show ticket progress'],
      server: ['POST /run-folder/inspect, create run + pool from the stored pre-flight', 'Submit golay-demux with amplicon as its follow-on']
    }
  ];

  let step = $state(0);
  let reached = $state(0);
  const go = (i: number) => {
    step = i;
    reached = Math.max(reached, i);
  };

  // --- intake ---
  let prepName = $state('2026-10-14 IBD + Adaptation');
  let seqType = $state('16S');
  let expected = $state<number[]>([15663, 12986, SOIL_STUDY]);
  let tubeCoded = $state<Record<number, boolean>>(
    Object.fromEntries(STUDIES.map((s) => [s.study_idx, s.withTubes > 0]))
  );
  let racks = $state<Rack[]>([]);
  let registry = $state.raw(new Map<string, Resolution>());
  let dragging = $state(false);

  function loadDemo() {
    const box = demoBox();
    racks = box.racks;
    registry = box.registry;
  }
  async function addFiles(files: FileList | null) {
    if (!files) return;
    if (registry.size === 0) registry = demoBox().registry; // the mock's Qiita
    const parsed = await Promise.all([...files].map(async (f) => parseVisionMate(f.name, await f.text())));
    racks = [...racks, ...parsed].slice(0, 4);
  }
  function downloadDemoRacks() {
    for (const r of demoBox().racks) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([toVisionMate(r)], { type: 'text/tab-separated-values' }));
      a.download = r.fileName;
      a.click();
    }
  }
  const unready = $derived(STUDIES.filter((s) => expected.includes(s.study_idx) && !tubeCoded[s.study_idx]));

  // --- identify ---
  type Decision = { primary?: number; exclude?: boolean; blank?: boolean };
  let decisions = $state<Record<string, Decision>>({});
  const keyOf = (r: number, well: string) => `${r}:${well}`;
  const STUDY_COLOR: Record<number, string> = { 15663: '#0d9488', 12986: '#7c3aed', 13001: '#b45309' };

  type Cell =
    | { state: 'sample'; sample: string; qb: string; study: number }
    | { state: 'blank' }
    | { state: 'excluded' }
    | { state: 'unknown' }
    | { state: 'multi'; sample: string; qb: string; studies: number[] }
    | { state: 'duplicate'; other: string };

  const tubeCount = $derived.by(() => {
    const n = new Map<string, string[]>();
    // A well left out no longer holds its tube, so its twin stops being a duplicate.
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
    const places = tubeCount.get(tube) ?? [];
    if (places.length > 1) {
      const me = `${racks[r].rackId} ${well}`;
      return { state: 'duplicate', other: places.filter((p) => p !== me).join(', ') };
    }
    const res = registry.get(tube);
    if (!res) {
      // The mock's stand-in for metadata ingested after the fact: plate 4's soil.
      if (racks[r].rackId === 'SC0004' && tubeCoded[SOIL_STUDY])
        return { state: 'sample', sample: `13001.${well}`, qb: `QB${9100 + WELLS_96.indexOf(well)}`, study: SOIL_STUDY };
      return { state: 'unknown' };
    }
    if (res.kind === 'blank') return { state: 'blank' };
    if (res.kind === 'unknown') return { state: 'unknown' };
    if (res.kind === 'multi')
      return d.primary
        ? { state: 'sample', sample: res.sample, qb: res.qb, study: d.primary }
        : { state: 'multi', sample: res.sample, qb: res.qb, studies: res.studies };
    return { state: 'sample', sample: res.sample, qb: res.qb, study: res.study_idx };
  }

  const cells = $derived(
    racks.map((rack, r) => Object.fromEntries(rack.tubes.map((t) => [t.well, { tube: t.tube, cell: cellOf(r, t.well, t.tube) }])))
  );
  const issues = $derived(
    cells.flatMap((rc, r) =>
      Object.entries(rc)
        .filter(([, v]) => ['unknown', 'multi', 'duplicate'].includes(v.cell.state))
        .map(([well, v]) => ({ r, well, tube: v.tube, cell: v.cell }))
    )
  );
  const unknownByRack = $derived(
    racks.map((_, r) => issues.filter((i) => i.r === r && i.cell.state === 'unknown').length)
  );

  function wellView(r: number): Record<string, Well> {
    const out: Record<string, Well> = {};
    for (const [well, { tube, cell }] of Object.entries(cells[r] ?? {})) {
      if (cell.state === 'sample')
        out[well] = { fill: STUDY_COLOR[cell.study], title: `${cell.sample} · ${cell.qb} · tube ${tube}` };
      else if (cell.state === 'blank') out[well] = { fill: '#9ca3af', title: `blank · tube ${tube}`, mark: 'B' };
      else if (cell.state === 'excluded') out[well] = { fill: '#e5e7eb', title: `excluded · tube ${tube}`, mark: '×' };
      else if (cell.state === 'unknown') out[well] = { fill: '#fecaca', ring: 'ring-red-500', title: `tube ${tube}: not in Qiita`, mark: '?' };
      else if (cell.state === 'multi') out[well] = { fill: '#fde68a', ring: 'ring-amber-500', title: `${cell.sample}: in studies ${cell.studies.join(', ')}`, mark: '2' };
      else out[well] = { fill: '#fed7aa', ring: 'ring-orange-500', title: `tube ${tube} also at ${cell.other}`, mark: 'D' };
    }
    return out;
  }
  let picked = $state<{ r: number; well: string } | null>(null);
  const decide = (r: number, well: string, d: Decision) =>
    (decisions = { ...decisions, [keyOf(r, well)]: { ...(decisions[keyOf(r, well)] ?? {}), ...d } });

  // --- controls ---
  const blanks = $derived(
    cells.map((rc) => Object.entries(rc).filter(([, v]) => v.cell.state === 'blank').map(([w]) => w))
  );
  let blankNaming = $state('BLANK.{plate}.{well}');

  // --- plate details ---
  let details = $state<PlateDetails[]>([]);
  $effect(() => {
    if (details.length !== racks.length)
      details = racks.map((rack, i) => {
        const prior = details[i];
        if (prior) return prior;
        const base = Object.fromEntries(DETAIL_FIELDS.map(([k, , ex]) => [k, ex])) as PlateDetails;
        return {
          ...base,
          position: String(i + 1),
          primerPlate: String(i + 1),
          samplePlate: `Plate_${16 + i}`,
          project: '',
          plating: i === 0 ? 'SF' : ''
        };
      });
  });
  const messages = $derived(validateDetails(details));
  const detailErrors = $derived(messages.flat().filter((m) => m.level === 'error').length);
  // The processing facts, not the plate's own identity, carry over.
  const copyFromFirst = (i: number) => {
    const { position, primerPlate, samplePlate } = details[i];
    details[i] = { ...details[0], position, primerPlate, samplePlate };
  };
  const studiesOn = (r: number) =>
    [...new Set(Object.values(cells[r] ?? {}).flatMap((v) => (v.cell.state === 'sample' ? [v.cell.study] : [])))];

  // --- compress ---
  type Placed = { well384: string; well96: string; r: number; tube: string; cell: Cell; barcode: string };
  const placed = $derived(
    racks.flatMap((_, r) =>
      Object.entries(cells[r] ?? {})
        .filter(([, v]) => v.cell.state === 'sample' || v.cell.state === 'blank')
        .map(([well, v]) => ({
          well384: to384(details[r]?.position ?? String(r + 1), well),
          well96: well,
          r,
          tube: v.tube,
          cell: v.cell,
          barcode: mockGolay(details[r]?.primerPlate ?? '1', well)
        }))
    )
  );
  const QUADRANT = ['#0d9488', '#7c3aed', '#b45309', '#2563eb'];
  const view384 = $derived(
    Object.fromEntries(
      placed.map((p) => [
        p.well384,
        {
          fill: p.cell.state === 'blank' ? '#9ca3af' : QUADRANT[Number(details[p.r]?.position ?? 1) - 1],
          title: `${p.cell.state === 'sample' ? p.cell.sample : 'blank'} · ${racks[p.r].rackId} ${p.well96} · ${p.barcode}`
        }
      ])
    )
  );
  const barcodeClashes = $derived(placed.length - new Set(placed.map((p) => p.barcode)).size);
  let picked384 = $state<string | null>(null);
  const pick384 = $derived(placed.find((p) => p.well384 === picked384) ?? null);

  // --- register ---
  const perStudy = $derived(
    STUDIES.map((s) => ({
      s,
      samples: placed.filter((p) => p.cell.state === 'sample' && p.cell.study === s.study_idx).length
    })).filter((x) => x.samples)
  );
  let registered = $state<string | null>(null);
  function downloadPrePrep() {
    const head = ['sample_name', 'tube_id', 'qiita_study_id', 'sample_plate', 'well_id_384', 'well_id_96', 'primer_plate', 'barcode', 'plating', 'extraction_kit_lot', 'water_lot'];
    const rows = placed.map((p) => {
      const d = details[p.r];
      const name = p.cell.state === 'sample' ? p.cell.sample : blankNaming.replace('{plate}', d.samplePlate).replace('{well}', p.well96);
      const study = p.cell.state === 'sample' ? p.cell.study : (studiesOn(p.r)[0] ?? '');
      return [name, p.tube, study, d.samplePlate, p.well384, p.well96, d.primerPlate, p.barcode, d.plating, d.extractionKitLot, d.waterLot].join('\t');
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([[head.join('\t'), ...rows].join('\n')], { type: 'text/plain' }));
    a.download = `${new Date().toISOString().slice(0, 10).replaceAll('-', '')}_IL515fBC_806_${prepName.replace(/\W+/g, '_')}.txt`;
    a.click();
  }

  // --- sequence ---
  let runFolder = $state(RUN_FOLDERS[0].id);
  let trim = $state(150);
  let started = $state<{ demux: string; amplicon: string } | null>(null);

  // What blocks leaving each step.
  const blockers = $derived<string[][]>([
    [
      ...(racks.length ? [] : ['Scan or drop at least one rack']),
      ...unready.map((s) => `${s.title} has no tube codes in its metadata`),
      ...racks.flatMap((r) => r.problems.map((p) => `${r.rackId}: ${p}`))
    ],
    issues.length ? [`${issues.length} well(s) still need a decision`] : [],
    [],
    detailErrors ? [`${detailErrors} plate-detail error(s)`] : [],
    barcodeClashes ? [`${barcodeClashes} barcode clash(es)`] : [],
    registered ? [] : ['Register the prep first'],
    []
  ]);
</script>

<PageHeading
  title="Library prep"
  subtitle="From a box of tubes to a running amplicon workflow — replaces the amplicon pre-prep notebook."
/>

<div class="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900">
  <strong>Mockup.</strong> Every screen works on local, made-up data; nothing is sent to Qiita.
  Each step notes what the real version does in the browser and what on the server.
</div>

<div class="grid grid-cols-1 gap-6 lg:grid-cols-[14rem_minmax(0,1fr)]">
  <!-- Step rail -->
  <nav aria-label="Steps" class="lg:sticky lg:top-4 lg:self-start">
    <ol class="space-y-1">
      {#each STEPS as s, i}
        <li>
          <button
            type="button"
            disabled={i > reached}
            class="flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left text-sm transition disabled:opacity-40
              {i === step ? 'bg-teal-50 ring-1 ring-teal-600' : 'hover:bg-gray-50'}"
            onclick={() => go(i)}
          >
            <span
              class="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold
                {i < reached || (i === reached && i < step) ? 'bg-teal-600 text-white' : i === step ? 'bg-teal-700 text-white' : 'bg-gray-200 text-gray-600'}"
              >{i + 1}</span
            >
            <span>
              <span class="block font-medium text-gray-900">{s.title}</span>
              <span class="block text-xs text-gray-500">{s.task}</span>
            </span>
          </button>
        </li>
      {/each}
    </ol>
  </nav>

  <div class="min-w-0 space-y-4">
    <Card title={`${step + 1}. ${STEPS[step].title} — ${STEPS[step].task}`}>
      {#if step === 0}
        <div class="space-y-6">
          <div class="flex flex-wrap gap-4">
            <label class="flex flex-col gap-1 text-xs text-gray-600">
              Prep name
              <input class="w-72 rounded-md border border-gray-300 px-2.5 py-1.5 text-sm" bind:value={prepName} />
            </label>
            <label class="flex flex-col gap-1 text-xs text-gray-600">
              Amplicon
              <Select bind:value={seqType} class="w-40">
                <option>16S</option><option>18S</option><option>ITS</option>
              </Select>
            </label>
          </div>

          <div>
            <h4 class="mb-2 text-sm font-medium text-gray-900">Which studies are in this box?</h4>
            <p class="mb-2 text-xs text-gray-500">
              Tubes are matched to samples by the tube codes in each study's metadata, so every study
              must have its sample metadata, with tube codes, in Qiita before its tubes can be placed.
            </p>
            <ul class="divide-y divide-gray-100 rounded-lg border border-gray-200">
              {#each STUDIES as s}
                {@const on = expected.includes(s.study_idx)}
                <li class="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
                  <input
                    type="checkbox"
                    class="rounded border-gray-300 text-teal-600"
                    checked={on}
                    onchange={(e) =>
                      (expected = e.currentTarget.checked
                        ? [...expected, s.study_idx]
                        : expected.filter((x) => x !== s.study_idx))}
                  />
                  <span class="size-3 rounded-full" style="background:{STUDY_COLOR[s.study_idx]}"></span>
                  <span class="font-medium">{s.title}</span>
                  <span class="text-gray-400">#{s.study_idx}</span>
                  {#if tubeCoded[s.study_idx]}
                    <span class="ml-auto text-xs text-teal-700">✓ {s.biosamples} samples, tube codes on {s.withTubes || s.biosamples}</span>
                  {:else}
                    <span class="ml-auto flex items-center gap-2 text-xs text-red-700">
                      {s.biosamples} samples, <strong>no tube codes</strong>
                      <a class="rounded bg-white px-2 py-0.5 text-gray-700 ring-1 ring-gray-300 hover:bg-gray-50" href="/studies/{s.study_idx}">Add metadata →</a>
                      <button
                        type="button"
                        class="rounded bg-white px-2 py-0.5 text-gray-700 ring-1 ring-gray-300 hover:bg-gray-50"
                        onclick={() => (tubeCoded = { ...tubeCoded, [s.study_idx]: true })}
                        title="Mockup: pretend the metadata was loaded">(mock) done</button
                      >
                    </span>
                  {/if}
                </li>
              {/each}
            </ul>
          </div>

          <div>
            <h4 class="mb-2 text-sm font-medium text-gray-900">Racks (up to four 96-well racks)</h4>
            <div
              role="region"
              aria-label="Drop VisionMate rack files"
              class="flex flex-col items-center gap-2 rounded-lg border-2 border-dashed px-4 py-6 text-center text-sm transition
                {dragging ? 'border-teal-500 bg-teal-50' : 'border-gray-300'}"
              ondragover={(e) => (e.preventDefault(), (dragging = true))}
              ondragleave={() => (dragging = false)}
              ondrop={(e) => (e.preventDefault(), (dragging = false), addFiles(e.dataTransfer?.files ?? null))}
            >
              <span class="text-gray-700">Drop the VisionMate rack scans (.tsv) here</span>
              <span class="text-xs text-gray-500">or</span>
              <span class="flex flex-wrap justify-center gap-2">
                <label class="cursor-pointer rounded-md bg-white px-3 py-1.5 text-sm ring-1 ring-gray-300 hover:bg-gray-50">
                  Choose files<input type="file" multiple accept=".tsv,.txt" class="hidden" onchange={(e) => addFiles(e.currentTarget.files)} />
                </label>
                <button type="button" class="rounded-md bg-teal-600 px-3 py-1.5 text-sm text-white hover:bg-teal-500" onclick={loadDemo}>Load the demo box</button>
                <button type="button" class="rounded-md bg-white px-3 py-1.5 text-sm ring-1 ring-gray-300 hover:bg-gray-50" onclick={downloadDemoRacks}>Download demo rack files</button>
              </span>
            </div>
            {#if racks.length}
              <div class="mt-4 flex flex-wrap gap-4">
                {#each racks as rack, r}
                  <div class="space-y-1">
                    <div class="flex items-center justify-between text-xs text-gray-600">
                      <span><strong>{rack.rackId}</strong> · {rack.tubes.length} tubes</span>
                      <button type="button" class="text-gray-400 hover:text-red-600" onclick={() => (racks = racks.filter((_, i) => i !== r))}>remove</button>
                    </div>
                    <PlateMap wells={Object.fromEntries(rack.tubes.map((t) => [t.well, { fill: '#64748b', title: `tube ${t.tube}` }]))} />
                    {#each rack.problems as p}<p class="text-xs text-red-700">{p}</p>{/each}
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        </div>
      {:else if step === 1}
        <div class="space-y-4">
          <div class="flex flex-wrap gap-3 text-xs">
            {#each STUDIES.filter((s) => expected.includes(s.study_idx)) as s}
              <span class="flex items-center gap-1"><span class="size-3 rounded-full" style="background:{STUDY_COLOR[s.study_idx]}"></span>{s.title}</span>
            {/each}
            <span class="flex items-center gap-1"><span class="size-3 rounded-full bg-gray-400"></span>blank</span>
            <span class="flex items-center gap-1"><span class="size-3 rounded-full bg-red-200 ring-2 ring-red-500"></span>not in Qiita</span>
            <span class="flex items-center gap-1"><span class="size-3 rounded-full bg-amber-200 ring-2 ring-amber-500"></span>in two studies</span>
            <span class="flex items-center gap-1"><span class="size-3 rounded-full bg-orange-200 ring-2 ring-orange-500"></span>tube on two racks</span>
          </div>
          <div class="flex flex-wrap gap-4">
            {#each racks as rack, r}
              <div class="space-y-1">
                <div class="text-xs text-gray-600"><strong>{rack.rackId}</strong></div>
                <PlateMap wells={wellView(r)} selected={picked?.r === r ? picked.well : null} onpick={(w) => (picked = { r, well: w })} />
                {#if unknownByRack[r] > 40}
                  <p class="max-w-[22rem] text-xs text-red-700">
                    {unknownByRack[r]} tubes on this rack match no sample. A whole rack unknown usually means its
                    study's metadata isn't in Qiita with tube codes yet.
                  </p>
                {/if}
              </div>
            {/each}
          </div>

          <div>
            <h4 class="mb-2 text-sm font-medium text-gray-900">
              {issues.length ? `${issues.length} well(s) need a decision` : 'Every tube resolved ✓'}
            </h4>
            {#if issues.length}
              <ul class="max-h-80 divide-y divide-gray-100 overflow-y-auto rounded-lg border border-gray-200 text-sm">
                {#each issues as it (it.r + it.well)}
                  <li class="flex flex-wrap items-center gap-2 px-3 py-2 {picked?.r === it.r && picked.well === it.well ? 'bg-teal-50' : ''}">
                    <button type="button" class="font-mono text-xs text-teal-700 hover:underline" onclick={() => (picked = { r: it.r, well: it.well })}>{racks[it.r].rackId} {it.well}</button>
                    <span class="font-mono text-xs text-gray-500">{it.tube}</span>
                    {#if it.cell.state === 'unknown'}
                      <span class="text-red-700">No sample has this tube code.</span>
                      <span class="ml-auto flex gap-1">
                        <button type="button" class="rounded px-2 py-0.5 text-xs ring-1 ring-gray-300 hover:bg-gray-50" onclick={() => decide(it.r, it.well, { blank: true })}>It's a blank</button>
                        <button type="button" class="rounded px-2 py-0.5 text-xs ring-1 ring-gray-300 hover:bg-gray-50" onclick={() => decide(it.r, it.well, { exclude: true })}>Leave out</button>
                      </span>
                    {:else if it.cell.state === 'multi'}
                      {@const c = it.cell}
                      <span class="text-amber-800">{c.sample} is in {c.studies.length} studies — which one is this prep for?</span>
                      <span class="ml-auto flex gap-1">
                        {#each c.studies as sid}
                          <button type="button" class="rounded px-2 py-0.5 text-xs ring-1 ring-gray-300 hover:bg-gray-50" onclick={() => decide(it.r, it.well, { primary: sid })}>#{sid}</button>
                        {/each}
                      </span>
                    {:else if it.cell.state === 'duplicate'}
                      <span class="text-orange-800">The same tube is also at {it.cell.other}.</span>
                      <span class="ml-auto"><button type="button" class="rounded px-2 py-0.5 text-xs ring-1 ring-gray-300 hover:bg-gray-50" onclick={() => decide(it.r, it.well, { exclude: true })}>Leave this well out</button></span>
                    {/if}
                  </li>
                {/each}
              </ul>
              <p class="mt-2 text-xs text-gray-500">
                A tube Qiita doesn't know is fixed in its study (add or correct the sample's tube code), not
                here; once that's done this list refreshes. Rack SC0004 is the soil study from Intake — mark its
                metadata done there to see it resolve.
              </p>
            {/if}
          </div>
        </div>
      {:else if step === 2}
        <div class="space-y-4">
          <p class="text-sm text-gray-700">
            Blanks are named, registered as samples in their plate's study, and carried through sequencing like
            any other sample. Wells marked as blanks on the last step are included.
          </p>
          <label class="flex flex-col gap-1 text-xs text-gray-600">
            Blank name pattern
            <input class="w-72 rounded-md border border-gray-300 px-2.5 py-1.5 font-mono text-sm" bind:value={blankNaming} />
          </label>
          <ul class="space-y-1 text-sm">
            {#each racks as rack, r}
              <li>
                <strong>{rack.rackId}</strong>: {blanks[r].length} blank{blanks[r].length === 1 ? '' : 's'}
                {#if blanks[r].length}
                  <span class="font-mono text-xs text-gray-500">({blanks[r].join(', ')})</span>
                {:else}
                  <span class="text-xs text-amber-700"> — no blank on this plate; is that right?</span>
                {/if}
              </li>
            {/each}
          </ul>
        </div>
      {:else if step === 3}
        <div class="space-y-4">
          {#each details as d, i}
            <div class="rounded-lg border border-gray-200 p-3">
              <div class="mb-2 flex flex-wrap items-center gap-3">
                <strong class="text-sm">{racks[i]?.rackId}</strong>
                <span class="text-xs text-gray-500">studies: {studiesOn(i).map((s) => '#' + s).join(', ') || '—'}</span>
                <label class="flex items-center gap-1 text-xs text-gray-600">Position
                  <Select bind:value={d.position} class="w-16">{#each ['1', '2', '3', '4'] as p}<option>{p}</option>{/each}</Select>
                </label>
                <label class="flex items-center gap-1 text-xs text-gray-600">Primer plate #
                  <input class="w-14 rounded-md border border-gray-300 px-2 py-1 text-sm" bind:value={d.primerPlate} />
                </label>
                {#if i > 0}<button type="button" class="ml-auto text-xs text-teal-700 hover:underline" onclick={() => copyFromFirst(i)}>Copy processing facts from {racks[0]?.rackId}</button>{/if}
              </div>
              <div class="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                {#each DETAIL_FIELDS as [key, label]}
                  <label class="flex flex-col gap-0.5 text-[11px] text-gray-600">
                    {label}
                    <input class="rounded-md border px-2 py-1 text-sm {d[key].trim() ? 'border-gray-300' : 'border-red-400 bg-red-50'}" bind:value={d[key]} />
                  </label>
                {/each}
              </div>
              {#each messages[i] ?? [] as m}
                <p class="mt-1 text-xs {m.level === 'error' ? 'text-red-700' : 'text-amber-700'}">{m.level === 'error' ? '✕' : '!'} {m.text}</p>
              {/each}
            </div>
          {/each}
        </div>
      {:else if step === 4}
        <div class="flex flex-wrap gap-6">
          <div class="space-y-2">
            <PlateMap format={384} wells={view384} selected={picked384} onpick={(w) => (picked384 = w)} />
            <div class="flex flex-wrap gap-3 text-xs">
              {#each details as d, i}
                <span class="flex items-center gap-1"><span class="size-3 rounded-full" style="background:{QUADRANT[Number(d.position) - 1]}"></span>{racks[i]?.rackId} → position {d.position}, primer plate {d.primerPlate}</span>
              {/each}
            </div>
          </div>
          <div class="min-w-64 flex-1 space-y-2 text-sm">
            <p class="text-gray-700">{placed.length} wells placed in the interleaved 4-quadrant layout.</p>
            <p class={barcodeClashes ? 'text-red-700' : 'text-teal-700'}>
              {barcodeClashes ? `${barcodeClashes} wells share a Golay barcode` : '✓ Every well has its own Golay barcode'}
            </p>
            {#if pick384}
              <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg border border-gray-200 p-3 text-xs">
                <dt class="text-gray-500">384 well</dt><dd class="font-mono">{pick384.well384}</dd>
                <dt class="text-gray-500">From</dt><dd class="font-mono">{racks[pick384.r].rackId} {pick384.well96}</dd>
                <dt class="text-gray-500">Sample</dt><dd>{pick384.cell.state === 'sample' ? `${pick384.cell.sample} (${pick384.cell.qb})` : 'blank'}</dd>
                <dt class="text-gray-500">Tube</dt><dd class="font-mono">{pick384.tube}</dd>
                <dt class="text-gray-500">Golay</dt><dd class="font-mono">{pick384.barcode}</dd>
              </dl>
            {:else}
              <p class="text-xs text-gray-500">Click a well to see what's in it.</p>
            {/if}
          </div>
        </div>
      {:else if step === 5}
        <div class="space-y-4">
          <table class="min-w-full divide-y divide-gray-200 text-sm">
            <thead class="bg-gray-50 text-xs text-gray-500 uppercase"><tr><th class="px-3 py-2 text-left">Study</th><th class="px-3 py-2 text-left">Samples in this prep</th></tr></thead>
            <tbody class="divide-y divide-gray-100">
              {#each perStudy as x}
                <tr><td class="px-3 py-2"><span class="mr-2 inline-block size-3 rounded-full align-middle" style="background:{STUDY_COLOR[x.s.study_idx]}"></span>{x.s.title} <span class="text-gray-400">#{x.s.study_idx}</span></td><td class="px-3 py-2">{x.samples}</td></tr>
              {/each}
              <tr><td class="px-3 py-2 text-gray-600">Blanks (registered in their plate's study)</td><td class="px-3 py-2">{blanks.flat().length}</td></tr>
            </tbody>
          </table>
          <div class="rounded-lg bg-gray-50 p-3 text-xs text-gray-600">
            <p class="mb-1 font-medium text-gray-700">Registering will:</p>
            <ul class="list-disc space-y-0.5 pl-5">
              <li>register the {blanks.flat().length} blanks as samples in their plate's study</li>
              <li>store the prep's pre-flight (plates, wells, barcodes, processing facts) in Qiita</li>
              <li>link every sample to the study it was resolved to</li>
            </ul>
          </div>
          <div class="flex flex-wrap gap-2">
            <button type="button" class="rounded-md bg-teal-600 px-3 py-1.5 text-sm text-white hover:bg-teal-500 disabled:opacity-50" disabled={!!registered} onclick={() => (registered = 'PREP-0042')}>
              {registered ? `Registered as ${registered}` : 'Register prep'}
            </button>
            <button type="button" class="rounded-md bg-white px-3 py-1.5 text-sm ring-1 ring-gray-300 hover:bg-gray-50" onclick={downloadPrePrep}>Download pre-prep file (.txt)</button>
          </div>
        </div>
      {:else if step === 6}
        <div class="space-y-4">
          <p class="text-sm text-gray-700">When the MiSeq run has finished and its folder is on the ingest roots:</p>
          <div class="flex flex-wrap items-end gap-3">
            <label class="flex flex-col gap-1 text-xs text-gray-600">Run folder
              <Select bind:value={runFolder} class="w-[26rem]">
                {#each RUN_FOLDERS as f}<option value={f.id}>{f.id} · {f.instrument} · {f.cycles}</option>{/each}
              </Select>
            </label>
            <label class="flex flex-col gap-1 text-xs text-gray-600">Trim (nt)
              <input type="number" class="w-20 rounded-md border border-gray-300 px-2 py-1.5 text-sm" bind:value={trim} />
            </label>
            <button type="button" class="rounded-md bg-teal-600 px-3 py-1.5 text-sm text-white hover:bg-teal-500 disabled:opacity-50" disabled={!!started} onclick={() => (started = { demux: '#101', amplicon: '#102' })}>
              Start demux → amplicon
            </button>
          </div>
          {#if started}
            <ol class="space-y-2 text-sm">
              <li class="flex items-center gap-2"><span class="size-2 rounded-full bg-blue-500"></span>golay-demux {started.demux} — queued (splits the run by Golay barcode into {placed.length} samples)</li>
              <li class="flex items-center gap-2"><span class="size-2 rounded-full bg-gray-300"></span>amplicon {started.amplicon} — starts when demux completes (trim {trim}, deblur → ASVs → feature table)</li>
            </ol>
            <p class="text-xs text-gray-500">Both appear under Jobs, and the studies' lineage shows the new reads and ASVs as they land.</p>
          {/if}
        </div>
      {/if}

      <div class="mt-6 flex items-center justify-between border-t border-gray-200 pt-4">
        <button type="button" class="rounded-md px-3 py-1.5 text-sm text-gray-600 ring-1 ring-gray-300 hover:bg-gray-50 disabled:opacity-40" disabled={step === 0} onclick={() => go(step - 1)}>← Back</button>
        <span class="text-xs text-red-700">{blockers[step].join(' · ')}</span>
        {#if step < STEPS.length - 1}
          <button type="button" class="rounded-md bg-teal-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-teal-600 disabled:opacity-40" disabled={blockers[step].length > 0} onclick={() => go(step + 1)}>Next: {STEPS[step + 1].title} →</button>
        {/if}
      </div>
    </Card>

    <Card title="Where this step runs">
      <div class="grid grid-cols-1 gap-4 text-xs sm:grid-cols-2">
        <div>
          <p class="mb-1 font-medium text-gray-700">Browser</p>
          <ul class="list-disc space-y-0.5 pl-4 text-gray-600">{#each WHERE[step].client as c}<li>{c}</li>{/each}</ul>
        </div>
        <div>
          <p class="mb-1 font-medium text-gray-700">Server (Qiita-miint)</p>
          <ul class="list-disc space-y-0.5 pl-4 text-gray-600">{#each WHERE[step].server as c}<li>{c}</li>{/each}</ul>
        </div>
      </div>
    </Card>
  </div>
</div>
