// The long-read (PacBio Revio) run-prep file — the standard columnar record of a
// Karst et al 2021 UMI-tagged rRNA-operon prep, the long-read analogue of the
// amplicon pre-prep sheet in sampleSheet.ts. One row per sample, keyed on
// `unique_sample_ID`; one PacBio barcode (LP_barcodes_ID) demultiplexes each.
//
// Column names and order mirror the lab's Revio run-prep spreadsheet (its
// `dataTable` sheet) verbatim, so the file this writes is the same shape the lab
// fills by hand. kl-run-preflight's legacy_csv path is the intended consumer: it
// reads this to author the pre-flight blob (the typed builders are the other path).
// The flow records what it knows — identities, barcodes, the method chemistry, the
// run facts — and leaves the bench-measured cells (concentrations, masses, volumes)
// blank until the lab's numbers are entered or imported, so a mid-prep checkpoint is
// always a valid file in this format.

/** Run/experiment-level facts, constant across every row of one prep file. */
export const LONGREAD_RUN_COLUMNS = [
  'experiment_ref',
  'prep_date',
  'sequencing_instrument',
  'sequencing_movie_time_hours',
  'sequencing_date'
] as const;

/** The method chemistry — constant across the pool. Defaults in KARST_5KB_METHOD. */
export const LONGREAD_METHOD_COLUMNS = [
  'amplicon_type',
  'PCR1_template_DNA_input_ng',
  'PCR1_Vol_uL',
  'PCR1_primer_fwd',
  'PCR1_primer_fwd_locus_sequence',
  'PCR1_primer_fwd_UMI',
  'PCR1_primer_fwd_adapter',
  'PCR1_primer_rev',
  'PCR1_primer_rev_locus',
  'PCR1_primer_rev_UMI',
  'PCR1_primer_rev_adapter',
  'PCR1_annealing',
  'PCR1_cleanup',
  'PCR2_template_DNA',
  'PCR2_Vol_uL',
  'PCR2_primer_fwd',
  'PCR2_primer_rev',
  'PCR2_annealing',
  'PCR2_extension',
  'automation',
  'cleanup_ratio',
  'cleanup_beads_type',
  'cleanup_elution_vol_uL'
] as const;

/** Per-sample fields: identity, barcode, and the bench-measured values that vary
 *  row to row. All but the identity/barcode come from the lab's measurements. */
export const LONGREAD_SAMPLE_COLUMNS = [
  'unique_sample_ID',
  'PCR1_template_DNA',
  'PCR2_Conc_ng_uL',
  'PCR2_Vol_uL_for_cleanup',
  'cleanup_input_ng',
  'post_cleanup_Conc_ng_uL',
  'post_cleanup_mass_ng',
  'LP_input_vol_uL',
  'LP_input_mass_ng',
  'LP_barcodes_well',
  'LP_barcodes_ID',
  'LP_post_nuclease_Conc_ng_uL',
  'LP_post_nuclease_Vol_uL',
  'library_pool_vol_uL',
  'library_pool_mass_ng'
] as const;

// Identity is `unique_sample_ID` alone. Unlike the short-read amplicon sheet there is
// no TubeCode: tech-dev long-read runs do not necessarily use matrix tubes, so the
// format assumes no tube. (A biosample linkage, when one exists, resolves from
// unique_sample_ID — it is not a column here.)

/** The full header, in the lab's order. This is the standard columnar format for a
 *  long-read prep — one-to-one with the lab's Revio run-prep spreadsheet. */
export const LONGREAD_SHEET_COLUMNS = [
  'unique_sample_ID',
  'experiment_ref',
  'prep_date',
  'amplicon_type',
  'PCR1_template_DNA',
  'PCR1_template_DNA_input_ng',
  'PCR1_Vol_uL',
  'PCR1_primer_fwd',
  'PCR1_primer_fwd_locus_sequence',
  'PCR1_primer_fwd_UMI',
  'PCR1_primer_fwd_adapter',
  'PCR1_primer_rev',
  'PCR1_primer_rev_locus',
  'PCR1_primer_rev_UMI',
  'PCR1_primer_rev_adapter',
  'PCR1_annealing',
  'PCR1_cleanup',
  'PCR2_template_DNA',
  'PCR2_Vol_uL',
  'PCR2_primer_fwd',
  'PCR2_primer_rev',
  'PCR2_annealing',
  'PCR2_extension',
  'PCR2_Conc_ng_uL',
  'PCR2_Vol_uL_for_cleanup',
  'automation',
  'cleanup_ratio',
  'cleanup_beads_type',
  'cleanup_input_ng',
  'cleanup_elution_vol_uL',
  'post_cleanup_Conc_ng_uL',
  'post_cleanup_mass_ng',
  'LP_input_vol_uL',
  'LP_input_mass_ng',
  'LP_barcodes_well',
  'LP_barcodes_ID',
  'LP_post_nuclease_Conc_ng_uL',
  'LP_post_nuclease_Vol_uL',
  'library_pool_vol_uL',
  'library_pool_mass_ng',
  'sequencing_instrument',
  'sequencing_movie_time_hours',
  'sequencing_date'
] as const;

