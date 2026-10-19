// Plate layout: which rack sits at which position of the 384-well plate, with which
// primer plate, and the facts each plate carries.

import { PLATE_COLUMNS, type Plate, type RunFacts, type StudyFacts } from './sampleSheet';
import { mixedRacks, type Resolved } from './resolve';
import type { AmpliconPrep } from './state';

export const EMPTY_PLATE = Object.fromEntries(PLATE_COLUMNS.map(([k]) => [k, ''])) as Plate;

/** A rack in place: its index and its position ("1".."4"). */
export type Placed = { r: number; position: string };

/** The racks in position, in position order. A position naming a rack that no longer
 *  exists is skipped (rackAt can lag a removal by one update). */
export function placed(prep: AmpliconPrep): Placed[] {
  return prep.rackAt.flatMap((r, i) => (r === null || r >= prep.racks.length ? [] : [{ r, position: String(i + 1) }]));
}

/** The facts of the plate at `position` holding rack `r`: its own facts, with the
 *  primer plate of the position it sits in. */
export function factsAt(prep: AmpliconPrep, position: string, r: number): Plate {
  return { ...(prep.plateFacts[prep.racks[r].rackId] ?? EMPTY_PLATE), primer_plate: prep.primerAt[Number(position) - 1] };
}

/** What stops the layout being used: racks without a position or in two, a primer
 *  plate used twice, a mixed plate whose blanks have no study yet. */
export function layoutProblems(prep: AmpliconPrep, resolved: Resolved): string[] {
  const p: string[] = [];
  const at = placed(prep);
  const racks = new Set(at.map((x) => x.r));
  if (racks.size !== at.length) p.push('A rack is in two positions');
  if (racks.size !== prep.racks.length) p.push('Every rack needs a position');
  const primers = at.map((x) => prep.primerAt[Number(x.position) - 1]);
  if (new Set(primers).size !== primers.length) p.push('A primer plate is used twice');
  for (const r of mixedRacks(prep, resolved))
    if (!prep.blanksTo[prep.racks[r].rackId]) p.push(`Say which study ${prep.racks[r].rackId}'s blanks belong to`);
  return p;
}

/** Defaults a rack arrives with (the demo's, or a lab's standard layout). */
export type RackDefaults = Record<string, { position: string; facts: Plate }>;

/** Give every rack without a position one: its default position if that is free, else
 *  the first free one (taking the default's primer plate with it). A position whose
 *  rack is gone is freed. Returns whether anything moved. */
export function autoPlace(prep: AmpliconPrep, defaults: RackDefaults = {}): boolean {
  const fixed = prep.rackAt.map((r) => (r !== null && r < prep.racks.length ? r : null));
  prep.racks.forEach((rack, r) => {
    if (fixed.includes(r)) return;
    const want = defaults[rack.rackId];
    const at = want && fixed[Number(want.position) - 1] === null ? Number(want.position) - 1 : fixed.indexOf(null);
    if (at < 0) return;
    fixed[at] = r;
    if (want) prep.primerAt[at] = want.facts.primer_plate;
  });
  if (fixed.every((r, i) => r === prep.rackAt[i])) return false;
  prep.rackAt = fixed;
  return true;
}

/** What the last prep left behind for the next: its plate facts (bar the per-plate
 *  identity) and its instrument. */
export type LastPrep = { plate: Partial<Plate>; instrument_model: string };

/** Seed what the tech would otherwise type, never overwriting what they have: each
 *  new rack's facts from its defaults, else the last prep's; study and run facts from
 *  `known`. Returns whether a rack was seeded from the last prep. */
export function seedFacts(
  prep: AmpliconPrep,
  known: { plates?: RackDefaults; studyFacts?: Record<string, StudyFacts>; run?: RunFacts },
  last: LastPrep | null
): boolean {
  let fromLast = false;
  for (const rack of prep.racks) {
    if (prep.plateFacts[rack.rackId]) continue;
    const facts = known.plates?.[rack.rackId]?.facts;
    if (!facts && last) fromLast = true;
    prep.plateFacts[rack.rackId] = { ...(facts ?? { ...EMPTY_PLATE, ...last?.plate, sample_plate: '' }) };
  }
  for (const [k, v] of Object.entries(known.studyFacts ?? {})) prep.studyFacts[k] ??= { ...v };
  if (known.run && !prep.run.run_date) prep.run = { ...known.run };
  else if (!prep.run.instrument_model && last) prep.run.instrument_model = last.instrument_model;
  return fromLast;
}
