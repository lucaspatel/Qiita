// Test helpers: an amplicon prep set up as the UI leaves it after the demo box is
// loaded and its tubes are settled, and the model of it. Test-only (imported by
// *.test.ts); nothing in the app imports this.

import { demoBox, mockGolay, STUDIES, type Demo } from '../../mock/mock';
import { autoPlace, seedFacts } from '../layout';
import { deriveAmplicon, type AmpliconModel } from '../model';
import { mixedRacks, rememberStudies, resolve } from '../resolve';
import { EACH, emptyAmplicon, OTHER, type AmpliconPrep } from '../state';

export const barcodeOfDemo = (demo: Demo) => (primerPlate: string, well96: string) =>
  demo.barcodes.get(`${primerPlate}:${well96}`) ?? mockGolay(primerPlate, well96);

export const titleOf = (prep: AmpliconPrep) => (key: string) =>
  key === OTHER
    ? `${prep.studyFacts[OTHER]?.project_name || 'Sheet-only study'} (not in Qiita-miint)`
    : (STUDIES.find((s) => String(s.study_idx) === key)?.title ?? `#${key}`);

/** The demo box loaded, placed and settled: the made-up study's racks kept sheet-only,
 *  a mixed rack's blanks sent to every study. `settle: false` leaves the tubes as the
 *  scan resolved them. */
export function demoPrep({ settle = true }: { settle?: boolean } = {}): { prep: AmpliconPrep; demo: Demo } {
  const demo = demoBox();
  const prep = emptyAmplicon();
  prep.racks = demo.racks;
  autoPlace(prep, demo.plates);
  seedFacts(prep, { plates: demo.plates, studyFacts: demo.studyFacts, run: demo.run }, null);
  if (settle) {
    let resolved = resolve(prep, demo.registry);
    for (const x of resolved.unknown) prep.sheetOnly[prep.racks[x.r].rackId] = true;
    prep.studyFacts[OTHER] ??= { ...demo.otherStudy };
    resolved = resolve(prep, demo.registry);
    for (const r of mixedRacks(prep, resolved)) prep.blanksTo[prep.racks[r].rackId] = EACH;
  }
  rememberStudies(prep, resolve(prep, demo.registry));
  return { prep, demo };
}

export function modelOf(prep: AmpliconPrep, demo: Demo): AmpliconModel {
  return deriveAmplicon(prep, demo.registry, barcodeOfDemo(demo), titleOf(prep));
}
