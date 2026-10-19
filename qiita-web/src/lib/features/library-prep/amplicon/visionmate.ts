// VisionMate rack-reader exports: a rack scan in, a rack scan out.

import { WELLS_96 } from './plate';

/** One tube as the VisionMate rack reader reports it. */
export type RackTube = { well: string; tube: string; rackId: string };
export type Rack = { fileName: string; rackId: string; tubes: RackTube[]; problems: string[] };

/** A tube code's width: Qiita writes them as 10 digits, zero-padded. */
export const TUBE_DIGITS = 10;

/** The columns every VisionMate export carries; a file missing one is not a rack scan. */
export const VISIONMATE_COLUMNS = ['TubeCode', 'LocationCell', 'LocationColumn', 'LocationRow', 'RackID', 'Time', 'Date'];

/** Parse a VisionMate export. Tube codes are normalised to Qiita's 10-digit form
 *  (spreadsheets eat leading zeroes). A rack with any problem is refused whole:
 *  a scan that can't be trusted in one well can't be trusted in the others. A tube
 *  scanned twice is not a problem here; Fix settles it with the other duplicates. */
export function parseVisionMate(fileName: string, text: string): Rack {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const header = (lines.shift() ?? '').split('\t').map((h) => h.trim());
  const missing = VISIONMATE_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length)
    return { fileName, rackId: '?', tubes: [], problems: [`not a VisionMate scan: no ${missing.join(', ')} column`] };
  const [iTube, iCell, iCol, iRow, iRack] = VISIONMATE_COLUMNS.map((n) => header.indexOf(n));
  const problems: string[] = [];
  const tubes: RackTube[] = [];
  const rackIds = new Set<string>();
  for (const line of lines) {
    const f = line.split('\t').map((x) => x.trim());
    const well = (f[iCell] ?? '').toUpperCase();
    const raw = f[iTube] ?? '';
    if (!WELLS_96.includes(well)) {
      problems.push(`"${line.slice(0, 40)}": ${well || 'no'} well is not on a 96-well rack`);
      continue;
    }
    if (`${(f[iRow] ?? '').toUpperCase()}${Number(f[iCol])}` !== well)
      problems.push(`${well}: its row and column say ${f[iRow]}${f[iCol]}`);
    if (f[iRack]) rackIds.add(f[iRack]);
    if (!raw || /^no ?read$|^no ?tube$/i.test(raw)) continue; // an empty position
    if (!/^\d{1,10}$/.test(raw)) {
      problems.push(`${well}: "${raw}" is not a tube code`);
      continue;
    }
    tubes.push({ well, tube: raw.padStart(TUBE_DIGITS, '0'), rackId: f[iRack] });
  }
  if (rackIds.size > 1) problems.push(`rows name ${rackIds.size} racks: ${[...rackIds].join(', ')}`);
  if (!tubes.length) problems.push('no readable tubes');
  return { fileName, rackId: [...rackIds][0] || fileName.replace(/\.\w+$/, ''), tubes, problems };
}

export function toVisionMate(rack: Rack): string {
  const rows = rack.tubes.map(
    (t) => `${t.tube}\t${t.well}\t${t.well.slice(1)}\t${t.well[0]}\t${rack.rackId}\t105935\t20260918`
  );
  return ['TubeCode\tLocationCell\tLocationColumn\tLocationRow\tRackID\tTime\tDate', ...rows].join('\n');
}
