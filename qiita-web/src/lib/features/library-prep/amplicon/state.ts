// The state of an amplicon prep: everything the tech has scanned, decided and typed,
// in one object. It is what a draft saves and restores, and what every other module
// here reads (resolve, layout, sheets) or writes (routing). Keeping it whole is what
// makes a draft complete by construction rather than by a list someone must remember
// to extend.

import type { Plate, RunFacts, SheetRow, StudyFacts } from './sampleSheet';
import type { Rack } from './visionmate';

/** A decision the tech made about one well while settling its tube. */
export type Decision = { primary?: number; exclude?: boolean; blank?: boolean };

/** Plate positions on the 384-well plate. */
export const POSITIONS = 4;

/** The study key of a rack kept for its sample sheet although Qiita-miint lacks it. */
export const OTHER = 'other';
/** `blanksTo` value: a mixed plate's blanks go into every study's sheet. */
export const EACH = 'each';

export type AmpliconPrep = {
  /** The scanned racks, in scan order; a rack's index is its key below (`r`). */
  racks: Rack[];
  /** Settling decisions, by `wellKey(r, well)`. */
  decisions: Record<string, Decision>;
  /** Racks of a study Qiita-miint lacks, kept for their sample sheet only, by rack ID. */
  sheetOnly: Record<string, boolean>;
  /** Samples the tech marked as blanks on the Plates step, by `wellKey`. */
  blankEdits: Record<string, true>;
  /** Where a mixed-study plate's blanks go — a study key or EACH — by rack ID. */
  blanksTo: Record<string, string>;
  /** Plate position (index 0..3) → rack index, or null when empty. */
  rackAt: (number | null)[];
  /** Plate position (index 0..3) → primer plate number. */
  primerAt: string[];
  /** Per-plate facts, by rack ID. */
  plateFacts: Record<string, Plate>;
  /** Per-study facts, by study key. */
  studyFacts: Record<string, StudyFacts>;
  run: RunFacts;
  /** Values typed into the sheet for columns with no other home, by study key then
   *  384-well ID (see columns.ts). */
  wellEdits: Record<string, Record<string, Partial<SheetRow>>>;
  /** The sheets each well was last in (one study's, or for a blank every study its
   *  rack's blanks go to), by `wellKey`: a well whose tube stops resolving stays in
   *  those sheets, flagged, instead of dropping out of them. */
  lastStudy: Record<string, string[]>;
};

export function emptyAmplicon(): AmpliconPrep {
  return {
    racks: [],
    decisions: {},
    sheetOnly: {},
    blankEdits: {},
    blanksTo: {},
    rackAt: Array.from({ length: POSITIONS }, () => null),
    primerAt: Array.from({ length: POSITIONS }, (_, i) => String(i + 1)),
    plateFacts: {},
    studyFacts: {},
    run: { run_date: '', instrument_model: '', platemap_generation_date: '' },
    wellEdits: {},
    lastStudy: {}
  };
}

/** The key a per-well record is stored under: rack index and 96-well ID. */
export const wellKey = (r: number, well: string) => `${r}:${well}`;

/** Remove rack `r0`, renumbering every record keyed by rack index so nothing is left
 *  pointing at the wrong rack. Records keyed by rack ID (its facts, sheet-only, where its
 *  blanks go) are kept, so rescanning the same rack brings back what was typed for it. */
export function removeRack(prep: AmpliconPrep, r0: number): void {
  if (!prep.racks[r0]) return;
  prep.racks = prep.racks.filter((_, r) => r !== r0);
  prep.rackAt = prep.rackAt.map((r) => (r === r0 ? null : r !== null && r > r0 ? r - 1 : r));
  const remap = <T>(rec: Record<string, T>): Record<string, T> =>
    Object.fromEntries(
      Object.entries(rec).flatMap(([k, v]) => {
        const sep = k.indexOf(':');
        const r = Number(k.slice(0, sep));
        return r === r0 ? [] : [[wellKey(r > r0 ? r - 1 : r, k.slice(sep + 1)), v]];
      })
    );
  prep.decisions = remap(prep.decisions);
  prep.blankEdits = remap(prep.blankEdits);
  prep.lastStudy = remap(prep.lastStudy);
}
