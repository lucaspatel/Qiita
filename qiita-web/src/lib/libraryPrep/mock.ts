// MOCKUP data and rules for the Library prep flow: what a box of tubes looks like
// when it arrives, and the notebook's (kl-metapool amplicon_pre_prep_file_generator)
// checks and transforms, so the screens can be clicked through end to end without a
// server. Nothing here talks to Qiita. Each piece is tagged with where the real
// implementation belongs (CLIENT or SERVER); see `docs` in the page for the split.

export const ROWS_96 = 'ABCDEFGH'.split('');
export const COLS_96 = Array.from({ length: 12 }, (_, i) => i + 1);
export const ROWS_384 = 'ABCDEFGHIJKLMNOP'.split('');
export const COLS_384 = Array.from({ length: 24 }, (_, i) => i + 1);
export const WELLS_96 = COLS_96.flatMap((c) => ROWS_96.map((r) => `${r}${c}`));

/** One tube as the VisionMate rack reader reports it. */
export type RackTube = { well: string; tube: string; rackId: string };
export type Rack = { fileName: string; rackId: string; tubes: RackTube[]; problems: string[] };

/** CLIENT: parse a VisionMate export (TubeCode, LocationCell, LocationColumn,
 *  LocationRow, RackID, Time, Date). Tube codes are normalised to Qiita's 10-digit
 *  form (the rack reader drops nothing, but spreadsheets eat leading zeroes). */
export function parseVisionMate(fileName: string, text: string): Rack {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const problems: string[] = [];
  const header = (lines.shift() ?? '').split('\t').map((h) => h.trim());
  const col = (name: string) => header.indexOf(name);
  const [iTube, iCell, iRack] = [col('TubeCode'), col('LocationCell'), col('RackID')];
  if (iTube < 0 || iCell < 0)
    return { fileName, rackId: '?', tubes: [], problems: ['not a VisionMate file: needs TubeCode and LocationCell columns'] };
  const tubes: RackTube[] = [];
  const seen = new Map<string, string>();
  for (const line of lines) {
    const f = line.split('\t').map((x) => x.trim());
    const well = f[iCell]?.toUpperCase();
    const raw = f[iTube] ?? '';
    if (!WELLS_96.includes(well)) {
      problems.push(`row "${line.slice(0, 40)}": ${well || 'no'} well is not on a 96-well rack`);
      continue;
    }
    if (!raw || /^no ?read$|^no ?tube$/i.test(raw)) continue; // an empty position
    if (!/^\d{1,10}$/.test(raw)) {
      problems.push(`${well}: "${raw}" is not a tube code (digits only)`);
      continue;
    }
    const tube = raw.padStart(10, '0');
    if (seen.has(tube)) problems.push(`tube ${tube} is in ${seen.get(tube)} and ${well}`);
    seen.set(tube, well);
    tubes.push({ well, tube, rackId: iRack >= 0 ? f[iRack] : '' });
  }
  return { fileName, rackId: tubes[0]?.rackId || fileName, tubes, problems };
}

export function toVisionMate(rack: Rack): string {
  const rows = rack.tubes.map(
    (t) =>
      `${t.tube}\t${t.well}\t${t.well.slice(1)}\t${t.well[0]}\t${rack.rackId}\t105935\t20261013`
  );
  return ['TubeCode\tLocationCell\tLocationColumn\tLocationRow\tRackID\tTime\tDate', ...rows].join('\n');
}

// --- what Qiita knows (SERVER: POST /biosample/resolve-roster and study reads) ---

export type Study = {
  study_idx: number;
  title: string;
  /** Biosamples registered, and how many carry a matrix tube code. */
  biosamples: number;
  withTubes: number;
};
export const STUDIES: Study[] = [
  { study_idx: 15663, title: 'IBD longitudinal cohort', biosamples: 843, withTubes: 812 },
  { study_idx: 12986, title: 'Celeste Adaptation', biosamples: 420, withTubes: 420 },
  { study_idx: 13001, title: 'Soil warming plots', biosamples: 96, withTubes: 0 }
];

