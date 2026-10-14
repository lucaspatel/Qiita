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
  import { scopedKey } from '$lib/environment';
  import PlateMap, { type Well } from '$lib/ui/PlateMap.svelte';
  import {
    MIN_BLANKS,
    RUN_FOLDERS,
    STUDIES,
    WELLS_96,
    barcodeProblems,
    demoBox,
    mockGolay,
    parseVisionMate,
    sampleName,
    to384,
    toVisionMate,
    validatePlates,
    validateStudy,
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
  /** A rack whose scan has a problem is refused until it is removed or rescanned. */
  const refused = $derived(racks.filter((r) => r.problems.length));

  // --- resolution: what Qiita-miint answers for every tube, and the tech's decisions ---
  type Decision = { primary?: number; exclude?: boolean; blank?: boolean };
  let decisions = $state<Record<string, Decision>>({});
  /** Racks of a study Qiita-miint doesn't have, kept for their sample sheet only. */
  let sheetOnly = $state<Record<string, boolean>>({});
  const keyOf = (r: number, well: string) => `${r}:${well}`;
  const decide = (r: number, well: string, d: Decision) =>
    (decisions = { ...decisions, [keyOf(r, well)]: { ...(decisions[keyOf(r, well)] ?? {}), ...d } });
  /** Samples the tech marked as blanks on Plates ("Edit blanks"), kept apart from
   *  Fix's decisions so a reset undoes only these. */
  let blankEdits = $state<Record<string, true>>({});
  let editBlanks = $state(false);

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
    if (d.blank || blankEdits[keyOf(r, well)]) return { state: 'blank' };
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
  /** The studies a rack's samples belong to, in well order. */
  const studiesOfRack = (r: number) => [
    ...new Set(all.flatMap((x) => (x.r === r && x.cell.state === 'sample' ? [x.cell.study] : [])))
  ];
  /** Where a plate's blanks go when its samples are of more than one study: one
   *  study's sheet, or EACH study's (the blank is then in every sheet). */
  const EACH = 'each';
  let blanksTo = $state<Record<string, string>>({});
  const mixedRacks = $derived(
    racks.flatMap((rack, r) => (studiesOfRack(r).length > 1 && blanksOn(r) ? [{ rack, r }] : []))
  );
  const blankStudies = (r: number): string[] => {
    const studies = studiesOfRack(r);
    if (studies.length <= 1) return studies;
    const to = blanksTo[racks[r].rackId];
    return to === EACH ? studies : to ? [to] : [];
  };
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
      else out[well] = { fill: '#fecaca', ring: 'ring-red-500', title: `${tube} · ${problemOf(cell)}`, mark: '!' };
    }
    return out;
  }
  function problemOf(cell: Cell): string {
    if (cell.state === 'unknown') return 'not in Qiita-miint';
    if (cell.state === 'multi') return `in ${cell.studies.length} studies: choose one`;
    if (cell.state === 'duplicate') return `the same tube is also at ${cell.other}`;
    return '';
  }
  /** Every tube Fix still has to settle, for the study owner or the tech's notes. */
  const downloadProblems = () =>
    download(
      'unplaced-tube-codes.tsv',
      ['rack\twell\ttube_code\tproblem', ...[...unknown, ...multi, ...dupes].map((x) => `${racks[x.r].rackId}\t${x.well}\t${x.tube}\t${problemOf(x.cell)}`)].join('\n')
    );
  /** In "Edit blanks", a click makes a sample a blank or undoes that; a tube the
   *  scan or Fix made a blank stays one. */
  const toggleBlank = (r: number, well: string) => {
    if (!editBlanks) return;
    const k = keyOf(r, well);
    if (blankEdits[k]) {
      const { [k]: _gone, ...rest } = blankEdits;
      blankEdits = rest;
    } else if (cells[r]?.[well]?.cell.state === 'sample') blankEdits = { ...blankEdits, [k]: true };
  };
  const blanksChanged = $derived(Object.keys(blankEdits).length);
  // rackAt catches up with a removed rack an effect later; until then skip what's gone.
  const placed = $derived(
    rackAt.flatMap((r, i) => (r === null || r >= racks.length ? [] : [{ r, position: String(i + 1) }]))
  );
  const layoutProblems = $derived.by(() => {
    const p: string[] = [];
    if (new Set(placed.map((x) => x.r)).size !== placed.length) p.push('A rack is in two positions');
    if (new Set(placed.map((x) => x.r)).size !== racks.length) p.push('Every rack needs a position');
    const pp = placed.map((x) => primerAt[Number(x.position) - 1]);
    if (new Set(pp).size !== pp.length) p.push('A primer plate is used twice');
    for (const { rack } of mixedRacks)
      if (!blanksTo[rack.rackId]) p.push(`Say which study ${rack.rackId}'s blanks belong to`);
    return p;
  });

  // --- 5. details: per plate, per study, per run ---
  const EMPTY_PLATE = Object.fromEntries(PLATE_COLUMNS.map(([k]) => [k, ''])) as Plate;
  let plateFacts = $state<Record<string, Plate>>({});
  let studyFacts = $state<Record<string, StudyFacts>>({});
  let run = $state<RunFacts>({ run_date: '', instrument_model: '', platemap_generation_date: '' });
  // The last prep's plate facts and instrument, so the lots and tools that repeat
  // run to run arrive filled. A convenience: storage may be absent, and anything
  // malformed is ignored.
  const LAST_KEY = scopedKey('qiita-web:library-prep:last');
  type Last = { plate: Partial<Plate>; instrument_model: string; when: string };
  function loadLast(): Last | null {
    try {
      const v = JSON.parse(localStorage.getItem(LAST_KEY) ?? 'null');
      return v && typeof v === 'object' && typeof v.plate === 'object' ? (v as Last) : null;
    } catch {
      return null;
    }
  }
  function saveLast() {
    const first = placed[0];
    if (!first) return;
    const { sample_plate: _s, primer_plate: _p, ...plate } = plateFacts[racks[first.r].rackId];
    try {
      localStorage.setItem(LAST_KEY, JSON.stringify({ plate, instrument_model: run.instrument_model, when: new Date().toISOString().slice(0, 10) }));
    } catch {
      // Storage unavailable: the next prep starts empty.
    }
  }
  const last = loadLast();
  let prefilled = $state(false);
  // Seed what the tech would type: the demo's values for its racks, the last prep's
  // for any other; keep what they've typed.
  $effect(() => {
    const d = demo;
    const rs = racks;
    untrack(() => {
      for (const rack of rs) {
        if (plateFacts[rack.rackId]) continue;
        const known = d?.plates[rack.rackId]?.facts;
        if (!known && last) prefilled = true;
        plateFacts[rack.rackId] = { ...(known ?? { ...EMPTY_PLATE, ...last?.plate, sample_plate: '' }) };
      }
      for (const [k, v] of Object.entries(d?.studyFacts ?? {})) studyFacts[k] ??= { ...v };
      if (d && !run.run_date) run = { ...d.run };
      else if (!run.instrument_model && last) run.instrument_model = last.instrument_model;
    });
  });
  const factsAt = (position: string, r: number): Plate => ({
    ...(plateFacts[racks[r].rackId] ?? EMPTY_PLATE),
    primer_plate: primerAt[Number(position) - 1]
  });
  const messages = $derived(validatePlates(placed.map(({ r, position }) => ({ position, facts: factsAt(position, r) }))));
  const errors = $derived([...new Set(messages.filter((m) => m.level === 'error').map((m) => m.text))]);
  const warnings = $derived([...new Set(messages.filter((m) => m.level === 'warning').map((m) => m.text))]);
  const STUDY_LABELS = Object.fromEntries(STUDY_COLUMNS);
  const studyErrors = $derived([
    ...studyKeys.flatMap((k) => (studyFacts[k] ? validateStudy(titleOf(k), studyFacts[k], STUDY_LABELS) : [])),
    ...(/^\d{4}-\d{2}-\d{2}$/.test(run.run_date) ? [] : ['Run date must be YYYY-MM-DD']),
    ...Object.entries(run).flatMap(([k, v]) => (/[^\x00-\x7f]/.test(v) ? [`Run: ${k} has a non-ASCII character`] : []))
  ]);
  type PlateCol = (typeof PLATE_COLUMNS)[number][0];
  const placedFacts = () => placed.flatMap(({ r }) => (plateFacts[racks[r].rackId] ? [plateFacts[racks[r].rackId]] : []));
  const differs = (col: PlateCol) => new Set(placedFacts().map((f) => f[col])).size > 1;
  /** Rows the tech opened per plate although every plate has the same value. */
  let splitRows = $state<Partial<Record<PlateCol, boolean>>>({});
  const isSplit = (col: PlateCol) => !!splitRows[col] || differs(col);
  const setAll = (col: PlateCol, v: string) => {
    for (const f of placedFacts()) f[col] = v;
  };
  /** Back to one value: the first plate's, on every plate. */
  const sameForAll = (col: PlateCol) => {
    setAll(col, placedFacts()[0]?.[col] ?? '');
    splitRows = { ...splitRows, [col]: false };
  };
  const INSTRUMENTS = ['Illumina MiSeqi100', 'Illumina MiSeq', 'Illumina iSeq 100', 'Illumina NextSeq 2000', 'Illumina NovaSeq X'];
  const instruments = $derived(
    run.instrument_model && !INSTRUMENTS.includes(run.instrument_model) ? [run.instrument_model, ...INSTRUMENTS] : INSTRUMENTS
  );

  // --- 6. pre-flight: one sample sheet per study, which kl-run-preflight builds the blob from ---
  const sheetWells = $derived(
    placed.flatMap(({ r, position }) => {
      const plate = factsAt(position, r);
      const toBlanks = blankStudies(r);
      return Object.entries(cells[r] ?? {}).flatMap(([well96, v]) => {
        const blank = v.cell.state === 'blank';
        if (!blank && v.cell.state !== 'sample') return [];
        const studies = blank ? toBlanks : [(v.cell as { study: string }).study];
        return studies.map((study) => (
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
        ));
      });
    })
  );
  // A blank copied into each study's sheet is one well, not a barcode clash.
  const barcodeIssues = $derived(barcodeProblems([...new Map(sheetWells.map((w) => [w.well384, w])).values()]));
  /** The 384-well plate as it will be loaded: each well in its study's colour. */
  const plate384 = $derived(
    Object.fromEntries(
      sheetWells.map((w) => [
        w.well384,
        w.control
          ? { fill: '#9ca3af', title: `${w.name} · blank · tube ${w.tube} · ${w.barcode}`, mark: 'B' }
          : { fill: colorOf(w.study), title: `${w.name} · ${titleOf(w.study)} · tube ${w.tube} · ${w.barcode}` }
      ])
    ) as Record<string, Well>
  );
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
  // A pre-flight is of the sheets it was built from: any later change unbuilds it.
  $effect(() => {
    sheets.map((x) => x.text);
    untrack(() => (built = false));
  });
  const preflightName = $derived(
    `${run.run_date.replaceAll('-', '') || 'YYYYMMDD'}_IL515fBC_806_${studyKeys.map((k) => studyFacts[k]?.project_abbreviation ?? k).join('_')}.preflight.db`
  );

  // --- 7. sequence ---
  let runFolder = $state<string | null>(null);
  let started = $state(false);

  const canLeave = $derived([
    !!protocol && !!target,
    racks.length > 0 && !checking && refused.length === 0,
    needFix === 0,
    layoutProblems.length === 0,
    errors.length === 0 && studyErrors.length === 0,
    built,
    true
  ]);
  // With nothing to fix, Scan goes straight to Plates.
  const nextStep = $derived(step === 1 && needFix === 0 ? 3 : step + 1);

  const btn = 'rounded-md bg-white px-2.5 py-1 text-xs font-semibold text-gray-900 shadow-xs ring-1 ring-gray-300 ring-inset hover:bg-gray-50';
  /** Tailwind UI: forms / select menus / simple native (the chevron is `chevron`). */
  const select =
    'col-start-1 row-start-1 w-full appearance-none rounded-md bg-white py-1.5 pr-8 pl-3 text-base text-gray-900 outline-1 -outline-offset-1 outline-gray-300 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-teal-600 sm:text-sm/6';
  const input = 'block w-full rounded-md bg-white px-2 py-1 text-sm text-gray-900 outline-1 -outline-offset-1 focus:outline-2 focus:-outline-offset-2 focus:outline-teal-600';
