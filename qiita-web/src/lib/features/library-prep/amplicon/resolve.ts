// Tube resolution: what each scanned well holds, given what Qiita-miint answers for its
// tube and what the tech has decided. Pure: the same prep and registry always give the
// same cells.

import { EACH, OTHER, wellKey, type AmpliconPrep } from './state';

/** What Qiita-miint answers for one tube code (server: POST /biosample/resolve-roster). */
export type Resolution =
  | { kind: 'ok'; qb: string; study_idx: number }
  | { kind: 'multi'; qb: string; studies: number[] }
  | { kind: 'blank' };

/** Tube code (10 digits, zero-padded) → resolution. A tube absent from it is unknown. */
export type Registry = ReadonlyMap<string, Resolution>;

/** What one well holds once resolved. */
export type Cell =
  | { state: 'sample'; study: string; qb: string | null }
  | { state: 'blank' }
  | { state: 'excluded' }
  | { state: 'unknown' }
  | { state: 'multi'; studies: number[] }
  | { state: 'duplicate'; other: string };

export type ResolvedWell = { r: number; well: string; tube: string; cell: Cell };

/** A cell's problem as a person reads it, or '' when it has none. */
export function problemOf(cell: Cell): string {
  if (cell.state === 'unknown') return 'not in Qiita-miint';
  if (cell.state === 'multi') return `in ${cell.studies.length} studies: choose one`;
  if (cell.state === 'duplicate') return `the same tube is also at ${cell.other}`;
  return '';
}

/** Where each tube was scanned, as "<rack> <well>". A well left out no longer holds
 *  its tube, so its twin stops being a duplicate. */
export function placesOf(prep: AmpliconPrep): Map<string, string[]> {
  const places = new Map<string, string[]>();
  prep.racks.forEach((rack, r) => {
    for (const t of rack.tubes)
      if (!prep.decisions[wellKey(r, t.well)]?.exclude)
        places.set(t.tube, [...(places.get(t.tube) ?? []), `${rack.rackId} ${t.well}`]);
  });
  return places;
}

function cellOf(prep: AmpliconPrep, registry: Registry, places: Map<string, string[]>, r: number, well: string, tube: string): Cell {
  const d = prep.decisions[wellKey(r, well)] ?? {};
  if (d.exclude) return { state: 'excluded' };
  if (d.blank || prep.blankEdits[wellKey(r, well)]) return { state: 'blank' };
  const at = places.get(tube) ?? [];
  if (at.length > 1) {
    const me = `${prep.racks[r].rackId} ${well}`;
    return { state: 'duplicate', other: at.filter((p) => p !== me).join(', ') };
  }
  const res = registry.get(tube);
  if (!res) return prep.sheetOnly[prep.racks[r].rackId] ? { state: 'sample', study: OTHER, qb: null } : { state: 'unknown' };
  if (res.kind === 'blank') return { state: 'blank' };
  if (res.kind === 'multi')
    return d.primary ? { state: 'sample', study: String(d.primary), qb: res.qb } : { state: 'multi', studies: res.studies };
  return { state: 'sample', study: String(res.study_idx), qb: res.qb };
}

/** Qiita studies (numeric keys) in ID order, then anything else. */
const byStudyKey = (a: string, b: string) => {
  const [x, y] = [Number(a), Number(b)];
  if (Number.isFinite(x) && Number.isFinite(y)) return x - y;
  return Number.isFinite(x) ? -1 : Number.isFinite(y) ? 1 : a.localeCompare(b);
};

export type Resolved = {
  /** Per rack, 96-well ID → its tube and cell. */
  cells: Record<string, { tube: string; cell: Cell }>[];
  /** Every scanned well, rack by rack in scan order. */
  all: ResolvedWell[];
  unknown: ResolvedWell[];
  multi: ResolvedWell[];
  dupes: ResolvedWell[];
  blanks: ResolvedWell[];
  /** Wells the tech still has to settle before the plates can be laid out. */
  needFix: number;
  /** The studies with at least one sample: Qiita studies by ID, then any sheet-only
   *  one. A fixed order, so tabs and colours don't shuffle as tubes are settled. */
  studyKeys: string[];
};

export function resolve(prep: AmpliconPrep, registry: Registry): Resolved {
  const places = placesOf(prep);
  const cells = prep.racks.map((rack, r) =>
    Object.fromEntries(rack.tubes.map((t) => [t.well, { tube: t.tube, cell: cellOf(prep, registry, places, r, t.well, t.tube) }]))
  );
  const all = cells.flatMap((rc, r) => Object.entries(rc).map(([well, v]) => ({ r, well, ...v })));
  const unknown = all.filter((x) => x.cell.state === 'unknown');
  const multi = all.filter((x) => x.cell.state === 'multi');
  const dupes = all.filter((x) => x.cell.state === 'duplicate');
  return {
    cells,
    all,
    unknown,
    multi,
    dupes,
    blanks: all.filter((x) => x.cell.state === 'blank'),
    needFix: unknown.length + multi.length + dupes.length,
    studyKeys: [...new Set(all.flatMap((x) => (x.cell.state === 'sample' ? [x.cell.study] : [])))].sort(byStudyKey)
  };
}

/** Record the sheets every resolved well is in now: a sample's study, a blank's
 *  studies (see AmpliconPrep.lastStudy). A well with nowhere to go yet (a mixed rack's
 *  blank before its study is chosen) keeps what it had. Returns whether anything
 *  changed, so a caller in an effect can skip a no-op write. */
export function rememberStudies(prep: AmpliconPrep, resolved: Resolved): boolean {
  let changed = false;
  for (const x of resolved.all) {
    const studies = x.cell.state === 'sample' ? [x.cell.study] : x.cell.state === 'blank' ? blankStudies(prep, resolved, x.r) : [];
    const k = wellKey(x.r, x.well);
    if (!studies.length || prep.lastStudy[k]?.join('\n') === studies.join('\n')) continue;
    prep.lastStudy[k] = studies;
    changed = true;
  }
  return changed;
}

/** The studies a rack's samples belong to, in well order. */
export function studiesOfRack(resolved: Resolved, r: number): string[] {
  return [...new Set(resolved.all.flatMap((x) => (x.r === r && x.cell.state === 'sample' ? [x.cell.study] : [])))];
}

/** Racks whose samples are of more than one study and that have blanks: their blanks
 *  need to be told which study's sheet they go in. */
export function mixedRacks(prep: AmpliconPrep, resolved: Resolved): number[] {
  return prep.racks.flatMap((_, r) =>
    studiesOfRack(resolved, r).length > 1 && resolved.blanks.some((x) => x.r === r) ? [r] : []
  );
}

/** The sheets rack `r`'s blanks go in: its one study's, or for a mixed rack the study
 *  the tech chose, every study's (EACH), or none until they choose. */
export function blankStudies(prep: AmpliconPrep, resolved: Resolved, r: number): string[] {
  const studies = studiesOfRack(resolved, r);
  if (studies.length <= 1) return studies;
  const to = prep.blanksTo[prep.racks[r].rackId];
  return to === EACH ? studies : to ? [to] : [];
}