export type Resolution =
  | { kind: 'ok'; sample: string; qb: string; study_idx: number; others: number[] }
  | { kind: 'multi'; sample: string; qb: string; studies: number[] }
  | { kind: 'unknown' }
  | { kind: 'blank' };

// Deterministic fake tube codes per (study, n).
const tubeOf = (seed: number, n: number) => String(363000000 + seed * 1000 + n).padStart(10, '0');

/** The demo box: four racks. Plates 1-2 are IBD, plate 3 Celeste Adaptation, plate 4
 *  mixes soil (a study whose metadata has no tube codes) with a blank column. Edge
 *  cases planted: unknown tubes, a tube shared by two studies, a tube on two racks. */
export function demoBox(): { racks: Rack[]; registry: Map<string, Resolution> } {
  const registry = new Map<string, Resolution>();
  const racks: Rack[] = [];
  const add = (rackId: string, fill: (well: string, i: number) => string | null) => {
    const tubes: RackTube[] = [];
    WELLS_96.forEach((well, i) => {
      const tube = fill(well, i);
      if (tube) tubes.push({ well, tube, rackId });
    });
    racks.push({ fileName: `${rackId}.tsv`, rackId, tubes, problems: [] });
  };
  const reg = (tube: string, r: Resolution) => (registry.set(tube, r), tube);

  // Plate 1: IBD, 94 samples + 2 blanks (G12, H12); 3 tubes not in Qiita.
  add('SC0001', (well, i) => {
    if (well === 'G12' || well === 'H12') return reg(tubeOf(9, i), { kind: 'blank' });
    const t = tubeOf(1, i);
    if ([17, 52, 77].includes(i)) return t; // unknown
    if (i === 30)
      return reg(t, { kind: 'multi', sample: `15663.${800100 + i}`, qb: `QB${12700 + i}`, studies: [15663, 12986] });
    return reg(t, { kind: 'ok', sample: `15663.${800100 + i}`, qb: `QB${12700 + i}`, study_idx: 15663, others: [] });
  });
  // Plate 2: IBD, 88 samples, 8 empty wells; one tube also on plate 1.
  add('SC0002', (well, i) => {
    if (i >= 88) return null;
    if (i === 5) return tubeOf(1, 3);
    return reg(tubeOf(2, i), { kind: 'ok', sample: `15663.${800300 + i}`, qb: `QB${12900 + i}`, study_idx: 15663, others: [] });
  });
  // Plate 3: Celeste Adaptation, full.
  add('SC0003', (_well, i) =>
    reg(tubeOf(3, i), { kind: 'ok', sample: `12986.ADAPT.${i + 1}`, qb: `QB${5400 + i}`, study_idx: 12986, others: [] })
  );
  // Plate 4: soil (no tube codes in Qiita yet) + a blank column.
  add('SC0004', (well, i) => {
    if (well.endsWith('12')) return reg(tubeOf(8, i), { kind: 'blank' });
    return tubeOf(4, i); // soil: unknown until its metadata carries tube codes
  });
  return { racks, registry };
}

/** The study a tube belongs to though its metadata lacks tube codes: the mock's
 *  stand-in for the lab saying "plate 4 is the soil study". */
export const SOIL_STUDY = 13001;

// --- plate details (notebook step 3; CLIENT validates for feedback, SERVER again) ---

export type PlateDetails = {
  position: string;
  primerPlate: string;
  samplePlate: string;
  project: string;
  elutionVolume: string;
  plating: string;
  extractionKitLot: string;
  extractionRobot: string;
  tm1000Tool: string;
  primerDate: string;
  mastermixLot: string;
  waterLot: string;
  tm10Tool: string;
  processingRobot: string;
};
export const DETAIL_FIELDS: [keyof PlateDetails, string, string][] = [
  ['samplePlate', 'Sample plate', 'Plate_16'],
  ['elutionVolume', 'Elution volume (µl)', '70'],
  ['plating', 'Plating (initials)', 'SF'],
  ['extractionKitLot', 'Extraction kit lot', '166032128'],
  ['extractionRobot', 'Extraction robot', 'Carmen_HOWE_KF3'],
  ['tm1000Tool', 'TM1000 8 tool', '109379Z'],
  ['primerDate', 'Primer date', '2026-10-01'],
  ['mastermixLot', 'MasterMix lot', '978215'],
  ['waterLot', 'Water lot', 'RNBJ0628'],
  ['tm10Tool', 'TM10 8 tool', '865HS8'],
  ['processingRobot', 'Processing robot', 'Echo550']
];

