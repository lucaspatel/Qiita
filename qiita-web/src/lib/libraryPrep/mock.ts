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

/** Parse a VisionMate export (TubeCode, LocationCell, LocationColumn, LocationRow,
 *  RackID, Time, Date). Tube codes are normalised to Qiita's 10-digit form
 *  (spreadsheets eat leading zeroes). */
export function parseVisionMate(fileName: string, text: string): Rack {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const problems: string[] = [];
  const header = (lines.shift() ?? '').split('\t').map((h) => h.trim());
  const [iTube, iCell, iRack] = ['TubeCode', 'LocationCell', 'RackID'].map((n) => header.indexOf(n));
  if (iTube < 0 || iCell < 0)
    return { fileName, rackId: '?', tubes: [], problems: ['not a VisionMate file: needs TubeCode and LocationCell'] };
  const tubes: RackTube[] = [];
  const seen = new Map<string, string>();
  for (const line of lines) {
    const f = line.split('\t').map((x) => x.trim());
    const well = f[iCell]?.toUpperCase();
    const raw = f[iTube] ?? '';
    if (!WELLS_96.includes(well)) {
      problems.push(`"${line.slice(0, 40)}": ${well || 'no'} well is not on a 96-well rack`);
      continue;
    }
    if (!raw || /^no ?read$|^no ?tube$/i.test(raw)) continue; // an empty position
    if (!/^\d{1,10}$/.test(raw)) {
      problems.push(`${well}: "${raw}" is not a tube code`);
      continue;
    }
    const tube = raw.padStart(10, '0');
    if (seen.has(tube)) problems.push(`tube ${tube} is in ${seen.get(tube)} and ${well}`);
    seen.set(tube, well);
    tubes.push({ well, tube, rackId: iRack >= 0 ? f[iRack] : '' });
  }
  return { fileName, rackId: tubes[0]?.rackId || fileName.replace(/\.\w+$/, ''), tubes, problems };
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
/** The studies in Qiita-miint; only IBD of this run's two. */
export const STUDIES: Study[] = [{ study_idx: 25060, classicId: 15663, title: 'IBD' }];

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
    studyFacts: { '25060': { ...fix.study } },
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
    if (!Number.isInteger(pp) || pp < 1 || pp > 10)
      out.push({ level: 'error', text: `${at}: primer plate # "${f.primer_plate}" is not between 1 and 10` });
    for (const [k, v] of Object.entries(f))
      if (!v.trim()) out.push({ level: 'error', text: `${at}: ${k} is empty (write not_applicable)` });
    if (/\s/.test(f.sample_plate)) out.push({ level: 'warning', text: `${at}: spaces in the sample plate name` });
    if (f.primer_date && !/^\d{4}-\d{2}-\d{2}$/.test(f.primer_date))
      out.push({ level: 'error', text: `${at}: primer date must be YYYY-MM-DD` });
  }
  repeated('Primer plate', plates.map((p) => p.facts.primer_plate));
  repeated('Sample plate', plates.map((p) => p.facts.sample_plate));
  return out;
}

/** A run folder on the ingest roots (server: POST /run-folder/inspect). */
export const RUN_FOLDERS = [
  { id: '20260925_SL00377_0008_ASC2267726-SC3', instrument: 'MiSeq i100', cycles: '151x12x151', when: '2026-09-25' },
  { id: '20261020_SL00377_0012_ASC2299011-SC3', instrument: 'MiSeq i100', cycles: '151x12x151', when: '2026-10-20' }
];
