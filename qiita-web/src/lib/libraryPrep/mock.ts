// MOCKUP data and rules for the Library prep flow. The demo box is half real and
// half made up: IBD's plates 5-6 come from a sample sheet the amplicon notebook
// produced (fixture.ts), and the run's other two plates are a made-up second study
// that is not in Qiita-miint, as a multi-study run has. Nothing here talks to Qiita.

import { IBD_PLATES_5_6 } from './fixture';
import type { Plate, RunFacts, StudyFacts } from './sampleSheet';

export const ROWS_96 = 'ABCDEFGH'.split('');
export const COLS_96 = Array.from({ length: 12 }, (_, i) => i + 1);
export const ROWS_384 = 'ABCDEFGHIJKLMNOP'.split('');
export const COLS_384 = Array.from({ length: 24 }, (_, i) => i + 1);
/** Row-major (A1, A2, … H12): the order a sheet lists a plate's wells in. */
export const WELLS_96 = ROWS_96.flatMap((r) => COLS_96.map((c) => `${r}${c}`));

/** One tube as the VisionMate rack reader reports it. */
export type RackTube = { well: string; tube: string; rackId: string };
export type Rack = { fileName: string; rackId: string; tubes: RackTube[]; problems: string[] };

/** The columns every VisionMate export carries; a file missing one is not a rack scan. */
export const VISIONMATE_COLUMNS = ['TubeCode', 'LocationCell', 'LocationColumn', 'LocationRow', 'RackID', 'Time', 'Date'];

/** Parse a VisionMate export. Tube codes are normalised to Qiita's 10-digit form
 *  (spreadsheets eat leading zeroes). A rack with any problem is refused whole:
 *  a scan that can't be trusted in one well can't be trusted in the others. A tube
 *  scanned twice is not a problem here; Fix settles it with the other duplicates. */
export function parseVisionMate(fileName: string, text: string): Rack {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const header = (lines.shift() ?? '').split('\t').map((h) => h.trim());
  const missing = VISIONMATE_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length)
    return { fileName, rackId: '?', tubes: [], problems: [`not a VisionMate scan: no ${missing.join(', ')} column`] };
  const [iTube, iCell, iCol, iRow, iRack] = VISIONMATE_COLUMNS.map((n) => header.indexOf(n));
  const problems: string[] = [];
  const tubes: RackTube[] = [];
  const rackIds = new Set<string>();
  for (const line of lines) {
    const f = line.split('\t').map((x) => x.trim());
    const well = (f[iCell] ?? '').toUpperCase();
    const raw = f[iTube] ?? '';
    if (!WELLS_96.includes(well)) {
      problems.push(`"${line.slice(0, 40)}": ${well || 'no'} well is not on a 96-well rack`);
      continue;
    }
    if (`${(f[iRow] ?? '').toUpperCase()}${Number(f[iCol])}` !== well)
      problems.push(`${well}: its row and column say ${f[iRow]}${f[iCol]}`);
    if (f[iRack]) rackIds.add(f[iRack]);
    if (!raw || /^no ?read$|^no ?tube$/i.test(raw)) continue; // an empty position
    if (!/^\d{1,10}$/.test(raw)) {
      problems.push(`${well}: "${raw}" is not a tube code`);
      continue;
    }
    tubes.push({ well, tube: raw.padStart(10, '0'), rackId: f[iRack] });
  }
  if (rackIds.size > 1) problems.push(`rows name ${rackIds.size} racks: ${[...rackIds].join(', ')}`);
  if (!tubes.length) problems.push('no readable tubes');
  return { fileName, rackId: [...rackIds][0] || fileName.replace(/\.\w+$/, ''), tubes, problems };
}

export function toVisionMate(rack: Rack): string {
  const rows = rack.tubes.map(
    (t) => `${t.tube}\t${t.well}\t${t.well.slice(1)}\t${t.well[0]}\t${rack.rackId}\t105935\t20260918`
  );
  return ['TubeCode\tLocationCell\tLocationColumn\tLocationRow\tRackID\tTime\tDate', ...rows].join('\n');
}

/** metapool's interleaved 4-quadrant compression: position 1 takes odd rows/odd
 *  columns, 2 odd rows/even columns, 3 even rows/odd columns, 4 even/even. */
export function to384(position: string, well96: string): string {
  const r = ROWS_96.indexOf(well96[0]);
  const c = Number(well96.slice(1)) - 1;
  const q = Number(position);
  return `${ROWS_384[2 * r + (q >= 3 ? 1 : 0)]}${2 * c + (q % 2 === 0 ? 1 : 0) + 1}`;
}

/** A stand-in Golay barcode for a primer-plate well the fixture doesn't cover; the
 *  real table is metapool's EMP primer plates, which belong on the server. */
