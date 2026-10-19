// The amplicon sample sheet (the notebook's "pre-prep file", one per study), written
// from a prep's plates. It is what kl-run-preflight turns into the SQLite pre-flight
// a golay-demux ticket carries.
// Column order and values follow the sheets the lab produces today.

import { WELLS_96 } from './plate';

export const SHEET_COLUMNS = [
  'sample_name', 'barcode', 'primer', 'primer_plate', 'well_id_384', 'plating',
  'extractionkit_lot', 'extraction_robot', 'tm1000_8_tool', 'primer_date', 'mastermix_lot',
  'water_lot', 'processing_robot', 'tm300_8_tool', 'tm50_8_tool', 'tm10_8_tool', 'sample_plate',
  'project_name', 'orig_name', 'well_description', 'experiment_design_description',
  'library_construction_protocol', 'linker', 'platform', 'run_center', 'run_date', 'run_prefix',
  'pcr_primers', 'sequencing_meth', 'target_gene', 'target_subfragment', 'center_name',
  'center_project_name', 'instrument_model', 'runid', 'TubeCode', 'control_description',
  'platemap_generation_date', 'project_abbreviation', 'vol_extracted_elution_ul', 'well_id_96'
] as const;
export type SheetRow = Record<(typeof SHEET_COLUMNS)[number], string>;

/** Fixed by the protocol and target (16S V4, EMP 515fbc/806r): never typed. */
export const PROTOCOL_16S = {
  primer: 'GTGYCAGCMGCCGCGGTAA',
  linker: 'GT',
  pcr_primers: 'FWD:GTGYCAGCMGCCGCGGTAA; REV:GGACTACNVGGGTWTCTAAT',
  target_gene: '16S rRNA',
  target_subfragment: 'V4',
  library_construction_protocol: 'Illumina EMP protocol 515fbc, 806r amplification of 16S rRNA V4',
  platform: 'Illumina',
  sequencing_meth: 'Sequencing by synthesis',
  run_center: 'UCSDMI',
  center_name: 'UCSDMI'
};

/** Per-plate facts, keyed by their sheet column. */
export const PLATE_COLUMNS = [
  ['sample_plate', 'Sample plate'],
  ['primer_plate', 'Primer plate #'],
  ['plating', 'Plating (initials)'],
  ['extractionkit_lot', 'Extraction kit lot'],
  ['extraction_robot', 'Extraction robot'],
  ['vol_extracted_elution_ul', 'Elution volume (µl)'],
  ['primer_date', 'Primer date'],
  ['mastermix_lot', 'MasterMix lot'],
  ['water_lot', 'Water lot'],
  ['processing_robot', 'Processing robot'],
  ['tm1000_8_tool', 'TM1000 8 tool'],
  ['tm300_8_tool', 'TM300 8 tool'],
  ['tm50_8_tool', 'TM50 8 tool'],
  ['tm10_8_tool', 'TM10 8 tool']
] as const;
export type PlateColumn = (typeof PLATE_COLUMNS)[number][0];
export type Plate = Record<PlateColumn, string>;

/** Per-study facts, keyed by their sheet column. */
export const STUDY_COLUMNS = [
  ['project_name', 'Project name'],
  ['project_abbreviation', 'Abbreviation'],
  ['center_project_name', 'Center project name'],
  ['experiment_design_description', 'Experiment design']
] as const;
export type StudyColumn = (typeof STUDY_COLUMNS)[number][0];
export type StudyFacts = Record<StudyColumn, string>;

export type RunFacts = { run_date: string; instrument_model: string; platemap_generation_date: string };

/** The notebook's naming: a sample is its tube code without leading zeroes, a blank
 *  BLANK.<abbreviation>.<plate number>.<96 well>. */
export function sampleName(tube: string, blank: boolean, abbreviation: string, samplePlate: string, well96: string): string {
  return blank
    ? `BLANK.${abbreviation}.${samplePlate.replace(/^\D*/, '')}.${well96}`
    : tube.replace(/^0+/, '');
}

/** Every column blank — the base each row fills in, so a row is always complete
 *  even when the study, plate or run facts have not been entered yet (a checkpoint
 *  taken mid-prep leaves those cells empty rather than dropping the row). */
const BLANK_ROW = Object.fromEntries(SHEET_COLUMNS.map((c) => [c, ''])) as SheetRow;

/** The pre-prep header alone — a valid, empty checkpoint before anything is scanned. */
export function emptySheet(): string {
  return SHEET_COLUMNS.join('\t');
}

/** One well as a sheet row is built from. `r` is its rack, so an edit to the row can
 *  find the scan it came from. */
export type SheetWell = {
  r: number;
  position: string;
  tube: string;
  name: string;
  control: string;
  well96: string;
  well384: string;
  barcode: string;
  plate: Plate;
};

/** A sheet row and the well it was built from. */
export type BuiltRow = { well: SheetWell; row: SheetRow };

/** The rows for one study: its wells plate by plate (by position) in row order,
 *  every column filled from the protocol, the study, the plate, the well and the
 *  run, then from `overrides` (a value typed into the sheet itself for that well,
 *  keyed by `well384`). Study and run facts may be partial (a mid-prep checkpoint) —
 *  missing cells are left blank. Tube codes lose their leading zeroes, as the
 *  notebook writes them. */
export function buildSheetRows(
  wells: SheetWell[],
  study: Partial<StudyFacts>,
  run: Partial<RunFacts>,
  overrides: Record<string, Partial<SheetRow>> = {}
): BuiltRow[] {
  const order = (w: { position: string; well96: string }) =>
    Number(w.position) * 1000 + WELLS_96.indexOf(w.well96);
  return [...wells]
    .sort((a, b) => order(a) - order(b))
    .map((w) => ({
      well: w,
      row: {
        ...BLANK_ROW,
        ...PROTOCOL_16S,
        ...w.plate,
        ...study,
        ...run,
        sample_name: w.name,
        orig_name: w.name,
        barcode: w.barcode,
        well_id_384: w.well384,
        well_id_96: w.well96,
        well_description: `${w.plate.sample_plate ?? ''}.${w.name}.${w.well384}`,
        TubeCode: w.tube.replace(/^0+/, ''),
        control_description: w.control,
        run_prefix: '',
        runid: '',
        ...overrides[w.well384]
      }
    }));
}

/** The sheet text for rows `buildSheetRows` built. */
export function sheetText(rows: SheetRow[]): string {
  return [emptySheet(), ...rows.map((r) => SHEET_COLUMNS.map((c) => r[c]).join('\t'))].join('\n');
}

/** The sheet for one study, as text (see `buildSheetRows`). */
export function buildSheet(
  wells: SheetWell[],
  study: Partial<StudyFacts>,
  run: Partial<RunFacts>,
  overrides: Record<string, Partial<SheetRow>> = {}
): string {
  return sheetText(buildSheetRows(wells, study, run, overrides).map((b) => b.row));
}