export type LongReadColumn = (typeof LONGREAD_SHEET_COLUMNS)[number];
export type LongReadRow = Record<LongReadColumn, string>;
export type LongReadMethod = Record<(typeof LONGREAD_METHOD_COLUMNS)[number], string>;
export type LongReadRun = Partial<Record<(typeof LONGREAD_RUN_COLUMNS)[number], string>>;

/** One sample's identity and barcode; bench measurements optional (blank until the
 *  lab's numbers are in). Keyed on unique_sample_ID. */
export type LongReadSample = { unique_sample_ID: string; LP_barcodes_ID: string } & Partial<
  Record<(typeof LONGREAD_SAMPLE_COLUMNS)[number], string>
>;

/** The Karst et al 5 Kbp rRNA-operon method (16S 8F → 23S 2490R), UMI-tagged.
 *  Values are the lab's: the fixed chemistry every row of the prep file carries. */
export const KARST_5KB_METHOD: LongReadMethod = {
  amplicon_type: '5 Kbp',
  PCR1_template_DNA_input_ng: '5',
  PCR1_Vol_uL: '50',
  PCR1_primer_fwd: 'lu_16S_8F',
  PCR1_primer_fwd_locus_sequence: 'AGRGTTYGATYMTGGCTCAG',
  PCR1_primer_fwd_UMI: 'NNNYRNNNYRNNNYRNNN',
  PCR1_primer_fwd_adapter: 'CAAGCAGAAGACGGCATACGAGAT',
  PCR1_primer_rev: 'lu_23S_2490R',
  PCR1_primer_rev_locus: 'CGACATCGAGGTGCCAAAC',
  PCR1_primer_rev_UMI: 'NNNYRNNNYRNNNYRNNN',
  PCR1_primer_rev_adapter: 'AATGATACGGCGACCACCGAGATC',
  PCR1_annealing: '55 ℃',
  PCR1_cleanup: 'AMPure 1X',
  PCR2_template_DNA: 'clean_PCR1_product',
  PCR2_Vol_uL: '100',
  PCR2_primer_fwd: 'CAAGCAGAAGACGGCATACGAGAT',
  PCR2_primer_rev: 'AATGATACGGCGACCACCGAGATC',
  PCR2_annealing: '60 ℃',
  PCR2_extension: '6 minutes',
  automation: 'manual',
  cleanup_ratio: '1.3X',
  cleanup_beads_type: 'SMRTbell',
  cleanup_elution_vol_uL: '50'
};

/** Every column blank — the base each row fills over, so a row is always complete
 *  even when only the identity and barcode are known (a mid-prep checkpoint). */
const BLANK_ROW = Object.fromEntries(LONGREAD_SHEET_COLUMNS.map((c) => [c, ''])) as LongReadRow;

/** The header alone — a valid, empty run-prep file before any sample is in the pool. */
export function emptyLongReadSheet(): string {
  return LONGREAD_SHEET_COLUMNS.join('\t');
}

/** The run-prep file for a pool: the method chemistry and run facts on every row,
 *  one row per sample in pool order, bench-measured cells blank unless provided. */
export function buildLongReadSheet(
  samples: LongReadSample[],
  method: LongReadMethod,
  run: LongReadRun
): string {
  return longReadText(longReadRows(samples, method, run));
}

/** The rows `buildLongReadSheet` writes. */
export function longReadRows(samples: LongReadSample[], method: Partial<LongReadMethod>, run: LongReadRun): LongReadRow[] {
  return samples.map((s): LongReadRow => ({ ...BLANK_ROW, ...method, ...run, ...s }));
}

/** The file text for rows, header first. */
export function longReadText(rows: LongReadRow[]): string {
  return [emptyLongReadSheet(), ...rows.map((r) => LONGREAD_SHEET_COLUMNS.map((c) => r[c]).join('\t'))].join('\n');
}

/** The lab's filename convention: `<date>_<size>_<instrument>_run_prep.txt`
 *  (e.g. 20261016_5Kb_Revio_run_prep.txt). */
export function longReadFileName(method: LongReadMethod, run: LongReadRun): string {
  const date = (run.sequencing_date || '').replaceAll('-', '') || 'YYYYMMDD';
  const size = (method.amplicon_type || '').replace(/\s*Kbp$/i, 'Kb').replace(/\s+/g, '') || 'longread';
  const instr = run.sequencing_instrument || 'Revio';
  return `${date}_${size}_${instr}_run_prep.txt`;
}