export function mockGolay(primerPlate: string, well96: string): string {
  if (!/^([1-9]|10)$/.test(primerPlate)) return '';
  let h = 2166136261;
  for (const ch of `${primerPlate}:${well96}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return Array.from({ length: 12 }, (_, i) => 'ACGT'[(h >>> (i * 2)) & 3]).join('');
}

/** The notebook's naming: a sample is its tube code without leading zeroes, a blank
 *  BLANK.<abbreviation>.<plate number>.<96 well>. */
export function sampleName(tube: string, blank: boolean, abbreviation: string, samplePlate: string, well96: string): string {
  return blank
    ? `BLANK.${abbreviation}.${samplePlate.replace(/^\D*/, '')}.${well96}`
    : tube.replace(/^0+/, '');
}

// --- what Qiita-miint knows (the mock's stand-in for POST /biosample/resolve-roster) ---

export type Study = { study_idx: number; classicId: number; title: string };
/** The studies in Qiita-miint: IBD, and a made-up infant-gut study that has six
 *  tubes on the diet study's first rack (so that plate mixes studies). */
export const STUDIES: Study[] = [
  { study_idx: 25060, classicId: 15663, title: 'IBD' },
  { study_idx: 25071, classicId: 14812, title: 'Infant gut' }
];
const INFANT: StudyFacts = {
  project_name: 'INFANT_14812',
  project_abbreviation: 'INF',
  center_project_name: 'Infant gut',
  experiment_design_description: '16S sequencing of infant stool (made up for the demo)'
};

export type Resolution =
  | { kind: 'ok'; qb: string; study_idx: number }
  | { kind: 'multi'; qb: string; studies: number[] }
  | { kind: 'blank' };

/** A made-up second study on the same run, not in Qiita-miint. */
const OTHER: StudyFacts = {
  project_name: 'DIET_14567',
  project_abbreviation: 'DIET',
  center_project_name: 'Diet pilot',
  experiment_design_description: '16S sequencing of a diet pilot (made up for the demo)'
};

export type Demo = {
  racks: Rack[];
  registry: Map<string, Resolution>;
  /** Defaults the tech would otherwise type: each rack's position and facts. */
  plates: Record<string, { position: string; facts: Plate }>;
  /** Barcodes by `primer_plate:well_96` (the fixture's real ones). */
  barcodes: Map<string, string>;
  studyFacts: Record<string, StudyFacts>;
  /** The made-up study's facts, offered when its plates go in as sheet-only. */
  otherStudy: StudyFacts;
  run: RunFacts;
};

export function demoBox(): Demo {
  const racks: Rack[] = [];
  const registry = new Map<string, Resolution>();
  const plates: Demo['plates'] = {};
  const barcodes = new Map<string, string>();
  const fix = IBD_PLATES_5_6;

  fix.plates.forEach((p, i) => {
    const rackId = `SC${String(5 + i).padStart(4, '0')}`;
    const tubes: RackTube[] = [];
    for (const [well96, tube, , control, barcode, well384] of p.wells) {
      const t = tube.padStart(10, '0');
      tubes.push({ well: well96, tube: t, rackId });
      registry.set(t, control ? { kind: 'blank' } : { kind: 'ok', qb: `QB${12695 + registry.size}`, study_idx: 25060 });
      barcodes.set(`${p.facts.primer_plate}:${well96}`, barcode);
      plates[rackId] ??= { position: positionOf(well96, well384), facts: { ...p.facts } };
    }
    racks.push({ fileName: `${rackId}.tsv`, rackId, tubes, problems: [] });
  });

  // The other study's two plates: positions 2 and 4, 94 samples + 2 blanks each.
  [7, 8].forEach((n, i) => {
    const rackId = `SC${String(n).padStart(4, '0')}`;
    const tubes = WELLS_96.map((well, w) => {
      const tube = String(365100000 + n * 1000 + w).padStart(10, '0');
      if (well === 'G12' || well === 'H12') registry.set(tube, { kind: 'blank' });
      else if (n === 7 && w < 6) registry.set(tube, { kind: 'ok', qb: `QB${13100 + w}`, study_idx: 25071 });
      return { well, tube, rackId };
    });
    racks.push({ fileName: `${rackId}.tsv`, rackId, tubes, problems: [] });
    plates[rackId] = {
      position: String(2 + 2 * i),
      facts: { ...fix.plates[0].facts, sample_plate: `Plate_${n - 6}`, primer_plate: String(2 + 2 * i) }
    };
  });

  return {
    racks,
    registry,
    plates,
    barcodes,
    studyFacts: { '25060': { ...fix.study }, '25071': { ...INFANT } },
    otherStudy: OTHER,
    run: { ...fix.run }
  };
}

/** Which quadrant a plate sits in, from one of its wells' 96 and 384 positions. */
function positionOf(well96: string, well384: string): string {
  return ['1', '2', '3', '4'].find((q) => to384(q, well96) === well384) ?? '1';
}

// --- the notebook's checks (metapool.plate.validate_plate_metadata) ---

export type Message = { level: 'error' | 'warning'; text: string };

const NON_ASCII = /[^\x00-\x7f]/;
/** Today as YYYY-MM-DD, for the primer-date check. */
const today = () => new Date().toISOString().slice(0, 10);

export function validatePlates(plates: { position: string; facts: Plate }[]): Message[] {
  const out: Message[] = [];
  const repeated = (label: string, values: string[]) => {
    const seen = new Set<string>();
    for (const v of values) {
      if (v && seen.has(v)) out.push({ level: 'error', text: `${label} "${v}" is used twice` });
      seen.add(v);
    }
  };
  for (const { position, facts: f } of plates) {
    const at = `Position ${position}`;
    const pp = Number(f.primer_plate);
    if (!/^\d+$/.test(f.primer_plate) || pp < 1 || pp > 10)
      out.push({ level: 'error', text: `${at}: primer plate # "${f.primer_plate}" is not between 1 and 10` });
    else if (pp >= 9)
      out.push({ level: 'warning', text: `${at}: primer plate ${pp} is unusual; check it` });
    for (const [k, v] of Object.entries(f)) {
      if (!v.trim()) out.push({ level: 'error', text: `${at}: ${k} is empty (write not_applicable)` });
      if (NON_ASCII.test(v)) out.push({ level: 'error', text: `${at}: ${k} has a non-ASCII character` });
    }
    if (/\s/.test(f.sample_plate)) out.push({ level: 'warning', text: `${at}: spaces in the sample plate name` });
    if (f.primer_date && !/^\d{4}-\d{2}-\d{2}$/.test(f.primer_date))
      out.push({ level: 'error', text: `${at}: primer date must be YYYY-MM-DD` });
    else if (f.primer_date > today())
      out.push({ level: 'warning', text: `${at}: primer date ${f.primer_date} is in the future` });
  }
  repeated('Primer plate', plates.map((p) => p.facts.primer_plate));
  repeated('Sample plate', plates.map((p) => p.facts.sample_plate));
  return out;
}