export type Message = { level: 'error' | 'warning'; text: string };

/** The checks `metapool.plate.validate_plate_metadata` makes, per plate and across. */
export function validateDetails(plates: PlateDetails[]): Message[][] {
  const out = plates.map(() => [] as Message[]);
  const repeated = (key: keyof PlateDetails) => {
    const seen = new Map<string, number>();
    plates.forEach((p, i) => {
      const v = p[key];
      if (!v) return;
      if (seen.has(v)) out[i].push({ level: 'error', text: `${String(key)} "${v}" is repeated` });
      seen.set(v, i);
    });
  };
  plates.forEach((p, i) => {
    const m = out[i];
    if (!['1', '2', '3', '4'].includes(p.position))
      m.push({ level: 'error', text: 'Plate position must be 1, 2, 3 or 4' });
    const pp = Number(p.primerPlate);
    if (!Number.isInteger(pp) || pp < 1 || pp > 10)
      m.push({ level: 'error', text: `Primer plate # "${p.primerPlate}" is not between 1 and 10` });
    else if (String(pp) !== p.position)
      m.push({ level: 'warning', text: `Primer plate # ${pp} at position ${p.position} is unusual` });
    if (/\s/.test(p.samplePlate)) m.push({ level: 'warning', text: 'Spaces are not recommended in the sample plate name' });
    for (const [key, label] of DETAIL_FIELDS)
      if (!p[key].trim()) m.push({ level: 'error', text: `${label} is missing (write "not applicable")` });
    if (p.primerDate && !/^\d{4}-\d{2}-\d{2}$/.test(p.primerDate))
      m.push({ level: 'error', text: 'Primer date must be YYYY-MM-DD' });
    else if (p.primerDate && p.primerDate > new Date().toISOString().slice(0, 10))
      m.push({ level: 'warning', text: 'The primer date is in the future' });
  });
  repeated('position');
  repeated('primerPlate');
  repeated('samplePlate');
  return out;
}

// --- compression and barcodes (notebook steps 4 and 7) ---

/** CLIENT preview, SERVER authoritative: metapool's interleaved 4-quadrant
 *  compression. Position 1 takes odd rows/odd columns, 2 odd rows/even columns,
 *  3 even rows/odd columns, 4 even rows/even columns. */
export function to384(position: string, well96: string): string {
  const r = ROWS_96.indexOf(well96[0]);
  const c = Number(well96.slice(1)) - 1;
  const q = Number(position);
  const row = ROWS_384[2 * r + (q >= 3 ? 1 : 0)];
  const col = 2 * c + (q % 2 === 0 ? 1 : 0) + 1;
  return `${row}${col}`;
}

/** SERVER: the EMP Golay barcode for a well of a primer plate. Mocked as a stable
 *  12-mer; the real table is metapool's EMP primer plates, which the stored
 *  pre-flight carries and golay-demux checks the barcode map against. */
export function mockGolay(primerPlate: string, well96: string): string {
  let h = 2166136261;
  for (const ch of `${primerPlate}:${well96}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return Array.from({ length: 12 }, (_, i) => 'ACGT'[(h >>> (i * 2)) & 3]).join('');
}

/** A run folder on the ingest roots (SERVER: POST /run-folder/inspect). */
export const RUN_FOLDERS = [
  { id: '20261020_SL00377_0012_ASC2299011-SC3', instrument: 'MiSeq i100', cycles: '151x12x151', when: '2026-10-20' },
  { id: '20260925_SL00377_0008_ASC2267726-SC3', instrument: 'MiSeq i100', cycles: '151x12x151', when: '2026-09-25' }
];
