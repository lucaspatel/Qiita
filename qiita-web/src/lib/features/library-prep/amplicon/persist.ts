// Saving and restoring an amplicon prep. A draft is the prep object itself, so a field
// added to AmpliconPrep is saved without anyone remembering to list it. Restoring
// checks every field's shape: a draft is read back from browser storage, which may hold
// one written by an older version or damaged, and half-restoring one would leave the
// steps and the sheet built from state no screen can show.

import { emptyAmplicon, POSITIONS, type AmpliconPrep } from './state';

/** A stored draft whose amplicon state can't be restored, naming the field at fault. */
export class DraftShapeError extends Error {
  constructor(public readonly field: string, problem: string) {
    super(`saved prep can't be restored: ${field} ${problem}`);
    this.name = 'DraftShapeError';
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The fields of AmpliconPrep that are string-keyed records, and the type of a value. */
const RECORDS: Record<string, (v: unknown) => boolean> = {
  decisions: isRecord,
  sheetOnly: (v) => typeof v === 'boolean',
  blankEdits: (v) => v === true,
  blanksTo: (v) => typeof v === 'string',
  plateFacts: (v) => isRecord(v) && Object.values(v).every((x) => typeof x === 'string'),
  studyFacts: (v) => isRecord(v) && Object.values(v).every((x) => typeof x === 'string'),
  wellEdits: (v) => isRecord(v) && Object.values(v).every((x) => isRecord(x) && Object.values(x).every((y) => typeof y === 'string')),
  // A list of study keys; a draft from before blanks were remembered holds one key.
  lastStudy: (v) => typeof v === 'string' || (Array.isArray(v) && v.every((x) => typeof x === 'string'))
};

/** The amplicon state in a stored draft. Drafts saved before the prep was one object
 *  kept its fields at the top level; those read the same. A field the draft lacks
 *  starts empty; a field it has in the wrong shape throws DraftShapeError. */
export function restoreAmplicon(draft: unknown): AmpliconPrep {
  if (!isRecord(draft)) throw new DraftShapeError('the draft', 'is not an object');
  const src = isRecord(draft.amplicon) ? draft.amplicon : draft;
  const prep = emptyAmplicon();

  if (src.racks !== undefined) {
    if (!Array.isArray(src.racks)) throw new DraftShapeError('racks', 'is not a list');
    src.racks.forEach((rack, i) => {
      if (!isRecord(rack) || typeof rack.rackId !== 'string' || !Array.isArray(rack.tubes))
        throw new DraftShapeError(`racks[${i}]`, 'is not a rack scan');
      for (const t of rack.tubes)
        if (!isRecord(t) || typeof t.well !== 'string' || typeof t.tube !== 'string')
          throw new DraftShapeError(`racks[${i}].tubes`, 'holds an entry that is not a tube');
    });
    prep.racks = src.racks as AmpliconPrep['racks'];
  }
  for (const [field, valueOk] of Object.entries(RECORDS)) {
    const v = src[field];
    if (v === undefined) continue;
    if (!isRecord(v)) throw new DraftShapeError(field, 'is not a record');
    for (const [k, x] of Object.entries(v)) if (!valueOk(x)) throw new DraftShapeError(`${field}.${k}`, 'has the wrong shape');
    (prep as Record<string, unknown>)[field] =
      field === 'lastStudy' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === 'string' ? [x] : x])) : v;
  }
  if (src.rackAt !== undefined) {
    const ok =
      Array.isArray(src.rackAt) &&
      src.rackAt.length === POSITIONS &&
      src.rackAt.every((r) => r === null || (Number.isInteger(r) && (r as number) >= 0 && (r as number) < prep.racks.length));
    if (!ok) throw new DraftShapeError('rackAt', `is not ${POSITIONS} positions each naming a scanned rack or none`);
    prep.rackAt = src.rackAt as (number | null)[];
  }
  if (src.primerAt !== undefined) {
    if (!Array.isArray(src.primerAt) || src.primerAt.length !== POSITIONS || !src.primerAt.every((p) => typeof p === 'string'))
      throw new DraftShapeError('primerAt', `is not ${POSITIONS} primer plates`);
    prep.primerAt = src.primerAt as string[];
  }
  if (src.run !== undefined) {
    if (!isRecord(src.run) || !Object.values(src.run).every((x) => typeof x === 'string'))
      throw new DraftShapeError('run', 'is not a set of run facts');
    prep.run = { ...prep.run, ...(src.run as Record<string, string>) };
  }
  return prep;
}
