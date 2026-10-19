// The pre-prep sample sheets a prep builds: one per study, each well in the study's
// sheet built from the plate, study, run and scan it came from.

import { to384 } from './plate';
import { blankStudies, type Resolved } from './resolve';
import { buildSheetRows, emptySheet, sampleName, sheetText, type BuiltRow, type SheetRow, type SheetWell } from './sampleSheet';
import { factsAt, placed } from './layout';
import { barcodeProblems } from './validate';
import { wellKey, type AmpliconPrep } from './state';

/** The Golay barcode of a primer-plate well: the lab's primer plates (server-side in
 *  the real flow; the mock's table here). '' when unknown. */
export type BarcodeOf = (primerPlate: string, well96: string) => string;

/** A sheet well, with the study whose sheet it is in, and the name and barcode its
 *  sources give it (before any value typed into the sheet). */
export type StudyWell = SheetWell & { study: string; derivedName: string; derivedBarcode: string };

/** A sheet row, the well it was built from, and the row its sources alone would build
 *  (`base`): a value typed into the sheet that equals `base` is no edit at all. */
export type AmpliconRow = BuiltRow & { well: StudyWell; base: SheetRow };

/** Every well that goes into a sheet, study by study as they fall on the plates. A
 *  blank goes into each sheet its rack's blanks go to; a well whose tube has stopped
 *  resolving stays in the sheet of the study it last resolved to. A name or barcode
 *  typed into the sheet for a well wins over the derived one. */
export function sheetWells(prep: AmpliconPrep, resolved: Resolved, barcodeOf: BarcodeOf): StudyWell[] {
  return placed(prep).flatMap(({ r, position }) => {
    const plate = factsAt(prep, position, r);
    const toBlanks = blankStudies(prep, resolved, r);
    return Object.entries(resolved.cells[r] ?? {}).flatMap(([well96, v]) => {
      const blank = v.cell.state === 'blank';
      const remembered = prep.lastStudy[wellKey(r, well96)] ?? [];
      const unresolved = v.cell.state === 'unknown' || v.cell.state === 'multi' || v.cell.state === 'duplicate';
      if (!blank && v.cell.state !== 'sample' && !(unresolved && remembered.length)) return [];
      const studies = blank ? toBlanks : v.cell.state === 'sample' ? [v.cell.study] : remembered;
      const well384 = to384(position, well96);
      return studies.map((study) => {
        const typed = prep.wellEdits[study]?.[well384] ?? {};
        const derivedName = sampleName(v.tube, blank, prep.studyFacts[study]?.project_abbreviation ?? '', plate.sample_plate, well96);
        const derivedBarcode = barcodeOf(plate.primer_plate, well96);
        return {
          study,
          r,
          position,
          tube: v.tube,
          name: typed.sample_name ?? derivedName,
          control: blank ? 'negative_control' : '',
          well96,
          well384,
          barcode: typed.barcode ?? derivedBarcode,
          plate,
          derivedName,
          derivedBarcode
        };
      });
    });
  });
}

export type AmpliconSheet = {
  /** The study key. */
  key: string;
  wells: StudyWell[];
  /** The rows in sheet order, each with the well it was built from. */
  built: AmpliconRow[];
  fileName: string;
  text: string;
};

/** The date stamp file names start with: the run date as YYYYMMDD, or a placeholder. */
const stamp = (prep: AmpliconPrep) => prep.run.run_date.replaceAll('-', '') || 'YYYYMMDD';

/** One sheet per study with samples, in study order. Built even mid-prep: facts not
 *  entered yet are left blank rather than dropping the study. */
export function buildSheets(prep: AmpliconPrep, resolved: Resolved, wells: StudyWell[]): AmpliconSheet[] {
  return resolved.studyKeys.map((key) => {
    const own = wells.filter((w) => w.study === key);
    const f = prep.studyFacts[key];
    const plateNos = [...new Set(own.map((w) => w.plate.sample_plate.replace(/^\D*/, '')))].join('-');
    const typed = buildSheetRows(own, f ?? {}, prep.run, prep.wellEdits[key]);
    // The same wells as their sources alone build them, row for row (same order key).
    const base = buildSheetRows(own.map((w) => ({ ...w, name: w.derivedName, barcode: w.derivedBarcode })), f ?? {}, prep.run);
    const built: AmpliconRow[] = typed.map((b, i) => ({ well: b.well as StudyWell, row: b.row, base: base[i].row }));
    return {
      key,
      wells: own,
      built,
      fileName: `${stamp(prep)}_IL515fBC_806_${f?.project_name || key}_Plates_${plateNos}.txt`,
      text: sheetText(built.map((b) => b.row))
    };
  });
}

/** The files a checkpoint downloads: each study's sheet, or a header-only sheet before
 *  anything is scanned, so there is always something that mirrors the format. */
export function checkpointFiles(prep: AmpliconPrep, sheets: AmpliconSheet[]): { name: string; text: string }[] {
  if (sheets.length) return sheets.map((s) => ({ name: s.fileName, text: s.text }));
  return [{ name: `${stamp(prep)}_IL515fBC_806_prep.txt`, text: emptySheet() }];
}

/** The pre-flight's barcode problems across every sheet. A blank copied into several
 *  studies' sheets is one well, not a barcode clash. */
export function plateBarcodeProblems(wells: StudyWell[]): string[] {
  return barcodeProblems([...new Map(wells.map((w) => [w.well384, w])).values()]);
}
