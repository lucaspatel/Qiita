// Column specs (lib/table/model) for the two pre-prep formats, so the TSV editor can
// validate and shape them. The column *names and order* stay owned by the sheet
// builders (sampleSheet.ts, longReadSheet.ts); here we only attach the rules that
// make a file submittable — the identity and barcode that must be present and unique.

import { type ColumnSpec, columnsFromNames } from '$lib/table/model';
import { SHEET_COLUMNS } from './amplicon/sampleSheet';
import { LONGREAD_SHEET_COLUMNS } from './long-read/longReadSheet';

/** Turn a flat column list into specs, overriding the few that carry rules. */
function specs(names: readonly string[], rules: Record<string, Partial<ColumnSpec>>): ColumnSpec[] {
  return columnsFromNames(names).map((c) => ({ ...c, ...rules[c.name] }));
}

/** Short-read amplicon pre-prep: one row per well, keyed on sample_name. */
export const AMPLICON_SPEC: ColumnSpec[] = specs(SHEET_COLUMNS, {
  sample_name: { required: true, unique: true },
  barcode: { required: true, unique: true, pattern: /^[ACGT]{12}$/, hint: 'Golay: 12 bases' },
  TubeCode: { hint: 'matrix tube' }
});

/** Long-read run-prep: one row per sample, keyed on unique_sample_ID; one PacBio
 *  barcode (LP_barcodes_ID) must demultiplex each. No matrix tube is assumed. */
export const LONGREAD_SPEC: ColumnSpec[] = specs(LONGREAD_SHEET_COLUMNS, {
  unique_sample_ID: { required: true, unique: true },
  LP_barcodes_ID: { required: true, unique: true, hint: 'PacBio barcode' }
});