/** A study's facts: all filled, ASCII, a project name ending in its Qiita study ID,
 *  and an abbreviation that is safe inside a blank's sample name. */
export function validateStudy(title: string, f: StudyFacts, labels: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(f)) {
    if (!v.trim()) out.push(`${title}: ${labels[k] ?? k} is empty`);
    else if (NON_ASCII.test(v)) out.push(`${title}: ${labels[k] ?? k} has a non-ASCII character`);
  }
  if (f.project_name.trim() && !/_\d+$/.test(f.project_name))
    out.push(`${title}: project name must end in _<Qiita study ID>, like IBD_15663`);
  if (f.project_abbreviation.trim() && !/^[A-Za-z0-9.-]+$/.test(f.project_abbreviation))
    out.push(`${title}: abbreviation may only use letters, digits, "." and "-"`);
  return out;
}

/** The pre-flight's barcode check: every well has a 12-base Golay barcode, and no
 *  two wells share one (demux could not tell them apart). */
export function barcodeProblems(wells: { well384: string; name: string; barcode: string }[]): string[] {
  const out: string[] = [];
  const missing = wells.filter((w) => !/^[ACGT]{12}$/.test(w.barcode));
  if (missing.length)
    out.push(`${missing.length} wells have no barcode: ${missing.slice(0, 5).map((w) => w.well384).join(', ')}${missing.length > 5 ? '…' : ''}`);
  const seen = new Map<string, string>();
  for (const w of wells) {
    if (!w.barcode) continue;
    const other = seen.get(w.barcode);
    if (other) out.push(`${w.well384} and ${other} share barcode ${w.barcode}`);
    else seen.set(w.barcode, w.well384);
  }
  return out;
}

/** Fewer negative controls than this on a run draws a warning (the notebook's rule). */
export const MIN_BLANKS = 6;

/** A run folder on the ingest roots (server: POST /run-folder/inspect). */
export const RUN_FOLDERS = [
  { id: '20260925_SL00377_0008_ASC2267726-SC3', instrument: 'MiSeq i100', cycles: '151x12x151', when: '2026-09-25' },
  { id: '20261020_SL00377_0012_ASC2299011-SC3', instrument: 'MiSeq i100', cycles: '151x12x151', when: '2026-10-20' }
];
