// The amplicon notebook's checks (metapool.plate.validate_plate_metadata), plus the
// pre-flight's barcode check.

import type { Plate, StudyFacts } from './sampleSheet';

export type Message = { level: 'error' | 'warning'; text: string };

const NON_ASCII = /[^\x00-\x7f]/;
/** Today as YYYY-MM-DD, for the primer-date check. */
const today = () => new Date().toISOString().slice(0, 10);

export function validatePlates(plates: { position: string; facts: Plate }[]): Message[] {
  const out: Message[] = [];
  const repeated = (label: string, values: string[]) => {
    const seen = new Set<string>();
    for (const v of values) {
      if (v && seen.has(v)) out.push({ level: 'error', text: `${label} "${v}" is used twice` });
      seen.add(v);
    }
  };
  for (const { position, facts: f } of plates) {
    const at = `Position ${position}`;
    const pp = Number(f.primer_plate);
    if (!/^\d+$/.test(f.primer_plate) || pp < 1 || pp > 10)
      out.push({ level: 'error', text: `${at}: primer plate # "${f.primer_plate}" is not between 1 and 10` });
    else if (pp >= 9)
      out.push({ level: 'warning', text: `${at}: primer plate ${pp} is unusual; check it` });
    for (const [k, v] of Object.entries(f)) {
      if (!v.trim()) out.push({ level: 'error', text: `${at}: ${k} is empty (write not_applicable)` });
      if (NON_ASCII.test(v)) out.push({ level: 'error', text: `${at}: ${k} has a non-ASCII character` });
    }
    if (/\s/.test(f.sample_plate)) out.push({ level: 'warning', text: `${at}: spaces in the sample plate name` });
    if (f.primer_date && !/^\d{4}-\d{2}-\d{2}$/.test(f.primer_date))
      out.push({ level: 'error', text: `${at}: primer date must be YYYY-MM-DD` });
    else if (f.primer_date > today())
      out.push({ level: 'warning', text: `${at}: primer date ${f.primer_date} is in the future` });
  }
  repeated('Primer plate', plates.map((p) => p.facts.primer_plate));
  repeated('Sample plate', plates.map((p) => p.facts.sample_plate));
  return out;
}

/** A study's facts: all filled, ASCII, a project name ending in its Qiita study ID,
 *  and an abbreviation that is safe inside a blank's sample name. */
export function validateStudy(title: string, f: StudyFacts, labels: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(f)) {
    if (!v.trim()) out.push(`${title}: ${labels[k] ?? k} is empty`);
    else if (NON_ASCII.test(v)) out.push(`${title}: ${labels[k] ?? k} has a non-ASCII character`);
  }
  if (f.project_name.trim() && !/_\d+$/.test(f.project_name))
    out.push(`${title}: project name must end in _<Qiita study ID>, like IBD_15663`);
  if (f.project_abbreviation.trim() && !/^[A-Za-z0-9.-]+$/.test(f.project_abbreviation))
    out.push(`${title}: abbreviation may only use letters, digits, "." and "-"`);
  return out;
}

/** The pre-flight's barcode check: every well has a 12-base Golay barcode, and no
 *  two wells share one (demux could not tell them apart). */
export function barcodeProblems(wells: { well384: string; name: string; barcode: string }[]): string[] {
  const out: string[] = [];
  const missing = wells.filter((w) => !/^[ACGT]{12}$/.test(w.barcode));
  if (missing.length)
    out.push(`${missing.length} wells have no barcode: ${missing.slice(0, 5).map((w) => w.well384).join(', ')}${missing.length > 5 ? '…' : ''}`);
  const seen = new Map<string, string>();
  for (const w of wells) {
    if (!w.barcode) continue;
    const other = seen.get(w.barcode);
    if (other) out.push(`${w.well384} and ${other} share barcode ${w.barcode}`);
    else seen.set(w.barcode, w.well384);
  }
  return out;
}

/** Fewer negative controls than this on a run draws a warning (the notebook's rule). */
export const MIN_BLANKS = 6;

/** A run's facts: a YYYY-MM-DD run date, and ASCII throughout. */
export function validateRun(run: Record<string, string>): string[] {
  return [
    ...(/^\d{4}-\d{2}-\d{2}$/.test(run.run_date ?? '') ? [] : ['Run date must be YYYY-MM-DD']),
    ...Object.entries(run).flatMap(([k, v]) => (NON_ASCII.test(v) ? [`Run: ${k} has a non-ASCII character`] : []))
  ];
}
