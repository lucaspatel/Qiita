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
  import Modal from '$lib/ui/Modal.svelte';
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
    emptySheet,
    type Plate,
    type RunFacts,
    type StudyFacts
  } from '$lib/libraryPrep/sampleSheet';
  import {
    deleteDraft,
    listDrafts,
    loadDraft,
    newDraftId,
    saveDraft,
    type DraftMeta
  } from '$lib/libraryPrep/drafts';
  import * as lr from '$lib/libraryPrep/longRead';
  import type {
    PoolSample as LrSample,
    Protocol as LrProtocol,
    RunFacts as LrRunFacts
  } from '$lib/libraryPrep/longRead';

  // Flow bars by protocol. The short-read flow lays out plates and Golay-demuxes;
  // the long-read flow is a multiplexed PacBio pool, demuxed upstream, authored
  // straight into a pre-flight. Selecting the protocol reshapes the bar in place.
  // Short-read folds scanning, fixing and plate layout into one quadrant screen.
  const SHORT_STEPS = ['Protocol', 'Plates', 'Details', 'Pre-flight', 'Sequence'];
  const LONG_STEPS = ['Protocol', 'Pool', 'Barcodes', 'Details', 'Pre-flight', 'Sequence'];
  let step = $state(0);
  let reached = $state(0);
  const go = (i: number) => {
    step = i;
    reached = Math.max(reached, i);
  };

  // --- 1. protocol ---
  const SUPPORTED_PROTOCOL = 'short_read_amplicon';
  const LONGREAD_PROTOCOL = 'long_read_amplicon';
  const isEnabledProtocol = (p: string) => p === SUPPORTED_PROTOCOL || p === LONGREAD_PROTOCOL;
  let protocols = $state<string[]>([SUPPORTED_PROTOCOL, LONGREAD_PROTOCOL]);
  // The long-read flow exists, so always offer it as an entry point even if the
  // catalog has no protocol row for it yet; the catalog's own protocols fill in
  // the rest (short-read enabled, others shown but not in this flow).
  const withFlows = (names: string[]) =>
    [...new Set([SUPPORTED_PROTOCOL, LONGREAD_PROTOCOL, ...names])].sort(
      (a, b) => Number(isEnabledProtocol(b)) - Number(isEnabledProtocol(a))
    );
  $effect(() => {
    api.prepProtocols().then((r) => {
      if (r.ok && r.data.length)
        protocols = withFlows(r.data.filter((p: PrepProtocol) => !p.retired).map((p) => p.name));
    });
  });
  let protocol = $state<string | null>(null);
  // Picking a protocol reshapes the flow bar and restarts at step 0 (Protocol).
  const pickProtocol = () => {
    target = null;
    step = 0;
    reached = 0;
  };
  const TARGETS = [
    { id: '16S', label: '16S V4 · 515fbc / 806r (EMP Golay)', enabled: true },
    { id: '18S', label: '18S · 1391f / EukBr', enabled: false },
    { id: 'ITS', label: 'ITS · ITS1f / ITS2', enabled: false }
  ];
  const LONGREAD_TARGETS = [
    { id: 'full_16s', label: 'Full-length 16S · 27F / 1492R (UMI-tagged)', enabled: true }
  ];
  let target = $state<string | null>(null);

  // --- long-read flow state (steps 1–5 when the long-read protocol is picked) ---
  let lrPool = $state<LrSample[]>([]);
  const lrScanned = $derived(lrPool.length > 0);
  const lrProblems = $derived(lr.poolProblems(lrPool));
  let lrDetails = $state<LrProtocol>({ ...lr.PROTOCOL_FULL_16S });
  let lrRun = $state<LrRunFacts>({ ...lr.DEMO_RUN });
  let lrBuilt = $state(false);
  let lrStarted = $state(false);
  const lrPreflightName = $derived(
    lrRun.movie_context ? `${lrRun.movie_context}.preflight.db` : 'run.preflight.db'
  );
  const lrPreview = $derived(lr.builderPreview(lrPool, lrDetails, lrRun));
  const lrTitleOf = (k: string) => (k === lr.OTHER ? 'Not in Qiita-miint' : (lr.STUDIES[k]?.title ?? k));
  const lrColorOf = (k: string) => (k === lr.OTHER ? '#9ca3af' : (lr.STUDIES[k]?.color ?? '#9ca3af'));
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
  let dragQuad = $state<number | null>(null); // the quadrant a scan is being dragged over
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
  // Per-quadrant scan: a rack is dropped onto one position, placed there directly.
  async function dropToQuadrant(i: number, files: FileList | null) {
    if (!files?.length) return;
    demo ??= demoBox();
    const parsed = await parseVisionMate(files[0].name, await files[0].text());
    racks = [...racks, parsed];
    rackAt[i] = racks.length - 1;
    check();
  }
  // Load a demo rack into one quadrant (the next demo rack not already placed).
  function demoToQuadrant(i: number) {
    demo ??= demoBox();
    const placedIds = new Set(rackAt.flatMap((r) => (r === null ? [] : [racks[r]?.rackId])));
    const next = demo.racks.find((dr) => !placedIds.has(dr.rackId) && !racks.some((x) => x.rackId === dr.rackId));
    const rack = next ?? demo.racks[i] ?? demoBox().racks[i];
    racks = [...racks, rack];
    rackAt[i] = racks.length - 1;
    check();
  }
  // Clear a quadrant: drop its rack entirely and renumber everything keyed by rack
  // index (rackAt, and the r:well decision records) so nothing dangles.
  function clearQuadrant(i: number) {
    const r0 = rackAt[i];
    if (r0 === null) return;
    racks = racks.filter((_, r) => r !== r0);
    rackAt = rackAt.map((r) => (r === r0 ? null : r !== null && r > r0 ? r - 1 : r));
    const remap = <T,>(rec: Record<string, T>): Record<string, T> =>
      Object.fromEntries(
        Object.entries(rec).flatMap(([k, v]) => {
          const [r, well] = k.split(':');
          const ri = Number(r);
          return ri === r0 ? [] : [[`${ri > r0 ? ri - 1 : ri}:${well}`, v]];
        })
      );
    decisions = remap(decisions);
    blankEdits = remap(blankEdits);
  }

  // Everything that needs settling, across all four quadrants, as one flat list:
  // a whole rack whose study is unknown, a stray unknown tube, a tube in several
  // studies, a tube scanned twice, and a mixed-study plate whose blanks are
  // unassigned. Rendered as a paginated list below the plates.
  type Attn =
    | { kind: 'unknown-rack'; r: number; rackId: string; n: number }
    | { kind: 'unknown'; r: number; well: string; tube: string }
    | { kind: 'multi'; r: number; well: string; studies: number[] }
    | { kind: 'duplicate'; r: number; well: string; other: string }
    | { kind: 'mixed-blank'; r: number; rackId: string; studies: string[] };
  const attention = $derived.by<Attn[]>(() => {
    const out: Attn[] = [];
    for (const u of unknownRacks) out.push({ kind: 'unknown-rack', r: u.r, rackId: u.rack.rackId, n: u.n });
    for (const x of looseUnknown) out.push({ kind: 'unknown', r: x.r, well: x.well, tube: x.tube });
    for (const x of multi) out.push({ kind: 'multi', r: x.r, well: x.well, studies: (x.cell as { studies: number[] }).studies });
    for (const x of dupes) out.push({ kind: 'duplicate', r: x.r, well: x.well, other: (x.cell as { other: string }).other });
    for (const { rack, r } of mixedRacks) if (!blanksTo[rack.rackId]) out.push({ kind: 'mixed-blank', r, rackId: rack.rackId, studies: studiesOfRack(r) });
    return out;
  });
  const ERR_PER_PAGE = 10;
  let errPage = $state(0);
  const errPages = $derived(Math.max(1, Math.ceil(attention.length / ERR_PER_PAGE)));
  const errView = $derived(attention.slice(errPage * ERR_PER_PAGE, errPage * ERR_PER_PAGE + ERR_PER_PAGE));
  $effect(() => {
    if (errPage >= errPages) errPage = errPages - 1; // clamp when the list shrinks as items settle
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
        fileName: `${run.run_date.replaceAll('-', '') || 'YYYYMMDD'}_IL515fBC_806_${f?.project_name || key}_Plates_${plateNos}.txt`,
        // Always build the sheet — a mid-prep checkpoint leaves unentered facts blank
        // rather than dropping the study.
        text: buildSheet(wells, f ?? {}, run)
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
  // The checkpoint files: each study's sheet, or a header-only sheet before anything
  // is scanned — so there is always something to download that mirrors the format.
  const checkpointFiles = $derived.by(() => {
    const files = sheets.map((s) => ({ name: s.fileName, text: s.text }));
    if (files.length) return files;
    const stamp = run.run_date.replaceAll('-', '') || 'YYYYMMDD';
    return [{ name: `${stamp}_IL515fBC_806_prep.txt`, text: emptySheet() }];
  });

  // --- 7. sequence ---
  let runFolder = $state<string | null>(null);
  let started = $state(false);

  // Short-read: Protocol, Plates (scan + fix + lay out, merged), Details, Pre-flight, Sequence.
  const shortCanLeave = $derived([
    !!protocol && !!target,
    racks.length > 0 && !checking && refused.length === 0 && needFix === 0 && layoutProblems.length === 0,
    errors.length === 0 && studyErrors.length === 0,
    built,
    true
  ]);
  // Long-read: Protocol, Pool, Barcodes, Details, Pre-flight, Sequence.
  const longCanLeave = $derived([
    !!protocol && !!target,
    lrScanned,
    lrProblems.length === 0,
    !!(lrDetails.fwd_primer && lrDetails.rev_primer && lrDetails.umi_pattern),
    lrBuilt,
    true
  ]);

  // Flow registry: a protocol maps to its flow — the step bar, its primer options,
  // the per-step "can advance" gates, and where/how the pre-flight is built. A new
  // modality is one entry here plus its body branch below; the control logic
  // (stepper, nav, build button) is flow-agnostic and never tests a protocol name.
  type PrimerOption = { id: string; label: string; enabled: boolean };
  type Flow = {
    steps: string[];
    targets: PrimerOption[];
    canLeave: boolean[];
    next: (s: number) => number;
    build: { at: number; done: boolean; disabled: boolean; run: () => void };
    // A backup of the work so far as the pre-prep file(s) the amplicon notebook
    // (kl-metapool's generate_qiita_prep_file) would write — one per study, as
    // much as the current state can fill. Empty when there is nothing to write.
    checkpoint: { name: string; text: string }[];
  };
  const FLOWS: Record<string, Flow> = $derived({
    [SUPPORTED_PROTOCOL]: {
      steps: SHORT_STEPS,
      targets: TARGETS,
      canLeave: shortCanLeave,
      next: (s) => s + 1,
      build: {
        at: 3,
        done: built,
        disabled: barcodeIssues.length > 0,
        run: () => {
          built = true;
          saveLast();
        }
      },
      checkpoint: checkpointFiles
    },
    [LONGREAD_PROTOCOL]: {
      steps: LONG_STEPS,
      targets: LONGREAD_TARGETS,
      canLeave: longCanLeave,
      next: (s) => s + 1,
      build: {
        at: 4,
        done: lrBuilt,
        disabled: lrProblems.length > 0,
        run: () => (lrBuilt = true)
      },
      // The long-read flow authors straight into a pre-flight, not a notebook
      // pre-prep, so there is no checkpoint file to write.
      checkpoint: []
    }
  });
  const flow = $derived(FLOWS[protocol ?? SUPPORTED_PROTOCOL]);
  // Save the pre-prep file(s) as they stand right now — a backup at any step.
  const downloadCheckpoint = () => flow.checkpoint.forEach((f) => download(f.name, f.text));
  const steps = $derived(flow.steps);
  const targets = $derived(flow.targets);
  const canLeave = $derived(flow.canLeave);
  const nextStep = $derived(flow.next(step));

  const btn = 'rounded-md bg-white px-2.5 py-1 text-xs font-semibold text-gray-900 shadow-xs ring-1 ring-gray-300 ring-inset hover:bg-gray-50';
  /** Tailwind UI: forms / select menus / simple native (the chevron is `chevron`). */
  const select =
    'col-start-1 row-start-1 w-full appearance-none rounded-md bg-white py-1.5 pr-8 pl-3 text-base text-gray-900 outline-1 -outline-offset-1 outline-gray-300 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-teal-600 sm:text-sm/6';
  /** Tailwind UI: forms / input groups / simple, the same size as `select`. */
  const field =
    'block w-full rounded-md bg-white px-3 py-1.5 text-base text-gray-900 outline-1 -outline-offset-1 outline-gray-300 focus:outline-2 focus:-outline-offset-2 focus:outline-teal-600 sm:text-sm/6';
  /** The sheet writes the plate map date as the scanner does (YYYYMMDD); a date
   *  input reads and writes YYYY-MM-DD. */
  const isoDate = (d: string) => d.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
  const input = 'block w-full rounded-md bg-white px-2 py-1 text-sm text-gray-900 outline-1 -outline-offset-1 focus:outline-2 focus:-outline-offset-2 focus:outline-teal-600';

  // --- draft cache: many in-progress preps, resumable from the main page --------
  // Each prep is its own localStorage entry; the main page (step 0) lists them all.
  // A prep is scratch until submitted — then its draft is deleted (the server's
  // run/pool become the truth, content-addressed so a resumed draft converges).
  // `demo` holds Maps and is reconstructed via demoBox(), not stored.
  const hasProgress = $derived(step > 0 || racks.length > 0 || lrPool.length > 0);
  const submitted = $derived(started || lrStarted);
  let currentId = $state<string | null>(null);
  let drafts = $state<DraftMeta[]>([]);
  const refreshDrafts = () => (drafts = listDrafts());
  const relTime = (ms: number) => {
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  };

  function snapshot() {
    return {
      protocol, target, step, reached, demoLoaded: demo !== null,
      racks, decisions, sheetOnly, blankEdits, editBlanks, plateFacts, studyFacts, run, built, started,
      lrPool, lrDetails, lrRun, lrBuilt, lrStarted
    };
  }

  // A short, human summary for the list: the protocol plus where it's at.
  const draftLabel = $derived.by(() => {
    const p = protocol ? pretty(protocol) : 'Prep';
    if (protocol === LONGREAD_PROTOCOL) return `${p} · ${lrPool.length} samples`;
    const plates = rackAt.filter((r) => r !== null).length;
    return `${p} · ${plates} ${plates === 1 ? 'plate' : 'plates'}`;
  });

  function applySnapshot(d: Record<string, unknown>) {
    protocol = d.protocol as string | null;
    target = d.target as string | null;
    step = d.step as number;
    reached = d.reached as number;
    racks = d.racks as typeof racks;
    decisions = d.decisions as typeof decisions;
    sheetOnly = d.sheetOnly as typeof sheetOnly;
    blankEdits = d.blankEdits as typeof blankEdits;
    editBlanks = d.editBlanks as boolean;
    plateFacts = d.plateFacts as typeof plateFacts;
    studyFacts = d.studyFacts as typeof studyFacts;
    run = d.run as typeof run;
    built = d.built as boolean;
    started = d.started as boolean;
    lrPool = d.lrPool as typeof lrPool;
    lrDetails = d.lrDetails as typeof lrDetails;
    lrRun = d.lrRun as typeof lrRun;
    lrBuilt = d.lrBuilt as boolean;
    lrStarted = d.lrStarted as boolean;
    if (d.demoLoaded) demo = demoBox(); // reconstruct the mock Qiita-miint (Maps don't serialize)
  }

  function resumeDraft(id: string) {
    const d = loadDraft(id);
    if (!d) {
      refreshDrafts();
      return;
    }
    applySnapshot(d as Record<string, unknown>);
    currentId = id;
  }

  // Deleting a draft goes through a confirmation modal.
  let pendingDiscard = $state<DraftMeta | null>(null);
  let discardOpen = $state(false);
  const askDiscard = (meta: DraftMeta) => ((pendingDiscard = meta), (discardOpen = true));
  function confirmDiscard() {
    if (!pendingDiscard) return;
    const id = pendingDiscard.id;
    deleteDraft(id);
    if (id === currentId) currentId = null;
    discardOpen = false;
    pendingDiscard = null;
    refreshDrafts();
  }

  // Autosave the current prep under its id (minting one on first progress), and
  // delete it once submitted. Only runs in the browser.
  $effect(() => {
    const snap = snapshot(); // reads every field → runs on any change
    if (submitted) {
      if (currentId) {
        deleteDraft(currentId);
        refreshDrafts();
      }
      return;
    }
    if (!hasProgress) return;
    currentId ??= newDraftId();
    saveDraft({ id: currentId, protocol: protocol ?? '', label: draftLabel, step, updatedAt: Date.now() }, snap);
    refreshDrafts();
  });

  // Populate the list on load (nothing is auto-resumed; the user picks).
  $effect(() => {
    refreshDrafts();
  });
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

{#snippet lrField(label: string, value: string, set: (v: string) => void, mono = false)}
  <label class="block">
    <span class="block text-sm/6 font-medium text-gray-900">{label}</span>
    <input class="{field} {mono ? 'font-mono text-xs' : ''}" {value} oninput={(e) => set(e.currentTarget.value)} />
  </label>
{/snippet}

<div class="mb-6">
  <div class="flex items-center justify-between gap-3">
    <h1 class="text-2xl/7 font-bold text-gray-900">Library prep</h1>
    <span class="inline-flex rounded-md bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800 ring-1 ring-amber-600/20 ring-inset">Mockup</span>
  </div>
  <p class="mt-1 text-sm text-gray-500">From a box of tubes to a running amplicon workflow.</p>
  {#if currentId && !submitted}
    <p class="mt-2 text-xs text-gray-500">Editing a saved prep · <button type="button" class="font-medium text-blue-700 underline hover:text-blue-900" onclick={() => askDiscard(drafts.find((d) => d.id === currentId) ?? { id: currentId!, protocol: protocol ?? '', label: draftLabel, step, updatedAt: Date.now() })}>discard</button></p>
  {/if}
</div>

<!-- Steps (Tailwind UI: navigation / progress bars / panels) -->
<nav aria-label="Progress" class="mb-6">
  <ol role="list" class="divide-y divide-gray-300 rounded-md border border-gray-300 bg-white md:flex md:divide-y-0">
    {#each steps as label, i}
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
        {#if i < steps.length - 1}
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
          <select
            id="protocol"
            bind:value={protocol}
            class={select}
            onchange={pickProtocol}
          >
            <option value={null} disabled>Choose a prep protocol…</option>
            {#each protocols as p (p)}
              <option value={p} disabled={!isEnabledProtocol(p)}>
                {pretty(p)}{isEnabledProtocol(p) ? '' : ' — not in this flow yet'}
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
              {#each targets as t (t.id)}
                <option value={t.id} disabled={!t.enabled}>{t.label}{t.enabled ? '' : ' — not yet'}</option>
              {/each}
            </select>
            {@render chevron()}
          </div>
        </div>
      {/if}
    </div>

    {#if drafts.filter((d) => d.id !== currentId).length}
      <div class="mt-8 max-w-2xl">
        <h2 class="text-sm font-semibold text-gray-900">In-progress preps</h2>
        <p class="mt-1 text-xs text-gray-500">Saved in this browser. Resume where you left off, or discard.</p>
        <ul role="list" class="mt-3 divide-y divide-gray-100 rounded-md border border-gray-200 text-sm">
          {#each drafts.filter((d) => d.id !== currentId) as d (d.id)}
            <li class="flex flex-wrap items-center gap-3 px-4 py-2.5">
              <span class="font-medium text-gray-900">{d.label}</span>
              <span class="text-xs text-gray-500">step {d.step + 1} · {relTime(d.updatedAt)}</span>
              <span class="ml-auto flex gap-2">
                <button type="button" class="rounded-md bg-teal-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-teal-500" onclick={() => resumeDraft(d.id)}>Resume</button>
                <button type="button" class="rounded-md bg-white px-2.5 py-1 text-xs font-semibold text-gray-700 ring-1 ring-gray-300 ring-inset hover:bg-gray-50" onclick={() => askDiscard(d)}>Discard</button>
              </span>
            </li>
          {/each}
        </ul>
      </div>
    {/if}
  {:else if protocol === LONGREAD_PROTOCOL}
    <!-- Long-read (PacBio) flow body. Each flow owns its step bodies; a third
         modality adds its own branch here and its entry in FLOWS above. -->
    {#if step === 1}
      <h2 class="text-sm/6 font-semibold text-gray-900">The pool</h2>
      <p class="mt-1 text-sm text-gray-500">
        The barcode map from the bench: one PacBio barcode per sample, demultiplexed upstream in SMRTlink. Each tube
        is checked against Qiita-miint as it lands — a tube may repeat as a technical replicate.
      </p>
      {#if !lrScanned}
        <div class="mt-4 rounded-lg border-2 border-dashed border-gray-300 p-8 text-center">
          <p class="text-sm font-semibold text-gray-900">Drop the barcode map, or</p>
          <p class="mt-1 text-xs text-gray-500">
            <button type="button" class="font-medium text-teal-700 hover:text-teal-600" onclick={() => (lrPool = lr.DEMO_POOL.map((s) => ({ ...s })))}>use the demo pool</button>
          </p>
        </div>
      {:else}
        <ul role="list" class="mt-4 divide-y divide-gray-100 rounded-md border border-gray-200 text-sm">
          {#each lrPool as s (s.sample_name)}
            <li class="flex flex-wrap items-center gap-3 px-4 py-2">
              <span class="size-2.5 rounded-full" style="background:{lrColorOf(s.study ?? lr.OTHER)}"></span>
              <span class="font-medium text-gray-900">{s.sample_name}</span>
              <span class="font-mono text-xs text-gray-500">{s.barcode_id}</span>
              <span class="font-mono text-xs text-gray-400">tube {s.tube}</span>
              {#if s.sample_type === 'control'}<span class="rounded bg-gray-100 px-1.5 text-xs text-gray-600">blank</span>{/if}
              <span class="ml-auto text-xs text-gray-500">{lrTitleOf(s.study ?? lr.OTHER)}</span>
            </li>
          {/each}
        </ul>
        <p class="mt-3 text-sm text-gray-600">{lrPool.length} samples · {new Set(lrPool.map((s) => s.study)).size} studies.</p>
      {/if}
    {:else if step === 2}
      <h2 class="text-sm/6 font-semibold text-gray-900">Barcodes</h2>
      <p class="mt-1 text-sm text-gray-500">Each PacBio barcode must demultiplex exactly one sample. No Golay, no plate map — the demux is upstream.</p>
      <ul role="list" class="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {#each lrPool as s (s.sample_name)}
          <li class="flex items-center gap-2 rounded-md border border-gray-200 px-3 py-2 text-sm">
            <span class="font-mono text-xs text-gray-900">{s.barcode_id}</span>
            <span class="ml-auto truncate text-xs text-gray-500">{s.sample_name}</span>
          </li>
        {/each}
      </ul>
      {#if lrProblems.length}
        <ul class="mt-4 space-y-1 text-sm text-red-700">{#each lrProblems as t}<li>{t}</li>{/each}</ul>
      {:else}
        <p class="mt-4 text-sm text-gray-600">{lrPool.length} barcodes, each demultiplexing one sample.</p>
      {/if}
    {:else if step === 3}
      <h2 class="text-sm/6 font-semibold text-gray-900">Protocol & run details</h2>
      <p class="mt-1 text-sm text-gray-500">
        The only per-run facts the pre-flight needs beyond a normal PacBio run: the primers, the UMI pattern, and the
        target region. Everything downstream (quality/length cutoffs, clustering, variant support) is processing config,
        not pre-flight.
      </p>
      <div class="mt-4 grid max-w-3xl grid-cols-1 gap-4 sm:grid-cols-2">
        {@render lrField('Forward primer (27F)', lrDetails.fwd_primer, (v) => (lrDetails.fwd_primer = v), true)}
        {@render lrField('Reverse primer (1492R)', lrDetails.rev_primer, (v) => (lrDetails.rev_primer = v), true)}
        {@render lrField("5' construct primer", lrDetails.five_prime_primer, (v) => (lrDetails.five_prime_primer = v), true)}
        {@render lrField("3' construct primer", lrDetails.three_prime_primer, (v) => (lrDetails.three_prime_primer = v), true)}
        {@render lrField('UMI pattern', lrDetails.umi_pattern, (v) => (lrDetails.umi_pattern = v), true)}
        {@render lrField('Target subfragment', lrDetails.target_subfragment, (v) => (lrDetails.target_subfragment = v))}
      </div>
      <h3 class="mt-6 text-sm font-medium text-gray-900">Revio run</h3>
      <div class="mt-2 grid max-w-3xl grid-cols-1 gap-4 sm:grid-cols-2">
        {@render lrField('Instrument', lrRun.instrument_model, (v) => (lrRun.instrument_model = v))}
        {@render lrField('SMRT cell well', lrRun.smrt_cell_well, (v) => (lrRun.smrt_cell_well = v), true)}
        {@render lrField('Movie context', lrRun.movie_context, (v) => (lrRun.movie_context = v), true)}
        <label class="block">
          <span class="block text-sm/6 font-medium text-gray-900">Run date</span>
          <input type="date" class={field} bind:value={lrRun.run_date} />
        </label>
      </div>
    {:else if step === 4}
      <h2 class="text-sm/6 font-semibold text-gray-900">Build the pre-flight</h2>
      <p class="mt-1 text-sm text-gray-500">
        Authored <span class="font-medium text-gray-700">directly</span> — no pre-prep sheet to launder. The control
        plane calls kl-run-preflight's typed builders with these fields and stores the pre-flight blob the ingest submits with.
      </p>
      <details class="mt-4" open>
        <summary class="cursor-pointer text-xs text-teal-700">The builder calls the server would make</summary>
        <pre class="mt-2 max-h-80 overflow-auto rounded bg-gray-50 p-3 text-[11px] leading-4">{lrPreview}</pre>
      </details>
      {#if lrBuilt}
        <div class="mt-4 rounded-md bg-green-50 p-4">
          <h3 class="text-sm font-medium text-green-800">Pre-flight ready</h3>
          <p class="mt-2 text-sm text-green-700">kl-run-preflight authored <span class="font-mono text-xs">{lrPreflightName}</span> from {lrPool.length} samples. The sequencing step submits with it.</p>
        </div>
      {/if}
    {:else if step === 5}
      <h2 class="text-sm/6 font-semibold text-gray-900">Sequence</h2>
      <p class="mt-1 text-sm text-gray-500">The pool is already demultiplexed (SMRTlink), so ingest loads one BAM per barcode — the existing PacBio path.</p>
      <div class="mt-4">
        {#if !lrStarted}
          <button type="button" class="rounded-md bg-teal-600 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-teal-500" onclick={() => (lrStarted = true)}>Start PacBio ingest</button>
        {:else}
          <ol class="space-y-2 text-sm">
            <li class="flex items-center gap-2"><span class="size-2 rounded-full bg-blue-500"></span>pacbio-ingest — queued with {lrPreflightName}: {lrPool.length} per-barcode BAMs fan out to bam-to-parquet</li>
            <li class="flex items-center gap-2"><span class="size-2 rounded-full bg-gray-300"></span>rrna-operon — UMI detection, dechimera, clustering (processing, not yet wired into Qiita)</li>
          </ol>
        {/if}
      </div>
    {/if}
  {:else if step === 1}
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 class="text-sm/6 font-semibold text-gray-900">Lay out the plates</h2>
        <p class="mt-1 text-sm text-gray-500">Drop each rack's VisionMate scan onto its quadrant of the 384-well plate. Tubes are checked against Qiita-miint as they land; settle anything flagged in the list below.</p>
      </div>
      <label class="flex cursor-pointer items-center gap-3 text-sm">
        <span class="text-gray-600">Edit blanks</span>
        <input type="checkbox" class="size-4 accent-teal-600" bind:checked={editBlanks} />
      </label>
    </div>
    {#if editBlanks}<p class="mt-2 text-xs text-teal-700">Click a sample to make it a blank, or a changed well to undo.</p>{/if}
    {#if blanksChanged}<p class="mt-2 text-xs text-amber-700">{blanksChanged} {blanksChanged === 1 ? 'blank' : 'blanks'} changed from the scan · <button type="button" class="font-medium underline hover:text-amber-900" onclick={() => (blankEdits = {})}>reset</button></p>{/if}

    <!-- The four 96-well racks laid out as the 384-well plate itself: 1-2 top, 3-4
         bottom. Two plates fill the width; each PlateMap scales to its column. -->
    <div class="mt-4 grid grid-cols-2 gap-x-6 gap-y-5">
      {#each [0, 1, 2, 3] as i}
        {#if rackAt[i] === null}
          <div
            role="region"
            aria-label="Drop rack for plate {i + 1}"
            class="flex min-h-60 w-full flex-col items-center justify-center rounded-md border-2 border-dashed p-3 text-center transition {dragQuad === i ? 'border-teal-500 bg-teal-50' : 'border-gray-300'}"
            ondragover={(e) => (e.preventDefault(), (dragQuad = i))}
            ondragleave={() => (dragQuad = null)}
            ondrop={(e) => (e.preventDefault(), (dragQuad = null), dropToQuadrant(i, e.dataTransfer?.files ?? null))}
          >
            <span class="text-sm font-semibold text-gray-900">Plate {i + 1}</span>
            <p class="mt-1 text-xs text-gray-500">drop its rack scan</p>
            <p class="mt-2 text-xs text-gray-500">
              <label class="cursor-pointer font-medium text-teal-700 hover:text-teal-600">choose<input type="file" accept=".tsv,.txt" class="hidden" onchange={(e) => dropToQuadrant(i, e.currentTarget.files)} /></label>
              · <button type="button" class="font-medium text-teal-700 hover:text-teal-600" onclick={() => demoToQuadrant(i)}>demo</button>
            </p>
          </div>
        {:else}
          {@const r = rackAt[i]!}
          <div class="flex flex-col gap-1.5">
            <div class="flex items-center gap-2 text-xs">
              <span class="font-semibold whitespace-nowrap text-gray-900">Plate {i + 1}</span>
              <span class="min-w-0 flex-1 truncate font-mono text-gray-500">{racks[r].rackId}</span>
              <span class="flex items-center gap-1 whitespace-nowrap text-gray-600">primer
                <span class="grid w-16 grid-cols-1">
                  <select aria-label="Primer plate for plate {i + 1}" class={select} bind:value={primerAt[i]}>{#each Array.from({ length: 10 }, (_, k) => String(k + 1)) as n}<option>{n}</option>{/each}</select>
                  {@render chevron()}
                </span>
              </span>
              <button type="button" aria-label="Clear plate {i + 1}" class="px-1 text-gray-400 hover:text-red-700" onclick={() => clearQuadrant(i)}>✕</button>
            </div>
            <div class="rounded-lg {editBlanks ? 'ring-2 ring-teal-500 ring-offset-2' : ''}">
              <PlateMap fill wells={wellsOf(r)} onpick={editBlanks ? (w) => toggleBlank(r, w) : undefined} />
            </div>
          </div>
        {/if}
      {/each}
    </div>

    <!-- One list for everything flagged; entries drop off as they are settled, up to 10 a page. -->
    {#if attention.length}
      <div class="mt-5 rounded-md border border-red-200">
        <div class="flex items-center gap-2 border-b border-red-100 bg-red-50 px-3 py-2 text-sm">
          <span class="font-medium text-red-800">{attention.length} to settle</span>
          {#if errPages > 1}
            <span class="ml-auto flex items-center gap-2 text-xs text-gray-600">
              <button type="button" class={btn} disabled={errPage === 0} onclick={() => (errPage = Math.max(0, errPage - 1))}>Prev</button>
              {errPage * ERR_PER_PAGE + 1}–{Math.min(attention.length, (errPage + 1) * ERR_PER_PAGE)} of {attention.length}
              <button type="button" class={btn} disabled={errPage >= errPages - 1} onclick={() => (errPage = Math.min(errPages - 1, errPage + 1))}>Next</button>
            </span>
          {/if}
        </div>
        <ul role="list" class="divide-y divide-gray-100 text-sm">
          {#each errView as a (a.kind + a.r + ('well' in a ? a.well : a.rackId))}
            <li class="flex flex-wrap items-center gap-2 px-3 py-2">
              {#if a.kind === 'unknown-rack'}
                <span class="font-mono text-xs text-gray-700">{a.rackId}</span>
                <span class="text-red-700">whole rack's study not in Qiita-miint · {a.n} tubes</span>
                <span class="ml-auto"><button type="button" class={btn} onclick={() => { sheetOnly = { ...sheetOnly, [a.rackId]: true }; studyFacts[OTHER] ??= { ...(demo?.otherStudy ?? { project_name: '', project_abbreviation: '', center_project_name: '', experiment_design_description: '' }) }; }}>Sample sheet only</button></span>
              {:else if a.kind === 'unknown'}
                <span class="font-mono text-xs text-gray-700">{racks[a.r].rackId} {a.well}</span>
                <span class="font-mono text-xs text-gray-500">{a.tube}</span>
                <span class="text-red-700">not in Qiita-miint</span>
                <span class="ml-auto flex gap-1"><button type="button" class={btn} onclick={() => decide(a.r, a.well, { blank: true })}>Blank</button><button type="button" class={btn} onclick={() => decide(a.r, a.well, { exclude: true })}>Leave out</button></span>
              {:else if a.kind === 'multi'}
                <span class="font-mono text-xs text-gray-700">{racks[a.r].rackId} {a.well}</span>
                <span class="text-red-700">in {a.studies.length} studies</span>
                <span class="ml-auto flex gap-1">{#each a.studies as sid}<button type="button" class={btn} onclick={() => decide(a.r, a.well, { primary: sid })}>{titleOf(String(sid))}</button>{/each}</span>
              {:else if a.kind === 'duplicate'}
                <span class="font-mono text-xs text-gray-700">{racks[a.r].rackId} {a.well}</span>
                <span class="text-red-700">also at {a.other}</span>
                <span class="ml-auto"><button type="button" class={btn} onclick={() => decide(a.r, a.well, { exclude: true })}>Leave this one out</button></span>
              {:else if a.kind === 'mixed-blank'}
                <span class="font-mono text-xs text-gray-700">{a.rackId}</span>
                <span class="text-red-700">mixes studies — blanks go to</span>
                <span class="ml-auto grid min-w-44 grid-cols-1">
                  <select aria-label="Blanks of {a.rackId} go to" class="{select} outline-red-400" bind:value={blanksTo[a.rackId]}>
                    <option value={undefined} disabled>choose…</option>
                    {#each a.studies as k}<option value={k}>{titleOf(k)}</option>{/each}
                    <option value={EACH}>each study's sheet</option>
                  </select>
                  {@render chevron()}
                </span>
              {/if}
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    {@const structural = layoutProblems.filter((p) => !p.startsWith('Say which study'))}
    {#if refused.length}<p class="mt-3 text-sm text-red-700">{refused.length} rack scan{refused.length === 1 ? '' : 's'} refused — remove and rescan.</p>{/if}
    {#if structural.length}<p class="mt-3 text-sm text-red-700">{structural.join(' · ')}</p>{/if}
    {#if blanks.length < MIN_BLANKS}<p class="mt-3 text-sm text-amber-700">Only {blanks.length} blanks on this run; at least {MIN_BLANKS} recommended.</p>{/if}
    {#if racks.length && !attention.length && layoutProblems.length === 0}<p class="mt-3 text-sm text-green-700">All {all.length} tubes placed across {placed.length} quadrant{placed.length === 1 ? '' : 's'}.</p>{/if}
  {:else if step === 2}
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
    <div class="mt-2 grid max-w-3xl grid-cols-1 gap-4 sm:grid-cols-3">
      <div>
        <label for="run-date" class="block text-sm/6 font-medium text-gray-900">Run date</label>
        <input id="run-date" type="date" class="{field} mt-2" bind:value={run.run_date} />
      </div>
      <div>
        <label for="instrument" class="block text-sm/6 font-medium text-gray-900">Instrument</label>
        <div class="mt-2 grid grid-cols-1">
          <select id="instrument" class={select} bind:value={run.instrument_model}>
            <option value="" disabled>Choose…</option>
            {#each instruments as m}<option value={m}>{m}</option>{/each}
          </select>
          {@render chevron()}
        </div>
      </div>
      <div>
        <label for="platemap-date" class="block text-sm/6 font-medium text-gray-900">Plate map date</label>
        <input
          id="platemap-date"
          type="date"
          class="{field} mt-2"
          bind:value={() => isoDate(run.platemap_generation_date), (v) => (run.platemap_generation_date = v.replaceAll('-', ''))}
        />
      </div>
    </div>

    {#if errors.length || studyErrors.length || warnings.length}
      <ul class="mt-4 space-y-1 text-sm">
        {#each [...errors, ...studyErrors] as t}<li class="text-red-700">{t}</li>{/each}
        {#each warnings as t}<li class="text-amber-700">{t}</li>{/each}
      </ul>
    {/if}
  {:else if step === 3}
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
  {:else if step === 4}
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
    <div class="flex items-center gap-2">
      {#if flow.checkpoint.length > 0}
        <button type="button" class="rounded-md bg-white px-3 py-2 text-sm font-semibold text-gray-700 shadow-xs ring-1 ring-gray-300 ring-inset hover:bg-gray-50" onclick={downloadCheckpoint} title="Download the pre-prep file(s) as they stand now — a backup, one per study">Download checkpoint</button>
      {/if}
      {#if step < steps.length - 1}
        {#if step === flow.build.at && !flow.build.done}
          <button type="button" class="rounded-md bg-teal-600 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-teal-500 disabled:opacity-40" disabled={flow.build.disabled} onclick={flow.build.run}>Build pre-flight</button>
        {:else}
          <button type="button" class="rounded-md bg-teal-600 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-teal-500 disabled:opacity-40" disabled={!canLeave[step]} onclick={() => go(nextStep)}>Next: {steps[nextStep]}</button>
        {/if}
      {/if}
    </div>
  </div>
</div>

<Modal bind:open={discardOpen} title="Discard this prep?">
  {#if pendingDiscard}
    <div class="p-4">
      <p class="text-sm text-gray-700">Discard <span class="font-medium">{pendingDiscard.label}</span>? This removes the saved prep from this browser and can't be undone.</p>
      <div class="mt-4 flex justify-end gap-2">
        <button type="button" class="rounded-md bg-white px-3 py-1.5 text-sm font-semibold text-gray-900 ring-1 ring-gray-300 ring-inset hover:bg-gray-50" onclick={() => (discardOpen = false)}>Cancel</button>
        <button type="button" class="rounded-md bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-500" onclick={confirmDiscard}>Discard</button>
      </div>
    </div>
  {/if}
</Modal>
