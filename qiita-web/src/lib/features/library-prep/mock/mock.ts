// MOCKUP data for the Library prep flow. The demo box is half real and half made up:
// IBD's plates 5-6 come from a sample sheet the amplicon notebook produced
// (fixture.ts), and the run's other two plates are a made-up second study that is
// not in Qiita-miint, as a multi-study run has. Nothing here talks to Qiita.

import { IBD_PLATES_5_6 } from './fixture';
import { WELLS_96, positionOf } from '../amplicon/plate';
import type { Resolution } from '../amplicon/resolve';
import type { Plate, RunFacts, StudyFacts } from '../amplicon/sampleSheet';
import type { Rack, RackTube } from '../amplicon/visionmate';

/** A stand-in Golay barcode for a primer-plate well the fixture doesn't cover; the
 *  real table is metapool's EMP primer plates, which belong on the server. */
export function mockGolay(primerPlate: string, well96: string): string {
  if (!/^([1-9]|10)$/.test(primerPlate)) return '';
  let h = 2166136261;
  for (const ch of `${primerPlate}:${well96}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return Array.from({ length: 12 }, (_, i) => 'ACGT'[(h >>> (i * 2)) & 3]).join('');
}

// --- what Qiita-miint knows (the mock's stand-in for POST /biosample/resolve-roster) ---

export type Study = { study_idx: number; classicId: number; title: string };
/** The studies in Qiita-miint: IBD, and a made-up infant-gut study that has six
 *  tubes on the diet study's first rack (so that plate mixes studies). */
export const STUDIES: Study[] = [
  { study_idx: 25060, classicId: 15663, title: 'IBD' },
  { study_idx: 25071, classicId: 14812, title: 'Infant gut' }
];
const INFANT: StudyFacts = {
  project_name: 'INFANT_14812',
  project_abbreviation: 'INF',
  center_project_name: 'Infant gut',
  experiment_design_description: '16S sequencing of infant stool (made up for the demo)'
};

/** A made-up second study on the same run, not in Qiita-miint. */
const OTHER: StudyFacts = {
  project_name: 'DIET_14567',
  project_abbreviation: 'DIET',
  center_project_name: 'Diet pilot',
  experiment_design_description: '16S sequencing of a diet pilot (made up for the demo)'
};

export type Demo = {
  racks: Rack[];
  registry: Map<string, Resolution>;
  /** Defaults the tech would otherwise type: each rack's position and facts. */
  plates: Record<string, { position: string; facts: Plate }>;
  /** Barcodes by `primer_plate:well_96` (the fixture's real ones). */
  barcodes: Map<string, string>;
  studyFacts: Record<string, StudyFacts>;
  /** The made-up study's facts, offered when its plates go in as sheet-only. */
  otherStudy: StudyFacts;
  run: RunFacts;
};

export function demoBox(): Demo {
  const racks: Rack[] = [];
  const registry = new Map<string, Resolution>();
  const plates: Demo['plates'] = {};
  const barcodes = new Map<string, string>();
  const fix = IBD_PLATES_5_6;

  fix.plates.forEach((p, i) => {
    const rackId = `SC${String(5 + i).padStart(4, '0')}`;
    const tubes: RackTube[] = [];
    for (const [well96, tube, , control, barcode, well384] of p.wells) {
      const t = tube.padStart(10, '0');
      tubes.push({ well: well96, tube: t, rackId });
      registry.set(t, control ? { kind: 'blank' } : { kind: 'ok', qb: `QB${12695 + registry.size}`, study_idx: 25060 });
      barcodes.set(`${p.facts.primer_plate}:${well96}`, barcode);
      plates[rackId] ??= { position: positionOf(well96, well384), facts: { ...p.facts } };
    }
    racks.push({ fileName: `${rackId}.tsv`, rackId, tubes, problems: [] });
  });

  // The other study's two plates: positions 2 and 4, 94 samples + 2 blanks each.
  [7, 8].forEach((n, i) => {
    const rackId = `SC${String(n).padStart(4, '0')}`;
    const tubes = WELLS_96.map((well, w) => {
      const tube = String(365100000 + n * 1000 + w).padStart(10, '0');
      if (well === 'G12' || well === 'H12') registry.set(tube, { kind: 'blank' });
      else if (n === 7 && w < 6) registry.set(tube, { kind: 'ok', qb: `QB${13100 + w}`, study_idx: 25071 });
      return { well, tube, rackId };
    });
    racks.push({ fileName: `${rackId}.tsv`, rackId, tubes, problems: [] });
    plates[rackId] = {
      position: String(2 + 2 * i),
      facts: { ...fix.plates[0].facts, sample_plate: `Plate_${n - 6}`, primer_plate: String(2 + 2 * i) }
    };
  });

  return {
    racks,
    registry,
    plates,
    barcodes,
    studyFacts: { '25060': { ...fix.study }, '25071': { ...INFANT } },
    otherStudy: OTHER,
    run: { ...fix.run }
  };
}

/** A run folder on the ingest roots (server: POST /run-folder/inspect). */
export const RUN_FOLDERS = [
  { id: '20260925_SL00377_0008_ASC2267726-SC3', instrument: 'MiSeq i100', cycles: '151x12x151', when: '2026-09-25' },
  { id: '20261020_SL00377_0012_ASC2299011-SC3', instrument: 'MiSeq i100', cycles: '151x12x151', when: '2026-10-20' }
];
