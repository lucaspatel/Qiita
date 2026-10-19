<script lang="ts">
  // MOCKUP of the Library prep flow: from "a box of tubes was dropped off" to "the
  // amplicon workflow is running", replacing kl-metapool's
  // amplicon_pre_prep_file_generator notebook. The tube codes drive it: scanning the
  // racks is enough to know which samples and studies are in the box, and anything
  // Qiita-miint can't place is settled before the plates are laid out. It ends in
  // the per-study sample sheets kl-run-preflight builds the run's pre-flight from.
  // One task per screen. Local data only (lib/libraryPrep/); nothing is sent.
  import { tick, untrack } from 'svelte';
  import { api, type PrepProtocol } from '$lib/api';
  import { scopedKey } from '$lib/environment';
  import PlateMap, { type Well } from '$lib/ui/PlateMap.svelte';
  import Modal from '$lib/ui/Modal.svelte';
  import { MIN_BLANKS } from '$lib/features/library-prep/amplicon/validate';
  import { WELLS_96, to384 } from '$lib/features/library-prep/amplicon/plate';
  import { parseVisionMate, toVisionMate } from '$lib/features/library-prep/amplicon/visionmate';
  import { RUN_FOLDERS, STUDIES, demoBox, mockGolay, type Demo } from '$lib/features/library-prep/mock/mock';
  import { PLATE_COLUMNS, STUDY_COLUMNS } from '$lib/features/library-prep/amplicon/sampleSheet';
  import { EACH, OTHER, emptyAmplicon, removeRack, wellKey, type AmpliconPrep, type Decision } from '$lib/features/library-prep/amplicon/state';
  import { problemOf, rememberStudies, studiesOfRack as studiesOf, type Cell, type Registry } from '$lib/features/library-prep/amplicon/resolve';
  import { autoPlace, seedFacts, type LastPrep } from '$lib/features/library-prep/amplicon/layout';
  import { deriveAmplicon } from '$lib/features/library-prep/amplicon/model';
  import { AMPLICON_GRID_COLUMNS } from '$lib/features/library-prep/amplicon/columns';
  import { applyEdits, slotOf } from '$lib/features/library-prep/amplicon/routing';
  import { planLoad } from '$lib/features/library-prep/edits';
  import { describeLoad, diffLoaded } from '$lib/features/library-prep/load';
  import { DraftShapeError, restoreAmplicon } from '$lib/features/library-prep/amplicon/persist';
  import {
    deleteDraft,
    listDrafts,
    loadDraft,
    newDraftId,
    saveDraft,
    type DraftMeta
  } from '$lib/features/library-prep/drafts';
  import * as lr from '$lib/features/library-prep/long-read/longRead';
  import {
    LONGREAD_GRID_COLUMNS,
    applyEdits as applyLongReadEdits,
    deriveLongRead,
    emptyLongRead,
    restoreLongRead,
    slotOf as longReadSlotOf,
    type LongReadPrep
  } from '$lib/features/library-prep/long-read/prep';
  import { AMPLICON_SPEC, LONGREAD_SPEC } from '$lib/features/library-prep/specs';
  import Sheet from '$lib/ui/Sheet.svelte';
  import ProblemList from '$lib/ui/ProblemList.svelte';
  import Tabs from '$lib/ui/Tabs.svelte';
  import { issueIndex, toTsv, type CellEdit, type ColumnSpec, type Problem, type Row } from '$lib/table/model';

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
    { id: 'rrna_operon_5kb', label: 'rRNA operon · 16S 8F / 23S 2490R (Karst UMI, ~5 Kbp)', enabled: true }
  ];
  let target = $state<string | null>(null);

  // --- long-read flow state (steps 1–5 when the long-read protocol is picked) ---
  /** The long-read prep (features/library-prep/long-read/prep.ts). Drafts save it whole. */
  let lrPrep = $state<LongReadPrep>(emptyLongRead());
  const lrModel = $derived(deriveLongRead(lrPrep));
  const lrScanned = $derived(lrPrep.pool.length > 0);
  const lrProblems = $derived(lr.poolProblems(lrPrep.pool));
  let lrBuilt = $state(false);
  let lrStarted = $state(false);
  const lrPreflightName = $derived(
    lrPrep.run.movie_context ? `${lrPrep.run.movie_context}.preflight.db` : 'run.preflight.db'
  );
  const lrPreview = $derived(lr.builderPreview(lrPrep.pool, lrPrep.details, lrPrep.run));
  const lrTitleOf = (k: string) => (k === lr.OTHER ? 'Not in Qiita-miint' : (lr.STUDIES[k]?.title ?? k));
  const lrColorOf = (k: string) => (k === lr.OTHER ? '#9ca3af' : (lr.STUDIES[k]?.color ?? '#9ca3af'));
  const pretty = (s: string) => s.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase());

  // The long-read run-prep file as it stands: the checkpoint, built from the prep.
  const lrCheckpointFiles = $derived([lrModel.file]);

  // --- 2. scan ---
  /** The amplicon prep: everything scanned, decided and typed (features/library-prep/
   *  amplicon/state.ts). Drafts save it whole. */
  let prep = $state<AmpliconPrep>(emptyAmplicon());
  let demo = $state.raw<Demo | null>(null);
  let checking = $state(false);
  let dragging = $state(false);

  function check() {
    checking = true;
    setTimeout(() => (checking = false), 600); // the mock's round trip
  }
  function loadDemo() {
    demo = demoBox();
    prep.racks = demo.racks;
    check();
  }
  async function addFiles(files: FileList | null) {
    if (!files?.length) return;
    demo ??= demoBox(); // the mock's Qiita-miint and defaults
    const parsed = await Promise.all([...files].map(async (f) => parseVisionMate(f.name, await f.text())));
    prep.racks = [...prep.racks, ...parsed].slice(0, 4);
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
  const refused = $derived(prep.racks.filter((r) => r.problems.length));

  // --- resolution: what Qiita-miint answers for every tube, and the tech's decisions ---
  // Resolution, layout and the sheets are derived in features/library-prep/amplicon;
  // the page reads one model of the prep and names the parts it shows.
  const keyOf = wellKey;
  const decide = (r: number, well: string, d: Decision) =>
    (prep.decisions = { ...prep.decisions, [keyOf(r, well)]: { ...(prep.decisions[keyOf(r, well)] ?? {}), ...d } });
  /** "Edit blanks" on the Plates step: a view setting, not part of the prep. */
  let editBlanks = $state(false);
  const NO_REGISTRY: Registry = new Map();
  const barcodeOf = (primerPlate: string, well96: string) =>
    demo?.barcodes.get(`${primerPlate}:${well96}`) ?? mockGolay(primerPlate, well96);
  const model = $derived(deriveAmplicon(prep, demo?.registry ?? NO_REGISTRY, barcodeOf, (k) => titleOf(k)));
  const cells = $derived(model.resolved.cells);
  const all = $derived(model.resolved.all);
  const unknown = $derived(model.resolved.unknown);
  const multi = $derived(model.resolved.multi);
  const dupes = $derived(model.resolved.dupes);
  const blanks = $derived(model.resolved.blanks);
  const needFix = $derived(model.resolved.needFix);
  const studyKeys = $derived(model.resolved.studyKeys);
  // Remember each well's study, so a well whose tube stops resolving stays in its sheet.
  $effect(() => {
    const resolved = model.resolved;
    untrack(() => rememberStudies(prep, resolved));
  });
  const blanksOn = (r: number) => blanks.filter((x) => x.r === r).length;
  const studiesOfRack = (r: number) => studiesOf(model.resolved, r);
  const mixedRacks = $derived(model.mixed.map((r) => ({ rack: prep.racks[r], r })));
  const countFor = (key: string) => all.filter((x) => x.cell.state === 'sample' && x.cell.study === key).length;
  const unknownRacks = $derived(
    prep.racks.map((rack, r) => ({ rack, r, n: unknown.filter((x) => x.r === r).length })).filter((x) => x.n >= 24)
  );
  const looseUnknown = $derived(unknown.filter((x) => !unknownRacks.some((u) => u.r === x.r)));

  const PALETTE = ['#0d9488', '#b45309', '#7c3aed', '#2563eb'];
  const colorOf = (key: string) => PALETTE[Math.max(0, studyKeys.indexOf(key)) % PALETTE.length];
  const titleOf = (key: string) =>
    key === OTHER
      ? `${prep.studyFacts[OTHER]?.project_name || 'Sheet-only study'} (not in Qiita-miint)`
      : (STUDIES.find((s) => String(s.study_idx) === key)?.title ?? `#${key}`);

  // --- 4. plates: four quadrants ---
  let dragQuad = $state<number | null>(null); // the quadrant a scan is being dragged over
  // A removed rack frees its position; a new rack takes its demo position, else the first free one.
  $effect(() => {
    void prep.racks.length;
    untrack(() => autoPlace(prep, demo?.plates));
  });
  // Per-quadrant scan: a rack is dropped onto one position, placed there directly.
  async function dropToQuadrant(i: number, files: FileList | null) {
    if (!files?.length) return;
    demo ??= demoBox();
    const parsed = await parseVisionMate(files[0].name, await files[0].text());
    prep.racks = [...prep.racks, parsed];
    prep.rackAt[i] = prep.racks.length - 1;
    check();
  }
  // Load a demo rack into one quadrant (the next demo rack not already placed).
  function demoToQuadrant(i: number) {
    demo ??= demoBox();
    const placedIds = new Set(prep.rackAt.flatMap((r) => (r === null ? [] : [prep.racks[r]?.rackId])));
    const next = demo.racks.find((dr) => !placedIds.has(dr.rackId) && !prep.racks.some((x) => x.rackId === dr.rackId));
    const rack = next ?? demo.racks[i] ?? demoBox().racks[i];
    prep.racks = [...prep.racks, rack];
    prep.rackAt[i] = prep.racks.length - 1;
    check();
  }
  // Clear a quadrant: drop its rack entirely and renumber everything keyed by rack
  // index (rackAt, and the r:well decision records) so nothing dangles.
  function clearQuadrant(i: number) {
    const r0 = prep.rackAt[i];
    if (r0 !== null) removeRack(prep, r0);
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
    for (const { rack, r } of mixedRacks) if (!prep.blanksTo[rack.rackId]) out.push({ kind: 'mixed-blank', r, rackId: rack.rackId, studies: studiesOfRack(r) });
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
  /** Every tube Fix still has to settle, for the study owner or the tech's notes. */
  const downloadProblems = () =>
    download(
      'unplaced-tube-codes.tsv',
      ['rack\twell\ttube_code\tproblem', ...[...unknown, ...multi, ...dupes].map((x) => `${prep.racks[x.r].rackId}\t${x.well}\t${x.tube}\t${problemOf(x.cell)}`)].join('\n')
    );
  /** In "Edit blanks", a click makes a sample a blank or undoes that; a tube the
   *  scan or Fix made a blank stays one. */
  const toggleBlank = (r: number, well: string) => {
    if (!editBlanks) return;
    const k = keyOf(r, well);
    if (prep.blankEdits[k]) {
      const { [k]: _gone, ...rest } = prep.blankEdits;
      prep.blankEdits = rest;
    } else if (cells[r]?.[well]?.cell.state === 'sample') prep.blankEdits = { ...prep.blankEdits, [k]: true };
  };
  const blanksChanged = $derived(Object.keys(prep.blankEdits).length);
  const placed = $derived(model.placed);
  const layoutProblems = $derived(model.layoutProblems);

  // --- 5. details: per plate, per study, per run ---
  // The last prep's plate facts and instrument, so the lots and tools that repeat
  // run to run arrive filled. A convenience: storage may be absent, and anything
  // malformed is ignored.
  const LAST_KEY = scopedKey('qiita-web:library-prep:last');
  type Last = LastPrep & { when: string };
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
    const { sample_plate: _s, primer_plate: _p, ...plate } = prep.plateFacts[prep.racks[first.r].rackId];
    try {
      localStorage.setItem(LAST_KEY, JSON.stringify({ plate, instrument_model: prep.run.instrument_model, when: new Date().toISOString().slice(0, 10) }));
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
    void prep.racks.length;
    untrack(() => {
      if (seedFacts(prep, { plates: d?.plates, studyFacts: d?.studyFacts, run: d?.run }, last)) prefilled = true;
    });
  });
  const errors = $derived(model.plateErrors);
  const warnings = $derived(model.plateWarnings);
  const studyErrors = $derived(model.detailErrors);
  type PlateCol = (typeof PLATE_COLUMNS)[number][0];
  const placedFacts = () => placed.flatMap(({ r }) => (prep.plateFacts[prep.racks[r].rackId] ? [prep.plateFacts[prep.racks[r].rackId]] : []));
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
    prep.run.instrument_model && !INSTRUMENTS.includes(prep.run.instrument_model) ? [prep.run.instrument_model, ...INSTRUMENTS] : INSTRUMENTS
  );

  // --- 6. pre-flight: one sample sheet per study, which kl-run-preflight builds the blob from ---
  const sheetWells = $derived(model.wells);
  const barcodeIssues = $derived(model.barcodeIssues);
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
  const sheets = $derived(model.sheets);
  let built = $state(false);
  // A pre-flight is of the sheets it was built from: any later change unbuilds it.
  $effect(() => {
    sheets.map((x) => x.text);
    untrack(() => (built = false));
  });
  const preflightName = $derived(
    `${prep.run.run_date.replaceAll('-', '') || 'YYYYMMDD'}_IL515fBC_806_${studyKeys.map((k) => prep.studyFacts[k]?.project_abbreviation ?? k).join('_')}.preflight.db`
  );
  const checkpointFiles = $derived(model.files);

  // --- 7. sequence ---
  let runFolder = $state<string | null>(null);
  let started = $state(false);

  // Short-read: Protocol, Plates (scan + fix + lay out, merged), Details, Pre-flight, Sequence.
  const shortCanLeave = $derived([
    !!protocol && !!target,
    prep.racks.length > 0 && !checking && refused.length === 0 && needFix === 0 && layoutProblems.length === 0,
    errors.length === 0 && studyErrors.length === 0,
    built,
    true
  ]);
  // Long-read: Protocol, Pool, Barcodes, Details, Pre-flight, Sequence.
  const longCanLeave = $derived([
    !!protocol && !!target,
    lrScanned,
    lrProblems.length === 0,
    !!(lrPrep.details.fwd_primer && lrPrep.details.rev_primer && lrPrep.details.umi_pattern),
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
    // The columnar spec for this flow's pre-prep file — what the TSV editor validates
    // and shapes a loaded file against.
    spec: ColumnSpec[];
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
        // A sheet edit can unsettle a tube after the Plates step, so the build re-checks.
        disabled: barcodeIssues.length > 0 || needFix > 0 || layoutProblems.length > 0,
        run: () => {
          built = true;
          saveLast();
        }
      },
      checkpoint: checkpointFiles,
      spec: AMPLICON_SPEC
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
      // The long-read run-prep file, in the standard columnar format — a backup at
      // any step through to the end, the analogue of the short-read checkpoint.
      checkpoint: lrCheckpointFiles,
      spec: LONGREAD_SPEC
    }
  });
  const flow = $derived(FLOWS[protocol ?? SUPPORTED_PROTOCOL]);
  // Save the pre-prep file(s) as they stand right now — a backup at any step.
  const downloadCheckpoint = () => flow.checkpoint.forEach((f) => download(f.name, f.text));

  // The sheet editor: each flow's prep file(s) as a live grid over the prep's own state.
  // Every row is built from the prep and every edit is routed back to the state that
  // owns its column (amplicon/columns.ts, long-read/prep.ts), so the grids, the steps
  // and the checkpoint never disagree, and anything an edit breaks is flagged in all of
  // them at once. The grids stay mounted (hidden when not shown), so each keeps its
  // undo history across study tabs, the steps/sheet toggle and the lock.
  /** Which view of the prep the card shows: the steps, or the sheet they build. */
  let view = $state<'steps' | 'sheet'>('steps');
  /** The study whose sheet is showing, by key; falls back to the first sheet. */
  let editorKey = $state('');
  const editorTab = $derived(Math.max(0, sheets.findIndex((sh) => sh.key === editorKey)));
  /** The sheet is read-only until the tech unlocks it: the steps are the usual way in. */
  let sheetEditable = $state(false);
  let editorNote = $state('');

  const ampliconGridColumns = AMPLICON_GRID_COLUMNS;
  const isAmplicon = $derived(protocol !== LONGREAD_PROTOCOL);
  const editorSheet = $derived(isAmplicon ? sheets[Math.min(editorTab, sheets.length - 1)] : undefined);
  const lrRows = $derived(lrModel.rows.map((r) => r.row as unknown as Row));
  const editorRows = $derived<Row[]>(isAmplicon ? (editorSheet?.built.map((b) => b.row) ?? []) : lrRows);
  const editorColumns = $derived(isAmplicon ? ampliconGridColumns : LONGREAD_GRID_COLUMNS);
  const editorName = $derived(isAmplicon ? (editorSheet?.fileName ?? 'prep.txt') : lrModel.file.name);

  /** Cell problems per grid, in tab order (the long-read flow has one grid). */
  const problemsBySheet = $derived<Problem[][]>(isAmplicon ? model.problemsBySheet : [lrModel.problems.filter((p) => p.at)]);
  /** What the steps flag that isn't about one cell. */
  const generalProblems = $derived<Problem[]>(isAmplicon ? model.general : lrModel.problems.filter((p) => !p.at));
  const allProblems = $derived([...problemsBySheet.flat(), ...generalProblems]);
  const issuesOf = (i: number) =>
    issueIndex((problemsBySheet[i] ?? []).flatMap((p) => (p.at ? [{ row: p.at.row, column: p.at.column, message: p.message }] : [])));

  /** The grids, by study key (the long-read grid is LONGREAD_GRID). */
  const LONGREAD_GRID = 'long-read';
  let sheetRefs = $state<Record<string, { focusCell: (row: number, column: string) => boolean }>>({});
  /** Jump to a problem's cell, switching to its study's sheet first. A grid that has
   *  just become visible may not be ready on the same tick, so the focus is retried. */
  async function pickProblem(p: Problem) {
    if (!p.at) return;
    const key = isAmplicon ? (p.at.sheet ?? '') : LONGREAD_GRID;
    if (isAmplicon) editorKey = key;
    for (let attempt = 0; attempt < 40; attempt++) {
      await tick();
      if (sheetRefs[key]?.focusCell(p.at.row, p.at.column)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** A study's grid edits, routed against that study's sheet as it is now. */
  const onAmpliconEdit = (key: string) => (edits: CellEdit[]) => {
    const sheet = sheets.find((sh) => sh.key === key);
    if (sheet) applyEdits(prep, sheet, edits);
  };
  const onLongReadEdit = (edits: CellEdit[]) => applyLongReadEdits(lrPrep, lrModel, edits);

  // Entering the sheet view locks it again: the steps are the usual way in.
  $effect(() => {
    if (view !== 'sheet') return;
    untrack(() => {
      editorNote = '';
      sheetEditable = false;
    });
  });
  const downloadEditor = () => download(editorName, toTsv({ columns: editorColumns, rows: editorRows }));

  /** Load a TSV into the open sheet: rows are matched by their key (a well, a sample ID)
   *  and only the cells that differ are applied, as edits, through the same routing as
   *  typing — so a loaded file updates the steps too. Values the file gives a shared
   *  column inconsistently are held back and named. */
  const loadTsv = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const text = await file.text();
    if (!isAmplicon) {
      const model = lrModel;
      const result = diffLoaded(lrRows, text, LONGREAD_GRID_COLUMNS, 'unique_sample_ID');
      const { edits, conflicts } = planLoad(result, (x) => longReadSlotOf(model, x));
      applyLongReadEdits(lrPrep, model, edits);
      editorNote = describeLoad(file.name, result, edits.length, conflicts, 'unique_sample_ID');
      return;
    }
    const sheet = editorSheet;
    if (!sheet) return;
    const result = diffLoaded(sheet.built.map((b) => b.row), text, ampliconGridColumns, 'well_id_384');
    const { edits, conflicts } = planLoad(result, (x) => slotOf(prep, sheet, x));
    applyEdits(prep, sheet, edits);
    editorNote = describeLoad(file.name, result, edits.length, conflicts, 'well');
  };
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
  const hasProgress = $derived(step > 0 || prep.racks.length > 0 || lrPrep.pool.length > 0);
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
      amplicon: $state.snapshot(prep), editBlanks, built, runFolder, started,
      longRead: $state.snapshot(lrPrep), lrBuilt, lrStarted
    };
  }

  // A short, human summary for the list: the protocol plus where it's at.
  const draftLabel = $derived.by(() => {
    const p = protocol ? pretty(protocol) : 'Prep';
    if (protocol === LONGREAD_PROTOCOL) return `${p} · ${lrPrep.pool.length} samples`;
    const plates = prep.rackAt.filter((r) => r !== null).length;
    return `${p} · ${plates} ${plates === 1 ? 'plate' : 'plates'}`;
  });

  function applySnapshot(d: Record<string, unknown>) {
    protocol = d.protocol as string | null;
    target = d.target as string | null;
    step = d.step as number;
    reached = d.reached as number;
    // Throws DraftShapeError on a damaged draft, before anything above is half-applied
    // to the amplicon state.
    prep = restoreAmplicon(d);
    editBlanks = d.editBlanks === true;
    runFolder = typeof d.runFolder === 'string' ? d.runFolder : null;
    built = d.built as boolean;
    started = d.started as boolean;
    lrPrep = restoreLongRead(d);
    lrBuilt = d.lrBuilt as boolean;
    lrStarted = d.lrStarted as boolean;
    if (d.demoLoaded) demo = demoBox(); // reconstruct the mock Qiita-miint (Maps don't serialize)
  }

  /** Why the last draft picked couldn't be resumed, shown beside the list. */
  let draftError = $state('');
  function resumeDraft(id: string) {
    const d = loadDraft(id);
    if (!d) {
      refreshDrafts();
      return;
    }
    try {
      restoreAmplicon(d); // validate both flows before touching any state
      restoreLongRead(d);
      applySnapshot(d as Record<string, unknown>);
      currentId = id;
      draftError = '';
    } catch (e) {
      if (!(e instanceof DraftShapeError)) throw e;
      draftError = `This prep can't be resumed: ${e.message}.`;
    }
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

{#snippet sheetPanel()}
  <div class="flex min-w-0 flex-col gap-3">
    <!-- right padding: the card's corner toggle ("Back to steps") sits over this row -->
    <div class="flex flex-wrap items-center gap-2 pr-36">
      {#if isAmplicon && sheets.length > 1}
        <div class="w-full border-b border-gray-200">
          <Tabs
            label="Study sheets"
            tabs={sheets.map((sh, i) => ({ id: sh.key, label: titleOf(sh.key), count: problemsBySheet[i]?.length }))}
            bind:active={() => sheets[editorTab]?.key ?? '', (k) => (editorKey = k)}
          />
        </div>
      {/if}
      <span class="font-mono text-xs text-gray-700">{editorName}</span>
      <span class="ml-auto"></span>
      <button
        type="button"
        class="rounded-md px-2.5 py-1 text-xs font-semibold ring-1 ring-inset {sheetEditable ? 'bg-amber-50 text-amber-800 ring-amber-600/30 hover:bg-amber-100' : 'bg-white text-gray-700 ring-gray-300 hover:bg-gray-50'}"
        onclick={() => (sheetEditable = !sheetEditable)}>{sheetEditable ? 'Lock editing' : 'Unlock editing'}</button
      >
      <label
        class="rounded-md bg-white px-2.5 py-1 text-xs font-semibold text-gray-700 ring-1 ring-gray-300 ring-inset {sheetEditable ? 'cursor-pointer hover:bg-gray-50' : 'pointer-events-none opacity-40'}"
        aria-disabled={!sheetEditable}
      >
        Load TSV…
        <input type="file" accept=".tsv,.txt,.csv" class="hidden" disabled={!sheetEditable} onchange={loadTsv} />
      </label>
      <button type="button" class="rounded-md bg-white px-2.5 py-1 text-xs font-semibold text-gray-700 ring-1 ring-gray-300 ring-inset hover:bg-gray-50" onclick={downloadEditor}>Download</button>
    </div>
    {#if editorNote}<p class="text-xs text-gray-500">{editorNote}</p>{/if}
    <p class="text-xs text-gray-500">
      {#if sheetEditable}
        <span class="font-medium text-amber-800">Editing is on: a change here changes the prep.</span>
        {#if isAmplicon}A plate, study or run column sets that value everywhere it appears; a tube code is re-checked against Qiita-miint. Grey columns are set elsewhere.{:else}A sample ID or barcode changes the pool; a primer, UMI or run column changes every sample.{/if}
      {:else}
        The file the steps are building, as it stands. Make changes on the steps; unlock editing only to correct the sheet directly.
      {/if}
    </p>
    <div class="min-w-0">
      {#if isAmplicon && !sheets.length}
        <p class="text-sm text-gray-500">Nothing to show yet: scan and place a rack first.</p>
      {:else}
        <div class="flex min-w-0 flex-col gap-5">
          {#if isAmplicon}
            {#each sheets as sh, i (sh.key)}
              <div class:hidden={i !== editorTab}>
                <Sheet bind:this={sheetRefs[sh.key]} columns={ampliconGridColumns} rows={sh.built.map((b) => b.row)} issues={issuesOf(i)} onedit={onAmpliconEdit(sh.key)} readOnly={!sheetEditable} height="55vh" />
              </div>
            {/each}
          {:else}
            <Sheet bind:this={sheetRefs[LONGREAD_GRID]} columns={LONGREAD_GRID_COLUMNS} rows={lrRows} issues={issuesOf(0)} onedit={onLongReadEdit} readOnly={!sheetEditable} height="55vh" />
          {/if}
          <ProblemList problems={allProblems} sheetTitle={titleOf} onpick={pickProblem} />
        </div>
      {/if}
    </div>
  </div>
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

<div class="relative rounded-lg bg-white shadow-sm ring-1 ring-gray-900/5">
  <!-- The raw sample sheet is a secondary view: a quiet toggle, not a tab. -->
  <button
    type="button"
    aria-pressed={view === 'sheet'}
    class="absolute top-3 right-3 z-10 rounded-md bg-gray-50 px-2.5 py-1 text-xs font-medium text-gray-500 ring-1 ring-gray-200 ring-inset hover:bg-gray-100 hover:text-gray-700 sm:top-4 sm:right-4"
    onclick={() => (view = view === 'sheet' ? 'steps' : 'sheet')}
  >
    {view === 'sheet' ? '← Back to steps' : 'View raw samplesheet'}
  </button>
  <div class="px-4 py-5 sm:p-6">
  <div class:hidden={view !== 'sheet'}>{@render sheetPanel()}</div>
  {#if view === 'sheet'}
    <!-- the sheet panel above -->
  {:else if step === 0}
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

    {#if draftError}<p class="mt-6 max-w-2xl rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-600/20 ring-inset" role="alert">{draftError}</p>{/if}
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
            <button type="button" class="font-medium text-teal-700 hover:text-teal-600" onclick={() => (lrPrep.pool = lr.DEMO_POOL.map((s) => ({ ...s })))}>use the demo pool</button>
          </p>
        </div>
      {:else}
        <ul role="list" class="mt-4 divide-y divide-gray-100 rounded-md border border-gray-200 text-sm">
          {#each lrPrep.pool as s, i (i)}
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
        <p class="mt-3 text-sm text-gray-600">{lrPrep.pool.length} samples · {new Set(lrPrep.pool.map((s) => s.study)).size} studies.</p>
      {/if}
    {:else if step === 2}
      <h2 class="text-sm/6 font-semibold text-gray-900">Barcodes</h2>
      <p class="mt-1 text-sm text-gray-500">Each PacBio barcode must demultiplex exactly one sample. No Golay, no plate map — the demux is upstream.</p>
      <ul role="list" class="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {#each lrPrep.pool as s, i (i)}
          <li class="flex items-center gap-2 rounded-md border border-gray-200 px-3 py-2 text-sm">
            <span class="font-mono text-xs text-gray-900">{s.barcode_id}</span>
            <span class="ml-auto truncate text-xs text-gray-500">{s.sample_name}</span>
          </li>
        {/each}
      </ul>
      {#if lrProblems.length}
        <ul class="mt-4 space-y-1 text-sm text-red-700">{#each lrProblems as t}<li>{t}</li>{/each}</ul>
      {:else}
        <p class="mt-4 text-sm text-gray-600">{lrPrep.pool.length} barcodes, each demultiplexing one sample.</p>
      {/if}
    {:else if step === 3}
      <h2 class="text-sm/6 font-semibold text-gray-900">Protocol & run details</h2>
      <p class="mt-1 text-sm text-gray-500">
        The only per-run facts the pre-flight needs beyond a normal PacBio run: the primers, the UMI pattern, and the
        target region. Everything downstream (quality/length cutoffs, clustering, variant support) is processing config,
        not pre-flight.
      </p>
      <div class="mt-4 grid max-w-3xl grid-cols-1 gap-4 sm:grid-cols-2">
        {@render lrField('Forward primer (27F)', lrPrep.details.fwd_primer, (v) => (lrPrep.details.fwd_primer = v), true)}
        {@render lrField('Reverse primer (1492R)', lrPrep.details.rev_primer, (v) => (lrPrep.details.rev_primer = v), true)}
        {@render lrField("5' construct primer", lrPrep.details.five_prime_primer, (v) => (lrPrep.details.five_prime_primer = v), true)}
        {@render lrField("3' construct primer", lrPrep.details.three_prime_primer, (v) => (lrPrep.details.three_prime_primer = v), true)}
        {@render lrField('UMI pattern', lrPrep.details.umi_pattern, (v) => (lrPrep.details.umi_pattern = v), true)}
        {@render lrField('Target subfragment', lrPrep.details.target_subfragment, (v) => (lrPrep.details.target_subfragment = v))}
      </div>
      <h3 class="mt-6 text-sm font-medium text-gray-900">Revio run</h3>
      <div class="mt-2 grid max-w-3xl grid-cols-1 gap-4 sm:grid-cols-2">
        {@render lrField('Instrument', lrPrep.run.instrument_model, (v) => (lrPrep.run.instrument_model = v))}
        {@render lrField('SMRT cell well', lrPrep.run.smrt_cell_well, (v) => (lrPrep.run.smrt_cell_well = v), true)}
        {@render lrField('Movie context', lrPrep.run.movie_context, (v) => (lrPrep.run.movie_context = v), true)}
        <label class="block">
          <span class="block text-sm/6 font-medium text-gray-900">Run date</span>
          <input type="date" class={field} bind:value={lrPrep.run.run_date} />
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
          <p class="mt-2 text-sm text-green-700">kl-run-preflight authored <span class="font-mono text-xs">{lrPreflightName}</span> from {lrPrep.pool.length} samples. The sequencing step submits with it.</p>
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
            <li class="flex items-center gap-2"><span class="size-2 rounded-full bg-blue-500"></span>pacbio-ingest — queued with {lrPreflightName}: {lrPrep.pool.length} per-barcode BAMs fan out to bam-to-parquet</li>
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
    {#if blanksChanged}<p class="mt-2 text-xs text-amber-700">{blanksChanged} {blanksChanged === 1 ? 'blank' : 'blanks'} changed from the scan · <button type="button" class="font-medium underline hover:text-amber-900" onclick={() => (prep.blankEdits = {})}>reset</button></p>{/if}

    <!-- The four 96-well racks laid out as the 384-well plate itself: 1-2 top, 3-4
         bottom. Two plates fill the width; each PlateMap scales to its column. -->
    <div class="mt-4 grid grid-cols-2 gap-x-6 gap-y-5">
      {#each [0, 1, 2, 3] as i}
        {#if prep.rackAt[i] === null}
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
          {@const r = prep.rackAt[i]!}
          <div class="flex flex-col gap-1.5">
            <div class="flex items-center gap-2 text-xs">
              <span class="font-semibold whitespace-nowrap text-gray-900">Plate {i + 1}</span>
              <span class="min-w-0 flex-1 truncate font-mono text-gray-500">{prep.racks[r].rackId}</span>
              <span class="flex items-center gap-1 whitespace-nowrap text-gray-600">primer
                <span class="grid w-16 grid-cols-1">
                  <select aria-label="Primer plate for plate {i + 1}" class={select} bind:value={prep.primerAt[i]}>{#each Array.from({ length: 10 }, (_, k) => String(k + 1)) as n}<option>{n}</option>{/each}</select>
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
                <span class="ml-auto"><button type="button" class={btn} onclick={() => { prep.sheetOnly = { ...prep.sheetOnly, [a.rackId]: true }; prep.studyFacts[OTHER] ??= { ...(demo?.otherStudy ?? { project_name: '', project_abbreviation: '', center_project_name: '', experiment_design_description: '' }) }; }}>Sample sheet only</button></span>
              {:else if a.kind === 'unknown'}
                <span class="font-mono text-xs text-gray-700">{prep.racks[a.r].rackId} {a.well}</span>
                <span class="font-mono text-xs text-gray-500">{a.tube}</span>
                <span class="text-red-700">not in Qiita-miint</span>
                <span class="ml-auto flex gap-1"><button type="button" class={btn} onclick={() => decide(a.r, a.well, { blank: true })}>Blank</button><button type="button" class={btn} onclick={() => decide(a.r, a.well, { exclude: true })}>Leave out</button></span>
              {:else if a.kind === 'multi'}
                <span class="font-mono text-xs text-gray-700">{prep.racks[a.r].rackId} {a.well}</span>
                <span class="text-red-700">in {a.studies.length} studies</span>
                <span class="ml-auto flex gap-1">{#each a.studies as sid}<button type="button" class={btn} onclick={() => decide(a.r, a.well, { primary: sid })}>{titleOf(String(sid))}</button>{/each}</span>
              {:else if a.kind === 'duplicate'}
                <span class="font-mono text-xs text-gray-700">{prep.racks[a.r].rackId} {a.well}</span>
                <span class="text-red-700">also at {a.other}</span>
                <span class="ml-auto"><button type="button" class={btn} onclick={() => decide(a.r, a.well, { exclude: true })}>Leave this one out</button></span>
              {:else if a.kind === 'mixed-blank'}
                <span class="font-mono text-xs text-gray-700">{a.rackId}</span>
                <span class="text-red-700">mixes studies — blanks go to</span>
                <span class="ml-auto grid min-w-44 grid-cols-1">
                  <select aria-label="Blanks of {a.rackId} go to" class="{select} outline-red-400" bind:value={prep.blanksTo[a.rackId]}>
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
    {#if prep.racks.length && !attention.length && layoutProblems.length === 0}<p class="mt-3 text-sm text-green-700">All {all.length} tubes placed across {placed.length} quadrant{placed.length === 1 ? '' : 's'}.</p>{/if}
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
            {#each placed as { r, position }}<th class="px-2 py-2 font-medium whitespace-nowrap">Position {position} · {prep.racks[r].rackId}</th>{/each}
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
                  {@const id = prep.racks[r].rackId}
                  <td class="px-2 py-1.5">
                    {#if prep.plateFacts[id]}
                      <input aria-label="{label} for {id}" class="{input} {prep.plateFacts[id][col].trim() ? 'outline-gray-300' : 'outline-red-300'}" bind:value={prep.plateFacts[id][col]} />
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
          {#if prep.studyFacts[k] && k !== OTHER}
            <dl class="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
              {#each STUDY_COLUMNS as [col, label]}
                <div class={col === 'experiment_design_description' ? 'col-span-2' : ''}>
                  <dt class="text-xs text-gray-500">{label}</dt>
                  <dd class="text-gray-900">{prep.studyFacts[k][col] || '—'}</dd>
                </div>
              {/each}
            </dl>
            <p class="mt-2 text-xs text-gray-400">From Qiita-miint; change it on the study.</p>
          {:else if prep.studyFacts[k]}
            <div class="grid grid-cols-2 gap-2">
              {#each STUDY_COLUMNS as [col, label]}
                <label class="text-xs text-gray-600 {col === 'experiment_design_description' ? 'col-span-2' : ''}">{label}
                  <input class="{input} mt-0.5 {prep.studyFacts[k][col].trim() ? 'outline-gray-300' : 'outline-red-300'}" bind:value={prep.studyFacts[k][col]} />
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
        <input id="run-date" type="date" class="{field} mt-2" bind:value={prep.run.run_date} />
      </div>
      <div>
        <label for="instrument" class="block text-sm/6 font-medium text-gray-900">Instrument</label>
        <div class="mt-2 grid grid-cols-1">
          <select id="instrument" class={select} bind:value={prep.run.instrument_model}>
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
          bind:value={() => isoDate(prep.run.platemap_generation_date), (v) => (prep.run.platemap_generation_date = v.replaceAll('-', ''))}
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

