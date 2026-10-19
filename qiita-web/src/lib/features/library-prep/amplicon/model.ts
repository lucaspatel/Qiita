// Everything an amplicon prep's screens show, derived from its state in one pure call.
// The page holds the AmpliconPrep and a single `$derived(deriveAmplicon(...))`; the
// tests call the same function, so what they check is what the screens show.

import type { Problem } from '$lib/table/model';
import { AMPLICON_GRID_COLUMNS } from './columns';
import { factsAt, layoutProblems, placed, type Placed } from './layout';
import { generalProblems, sheetProblems } from './problems';
import { mixedRacks, resolve, type Registry, type Resolved } from './resolve';
import { STUDY_COLUMNS } from './sampleSheet';
import { buildSheets, checkpointFiles, plateBarcodeProblems, sheetWells, type AmpliconSheet, type BarcodeOf, type StudyWell } from './sheets';
import type { AmpliconPrep } from './state';
import { validatePlates, validateRun, validateStudy } from './validate';

const STUDY_LABELS = Object.fromEntries(STUDY_COLUMNS);

export type AmpliconModel = {
  resolved: Resolved;
  placed: Placed[];
  /** Racks whose samples span studies and that hold blanks. */
  mixed: number[];
  layoutProblems: string[];
  /** The plate facts' errors and warnings (the notebook's checks), deduplicated. */
  plateErrors: string[];
  plateWarnings: string[];
  /** Study and run facts' errors. */
  detailErrors: string[];
  wells: StudyWell[];
  sheets: AmpliconSheet[];
  barcodeIssues: string[];
  files: { name: string; text: string }[];
  /** Per-cell problems, per sheet in sheet order. */
  problemsBySheet: Problem[][];
  /** Problems the steps raise that aren't about one cell. */
  general: Problem[];
};

export function deriveAmplicon(prep: AmpliconPrep, registry: Registry, barcodeOf: BarcodeOf, titleOf: (study: string) => string): AmpliconModel {
  const resolved = resolve(prep, registry);
  const at = placed(prep);
  const layout = layoutProblems(prep, resolved);
  const messages = validatePlates(at.map(({ r, position }) => ({ position, facts: factsAt(prep, position, r) })));
  const dedupe = (level: 'error' | 'warning') => [...new Set(messages.filter((m) => m.level === level).map((m) => m.text))];
  const plateErrors = dedupe('error');
  const plateWarnings = dedupe('warning');
  const detailErrors = [
    ...resolved.studyKeys.flatMap((k) => (prep.studyFacts[k] ? validateStudy(titleOf(k), prep.studyFacts[k], STUDY_LABELS) : [])),
    ...validateRun(prep.run)
  ];
  const wells = sheetWells(prep, resolved, barcodeOf);
  const sheets = buildSheets(prep, resolved, wells);
  return {
    resolved,
    placed: at,
    mixed: mixedRacks(prep, resolved),
    layoutProblems: layout,
    plateErrors,
    plateWarnings,
    detailErrors,
    wells,
    sheets,
    barcodeIssues: plateBarcodeProblems(wells),
    files: checkpointFiles(prep, sheets),
    problemsBySheet: sheets.map((s) => sheetProblems(s, AMPLICON_GRID_COLUMNS, resolved)),
    general: generalProblems([...layout, ...plateErrors, ...detailErrors], plateWarnings)
  };
}