</script>

{#snippet chevron()}
  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" class="pointer-events-none col-start-1 row-start-1 mr-2 size-5 self-center justify-self-end text-gray-500 sm:size-4"><path d="M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z" clip-rule="evenodd" fill-rule="evenodd" /></svg>
{/snippet}

{#snippet legend(blanks = true)}
  <ul class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-600">
    {#each studyKeys as k}<li><span class="mr-1.5 inline-block size-2.5 rounded-full align-middle" style="background:{colorOf(k)}"></span>{titleOf(k)}</li>{/each}
    {#if blanks}<li><span class="mr-1.5 inline-block size-2.5 rounded-full bg-gray-400 align-middle"></span>blank</li>{/if}
  </ul>
{/snippet}

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
          <select id="protocol" bind:value={protocol} class={select}>
            <option value={null} disabled>Choose a prep protocol…</option>
            {#each protocols as p (p)}
              <option value={p} disabled={p !== SUPPORTED_PROTOCOL}>
                {pretty(p)}{p !== SUPPORTED_PROTOCOL ? ' — not in this flow yet' : ''}
              </option>
            {/each}
          </select>
          {@render chevron()}
        </div>
      </div>
      {#if protocol}
        <div>
          <label for="primers" class="block text-sm/6 font-semibold text-gray-900">Primers</label>
          <div class="mt-2 grid grid-cols-1">
            <select id="primers" bind:value={target} class={select}>
              <option value={null} disabled>Choose primers…</option>
              {#each TARGETS as t (t.id)}
                <option value={t.id} disabled={!t.enabled}>{t.label}{t.enabled ? '' : ' — not yet'}</option>
              {/each}
            </select>
            {@render chevron()}
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
          <li class="flex items-start justify-between gap-3 px-4 py-2">
            <span>
              <span class="font-medium text-gray-900">{rack.rackId}</span> <span class="text-gray-500">· {rack.fileName} · {rack.tubes.length} tubes</span>
              {#if rack.problems.length}
                <span class="mt-1 block text-xs text-red-700">Refused; fix the scan and drop it again:</span>
                <span class="block text-xs text-red-700">{rack.problems.slice(0, 4).join(' · ')}{rack.problems.length > 4 ? ` · and ${rack.problems.length - 4} more` : ''}</span>
              {/if}
            </span>
            <button type="button" class="text-xs text-gray-400 hover:text-red-600" onclick={() => (racks = racks.filter((_, i) => i !== r))}>Remove</button>
          </li>
        {/each}
      </ul>
      <div class="mt-4">
        {#if refused.length}
          <p class="text-sm text-red-700">Remove the refused {refused.length === 1 ? 'rack' : 'racks'} or rescan before going on.</p>
        {:else if checking}
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
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h2 class="text-sm/6 font-semibold text-gray-900">Settle what Qiita-miint can't place</h2>
        <button type="button" class={btn} onclick={downloadProblems}>Download the {needFix} tube codes</button>
      </div>
      {@const problemRacks = racks.flatMap((rack, r) => (all.some((x) => x.r === r && problemOf(x.cell)) && !unknownRacks.some((u) => u.r === r) ? [{ rack, r }] : []))}
      {#if problemRacks.length}
        <div class="mt-4 flex flex-wrap gap-4">
          {#each problemRacks as { rack, r } (rack.rackId)}
            <div>
              <p class="mb-1 text-xs font-medium text-gray-700">{rack.rackId}</p>
              <PlateMap wells={wellsOf(r)} />
            </div>
          {/each}
        </div>
      {/if}
      <div class="mt-4 space-y-6">
        {#if unknownRacks.length}
          <!-- Tailwind UI: lists / stacked lists, in a card -->
          <section class="rounded-lg border border-gray-200">
            <div class="border-b border-gray-200 px-4 py-3">
              <h3 class="text-sm font-medium text-gray-900">
                {unknownRacks.length === 1 ? '1 rack belongs' : `${unknownRacks.length} racks belong`} to studies not in Qiita-miint
              </h3>
              <p class="mt-1 text-sm text-gray-500">
                Usual on a run shared with another study. Add the study (or its tube codes) to Qiita-miint and scan
                again, or carry the rack for its sample sheet only.
              </p>
            </div>
            <ul role="list" class="divide-y divide-gray-100 text-sm">
              {#each unknownRacks as u (u.rack.rackId)}
                <li class="flex flex-wrap items-center gap-3 px-4 py-2">
                  <span class="font-medium text-gray-900">{u.rack.rackId}</span>
                  <span class="text-gray-500">{u.n} tubes</span>
                  <span class="ml-auto flex flex-wrap items-center gap-2">
                    <button type="button" class={btn} onclick={() => download(`${u.rack.rackId}-tube-codes.txt`, unknown.filter((x) => x.r === u.r).map((x) => `${x.well}\t${x.tube}`).join('\n'))}>Download the tube codes</button>
                    <a href="/studies" class={btn}>Open studies →</a>
                    <button type="button" class="rounded-md bg-teal-600 px-2.5 py-1 text-xs font-semibold text-white shadow-xs hover:bg-teal-500" onclick={() => { sheetOnly = { ...sheetOnly, [u.rack.rackId]: true }; studyFacts[OTHER] ??= { ...(demo?.otherStudy ?? { project_name: '', project_abbreviation: '', center_project_name: '', experiment_design_description: '' }) }; }}>Sample sheet only</button>
                  </span>
                </li>
              {/each}
            </ul>
          </section>
        {/if}

        {#if looseUnknown.length}
          <section class="rounded-md bg-red-50 p-4">
            <h3 class="text-sm font-medium text-red-800">{looseUnknown.length} stray tubes not in Qiita-miint</h3>
            <p class="mt-1 text-sm text-red-700">A mislabelled tube, a sample not yet registered, or a blank.</p>
            <ul role="list" class="mt-2 divide-y divide-gray-100 rounded-md border border-red-200 bg-white text-sm">
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
          <section class="rounded-md bg-red-50 p-4">
            <h3 class="text-sm font-medium text-red-800">{multi.length} in more than one study</h3>
            <p class="mt-1 text-sm text-red-700">Which study is this prep for?</p>
            <ul role="list" class="mt-2 divide-y divide-gray-100 rounded-md border border-red-200 bg-white text-sm">
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
          <section class="rounded-md bg-red-50 p-4">
            <h3 class="text-sm font-medium text-red-800">Tubes scanned twice</h3>
            <p class="mt-1 text-sm text-red-700">A tube can only be in one well. Keep one, leave the other out.</p>
            <ul role="list" class="mt-2 divide-y divide-gray-100 rounded-md border border-red-200 bg-white text-sm">
              {#each dupes as x (x.r + x.well)}
                <li class="flex flex-wrap items-center gap-3 px-4 py-2">
                  <span class="font-mono text-xs text-gray-700">{racks[x.r].rackId} {x.well}</span>
                  <span class="font-mono text-xs text-gray-500">{x.tube}</span>
                  <span class="text-xs text-gray-500">also at {(x.cell as { other: string }).other}</span>
                  <span class="ml-auto"><button type="button" class={btn} onclick={() => decide(x.r, x.well, { exclude: true })}>Leave this one out</button></span>
                </li>
              {/each}
            </ul>
          </section>
        {/if}
      </div>
    {/if}
  {:else if step === 3}
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 class="text-sm/6 font-semibold text-gray-900">Lay out the plates</h2>
        <p class="mt-1 text-sm text-gray-500">The four positions of the 384-well plate.</p>
      </div>
      <!-- Tailwind UI: forms / toggles / with right label -->
      <label class="flex cursor-pointer items-center gap-3 text-sm">
        <span class="group relative inline-flex w-11 shrink-0 rounded-full bg-gray-200 p-0.5 inset-ring inset-ring-gray-900/5 outline-offset-2 outline-teal-600 transition-colors duration-200 ease-in-out has-checked:bg-teal-600 has-focus-visible:outline-2">
          <span class="size-5 rounded-full bg-white shadow-xs ring-1 ring-gray-900/5 transition-transform duration-200 ease-in-out group-has-checked:translate-x-5"></span>
          <input type="checkbox" bind:checked={editBlanks} aria-label="Edit blanks" class="absolute inset-0 size-full appearance-none focus:outline-hidden" />
        </span>
        <span class="font-medium text-gray-900">Edit blanks</span>
      </label>
    </div>
    <div class="mt-3 flex flex-wrap items-center justify-between gap-3">
      {@render legend()}
      {#if editBlanks}
        <p class="text-xs text-teal-700">Click a sample to make it a blank, or a changed well to undo.</p>
      {/if}
    </div>
    {#if blanksChanged}
      <p class="mt-2 text-xs text-amber-700">
        {blanksChanged} {blanksChanged === 1 ? 'blank' : 'blanks'} changed from the scan ·
        <button type="button" class="font-medium underline hover:text-amber-900" onclick={() => (blankEdits = {})}>reset</button>
      </p>
    {/if}
    <div class="mt-4 grid grid-cols-1 gap-6 xl:grid-cols-2">
      {#each [0, 1, 2, 3] as i}
        <div class="rounded-lg border border-gray-200 p-3">
          <div class="mb-2 flex flex-wrap items-center gap-3 text-sm">
            <span class="font-semibold text-gray-900">Position {i + 1}</span>
            <div class="grid w-32 grid-cols-1">
              <select aria-label="Rack at position {i + 1}" class={select} bind:value={rackAt[i]}>
                <option value={null}>— empty —</option>
                {#each racks as rack, r}<option value={r}>{rack.rackId}</option>{/each}
              </select>
              {@render chevron()}
            </div>
            <label class="ml-auto flex items-center gap-2 text-xs text-gray-600">Primer plate
              <span class="grid w-20 grid-cols-1">
                <select class={select} bind:value={primerAt[i]}>
                  {#each Array.from({ length: 10 }, (_, k) => String(k + 1)) as n}<option>{n}</option>{/each}
                </select>
                {@render chevron()}
              </span>
            </label>
          </div>
          <div class="inline-block rounded-xl {editBlanks ? 'ring-2 ring-teal-500 ring-offset-2' : ''}">
            <PlateMap wells={wellsOf(rackAt[i])} onpick={editBlanks ? (w) => rackAt[i] !== null && toggleBlank(rackAt[i]!, w) : undefined} />
          </div>
          {#if rackAt[i] !== null}
            {@const r = rackAt[i]!}
            {@const studies = studiesOfRack(r)}
            <p class="mt-1 text-xs {blanksOn(r) ? 'text-gray-500' : 'text-amber-700'}">
              {studies.length ? studies.map(titleOf).join(' + ') : 'no samples'} · {blanksOn(r) ? `${blanksOn(r)} blanks` : 'no blank on this plate — is that right?'}
            </p>
            {#if studies.length > 1 && blanksOn(r)}
              <label class="mt-2 flex flex-wrap items-center gap-2 text-xs {blanksTo[racks[r].rackId] ? 'text-gray-600' : 'text-red-700'}">
                This plate mixes studies. Its blanks go to
                <span class="grid min-w-48 grid-cols-1">
                  <select aria-label="Blanks of {racks[r].rackId} go to" class="{select} {blanksTo[racks[r].rackId] ? '' : 'outline-red-400'}" bind:value={blanksTo[racks[r].rackId]}>
                    <option value={undefined} disabled>choose…</option>
                    {#each studies as k}<option value={k}>{titleOf(k)}</option>{/each}
                    <option value={EACH}>each study's sheet</option>
                  </select>
                  {@render chevron()}
                </span>
              </label>
            {/if}
          {/if}
        </div>
      {/each}
    </div>
    {#if blanks.length < MIN_BLANKS}
      <p class="mt-3 text-sm text-amber-700">Only {blanks.length} blanks on this run; at least {MIN_BLANKS} are recommended.</p>
    {/if}
    {#if layoutProblems.length}<p class="mt-3 text-sm text-red-700">{layoutProblems.join(' · ')}</p>{/if}
  {:else if step === 4}
    <h2 class="text-sm/6 font-semibold text-gray-900">Processing details</h2>
    <p class="mt-1 text-sm text-gray-500">Recorded with every sample. Write not_applicable for anything that doesn't apply.</p>
    {#if prefilled && last}
      <p class="mt-2 text-xs text-teal-700">Lots, tools and robots are filled from your last prep ({last.when}); check them against today's.</p>
    {/if}
    <div class="mt-4 overflow-x-auto">
      <table class="min-w-full text-sm">
        <thead>
          <tr class="text-left text-xs text-gray-500">
            <th class="w-40 py-2 pr-3 font-medium"></th>
            {#each placed as { r, position }}<th class="px-2 py-2 font-medium whitespace-nowrap">Position {position} · {racks[r].rackId}</th>{/each}
            <th class="w-28"></th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-100">
          {#each PLATE_COLUMNS.filter(([k]) => k !== 'primer_plate') as [col, label]}
            {@const firstFacts = placedFacts()[0]}
            <tr>
              <th scope="row" class="py-1.5 pr-3 text-left text-xs font-medium whitespace-nowrap text-gray-700">{label}</th>
              {#if isSplit(col)}
                {#each placed as { r }}
                  {@const id = racks[r].rackId}
                  <td class="px-2 py-1.5">
                    {#if plateFacts[id]}
                      <input aria-label="{label} for {id}" class="{input} {plateFacts[id][col].trim() ? 'outline-gray-300' : 'outline-red-300'}" bind:value={plateFacts[id][col]} />
                    {/if}
                  </td>
                {/each}
                <td class="pl-1 text-right"><button type="button" class="text-xs whitespace-nowrap text-teal-700 hover:underline" title="Use the first plate's value on every plate" onclick={() => sameForAll(col)}>same for all</button></td>
              {:else}
                <td class="px-2 py-1.5" colspan={placed.length}>
                  {#if firstFacts}
                    <input aria-label="{label} for every plate" class="{input} {firstFacts[col].trim() ? 'outline-gray-300' : 'outline-red-300'}" value={firstFacts[col]} oninput={(e) => setAll(col, e.currentTarget.value)} />
                  {/if}
                </td>
                <td class="pl-1 text-right">
                  {#if placed.length > 1}<button type="button" class="text-xs whitespace-nowrap text-gray-500 hover:text-teal-700 hover:underline" onclick={() => (splitRows = { ...splitRows, [col]: true })}>differs by plate</button>{/if}
                </td>
              {/if}
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
          {#if studyFacts[k] && k !== OTHER}
            <dl class="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
              {#each STUDY_COLUMNS as [col, label]}
                <div class={col === 'experiment_design_description' ? 'col-span-2' : ''}>
                  <dt class="text-xs text-gray-500">{label}</dt>
                  <dd class="text-gray-900">{studyFacts[k][col] || '—'}</dd>
                </div>
              {/each}
            </dl>
            <p class="mt-2 text-xs text-gray-400">From Qiita-miint; change it on the study.</p>
          {:else if studyFacts[k]}
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
      <label class="text-xs text-gray-600">Instrument
        <span class="mt-0.5 grid grid-cols-1">
          <select class={select} bind:value={run.instrument_model}>
            <option value="" disabled>Choose…</option>
            {#each instruments as m}<option value={m}>{m}</option>{/each}
          </select>
          {@render chevron()}
        </span>
      </label>
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
    <div class="mt-6 flex flex-wrap items-start gap-6">
      <PlateMap format={384} wells={plate384} />
      <div class="max-w-48">{@render legend()}<p class="mt-3 text-xs text-gray-400">Hover a well for its sample, tube code and barcode.</p></div>
    </div>
    {#if barcodeIssues.length}
      <ul class="mt-4 space-y-1 text-sm text-red-700">{#each barcodeIssues as t}<li>{t}</li>{/each}</ul>
    {:else}
      <p class="mt-4 text-sm text-gray-600">{Object.keys(plate384).length} wells, each with its own Golay barcode.</p>
    {/if}
    {#if built}
      <!-- Tailwind UI: feedback / alerts / with actions -->
      <div class="mt-4 rounded-md bg-green-50 p-4">
        <h3 class="text-sm font-medium text-green-800">Pre-flight ready</h3>
        <p class="mt-2 text-sm text-green-700">kl-run-preflight built <span class="font-mono text-xs">{preflightName}</span> from the {sheets.length} sheets. The sequencing step submits with it.</p>
        <div class="mt-3 -mx-2 -my-1.5 flex">
          <button type="button" class="rounded-md bg-green-50 px-2 py-1.5 text-sm font-medium text-green-800 hover:bg-green-100 disabled:opacity-50" disabled title="Built by kl-run-preflight on the server in the real flow">Download {preflightName}</button>
        </div>
      </div>
    {/if}
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
            <li class="flex items-center gap-2"><span class="size-2 rounded-full bg-blue-500"></span>golay-demux — queued with {preflightName}: {new Set(sheetWells.filter((w) => w.study !== OTHER).map((w) => w.well384)).size} Qiita-miint wells</li>
            <li class="flex items-center gap-2"><span class="size-2 rounded-full bg-gray-300"></span>amplicon — starts when demux completes (trim 150, deblur → ASVs → feature table)</li>
          </ol>
        {/if}
      </div>
    {/if}
  {/if}

  <div class="mt-8 flex items-center justify-between border-t border-gray-100 pt-4">
    <button type="button" class="rounded-md bg-white px-3 py-2 text-sm font-semibold text-gray-900 shadow-xs ring-1 ring-gray-300 ring-inset hover:bg-gray-50 disabled:invisible" disabled={step === 0} onclick={() => go(step - 1)}>Back</button>
    {#if step < STEPS.length - 1}
      {#if step === 5 && !built}
        <button type="button" class="rounded-md bg-teal-600 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-teal-500 disabled:opacity-40" disabled={barcodeIssues.length > 0} onclick={() => ((built = true), saveLast())}>Build pre-flight</button>
      {:else}
        <button type="button" class="rounded-md bg-teal-600 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-teal-500 disabled:opacity-40" disabled={!canLeave[step]} onclick={() => go(nextStep)}>Next: {STEPS[nextStep]}</button>
      {/if}
    {/if}
  </div>
</div>
