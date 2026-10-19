// Edits made to a sheet, routed to the state each column belongs to (columns.ts). The
// sheet is a view of the prep: an edit changes the prep, and the sheet is rebuilt from
// it, so the sheet, the steps and the checkpoint cannot disagree.

import type { CellEdit } from '$lib/table/model';
import { AMPLICON_OWNERS } from './columns';
import { STUDY_COLUMNS, type SheetRow, type StudyFacts } from './sampleSheet';
import type { AmpliconSheet } from './sheets';
import type { AmpliconPrep } from './state';
import { TUBE_DIGITS } from './visionmate';

/** The tube code to store for a value typed over a scanned one, or null when it names
 *  the same tube. The sheet shows a code without its leading zeroes (as the notebook
 *  writes it) while the scan keeps them, so an all-digit code is padded to Qiita's
 *  width, as the scan parser pads it; anything else is kept as typed (and won't
 *  resolve, which flags it). */
export function normalizeTube(typed: string, scanned: string): string | null {
  const value = typed.trim();
  const tube = /^\d{1,10}$/.test(value) ? value.padStart(TUBE_DIGITS, '0') : value;
  return tube === scanned ? null : tube;
}

/** The piece of state an edit writes, as a key two edits share exactly when they write
 *  the same place — every row of a plate shares its plate's facts, every row of a
 *  sheet its study's and the run's. Null for an edit that writes nothing. */
export function slotOf(prep: AmpliconPrep, sheet: AmpliconSheet, edit: CellEdit): string | null {
  const b = sheet.built[edit.row];
  const owner = AMPLICON_OWNERS[edit.column];
  if (!b || !owner) return null;
  switch (owner.kind) {
    case 'locked':
      return null;
    case 'primer_plate':
      return `primer:${b.well.position}`;
    case 'plate':
      return `plate:${prep.racks[b.well.r]?.rackId}:${owner.column}`;
    case 'study':
      return `study:${sheet.key}:${owner.column}`;
    case 'run':
      return `run:${owner.column}`;
    case 'tube':
      return `tube:${b.well.r}:${b.well.well96}`;
    case 'row':
      return `row:${sheet.key}:${b.well.well384}:${edit.column}`;
  }
}

/** Apply a batch of edits to one sheet's rows. Rows are by index into `sheet.built`;
 *  an edit to a locked column, an unknown column or a row past the end is dropped. */
export function applyEdits(prep: AmpliconPrep, sheet: AmpliconSheet, edits: CellEdit[]): void {
  for (const { row, column, value } of edits) {
    const b = sheet.built[row];
    const owner = AMPLICON_OWNERS[column];
    if (!b || !owner) continue;
    const rackId = prep.racks[b.well.r]?.rackId;
    switch (owner.kind) {
      case 'locked':
        break;
      case 'primer_plate':
        prep.primerAt[Number(b.well.position) - 1] = value;
        break;
      case 'plate':
        if (rackId && prep.plateFacts[rackId]) prep.plateFacts[rackId][owner.column] = value;
        break;
      case 'study':
        prep.studyFacts[sheet.key] ??= Object.fromEntries(STUDY_COLUMNS.map(([k]) => [k, ''])) as StudyFacts;
        prep.studyFacts[sheet.key][owner.column] = value;
        break;
      case 'run':
        prep.run[owner.column] = value;
        break;
      case 'tube': {
        const tube = prep.racks[b.well.r]?.tubes.find((t) => t.well === b.well.well96);
        const next = tube ? normalizeTube(value, tube.tube) : null;
        if (tube && next !== null) tube.tube = next;
        break;
      }
      case 'row': {
        // A value equal to what the sources give is no override: dropping it lets the
        // cell follow its sources again (an undo, or a typed value matching the sheet).
        const col = column as keyof SheetRow;
        const perStudy = (prep.wellEdits[sheet.key] ??= {});
        const perWell = (perStudy[b.well.well384] ??= {});
        if (value === b.base[col]) delete perWell[col];
        else perWell[col] = value;
        if (!Object.keys(perWell).length) delete perStudy[b.well.well384];
        if (!Object.keys(perStudy).length) delete prep.wellEdits[sheet.key];
        break;
      }
    }
  }
}
