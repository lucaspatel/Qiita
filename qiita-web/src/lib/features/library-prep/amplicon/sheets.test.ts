import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SHEET_COLUMNS, emptySheet } from './sampleSheet';
import { checkpointFiles } from './sheets';
import { emptyAmplicon } from './state';
import { demoPrep, modelOf } from './testing/demo';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

describe('the demo prep\'s sheets', () => {
  const { prep, demo } = demoPrep();
  const m = modelOf(prep, demo);
  const byKey = Object.fromEntries(m.sheets.map((s) => [s.key, s]));

  it('builds one sheet per study, the mixed rack\'s blanks in each of its studies\'', () => {
    expect(m.sheets.map((s) => [s.key, s.built.length])).toEqual([
      ['25060', 192],
      ['25071', 8],
      ['other', 186]
    ]);
    const blanksOfMixed = (key: string) => byKey[key].built.filter((b) => b.row.control_description && b.well.r === 2).map((b) => b.row.well_id_384);
    expect(blanksOfMixed('25071')).toEqual(blanksOfMixed('other'));
  });

  // The IBD sheet was checked byte for byte against the sheet the amplicon notebook
  // wrote for these plates (2026-10-18). The hash pins that output without keeping a
  // second copy of the study's identifiers in the repo; set QIITA_GOLDEN_IBD to the
  // notebook's file to re-run the full comparison.
  it('writes the IBD sheet exactly as the amplicon notebook does', () => {
    expect(sha(byKey['25060'].text)).toBe('5e61708a76d3f381b006200696fbf1f981a356cf4825241ef31a24e730b321a0');
  });
  it.runIf(!!process.env.QIITA_GOLDEN_IBD && existsSync(process.env.QIITA_GOLDEN_IBD ?? ''))(
    'matches the notebook\'s own file, cell for cell',
    () => {
      const real = readFileSync(process.env.QIITA_GOLDEN_IBD!, 'utf8').replace(/\r\n/g, '\n').replace(/\n$/, '');
      expect(byKey['25060'].text).toBe(real);
    }
  );

  it('pins the other two sheets, so a change to the builder is a change to a test', () => {
    expect(sha(byKey['25071'].text)).toBe('d4da069204f3256449d966e8664b1021cacf2a854fc68062a6f20e4b3961eaf0');
    expect(sha(byKey.other.text)).toBe('51abfa20e85afc89c027e6f45f82b691963a06d4914bc755b517e7286a20b2d4');
  });

  it('names each file by run date, study and plate numbers', () => {
    expect(m.sheets.map((s) => s.fileName)).toEqual([
      '20260925_IL515fBC_806_IBD_15663_Plates_5-6.txt',
      '20260925_IL515fBC_806_INFANT_14812_Plates_1.txt',
      '20260925_IL515fBC_806_DIET_14567_Plates_1-2.txt'
    ]);
  });

  it('writes every row with every column, in the sheet\'s column order', () => {
    for (const s of m.sheets) {
      const [header, ...rows] = s.text.split('\n');
      expect(header.split('\t')).toEqual([...SHEET_COLUMNS]);
      for (const r of rows) expect(r.split('\t')).toHaveLength(SHEET_COLUMNS.length);
    }
  });

  it('has no problems once settled', () => {
    expect(m.problemsBySheet.flat()).toEqual([]);
    expect(m.general.filter((p) => p.level === 'error')).toEqual([]);
    expect(m.barcodeIssues).toEqual([]);
  });
});

describe('checkpointFiles', () => {
  it('offers a header-only sheet before anything is scanned', () => {
    const files = checkpointFiles(emptyAmplicon(), []);
    expect(files).toEqual([{ name: 'YYYYMMDD_IL515fBC_806_prep.txt', text: emptySheet() }]);
  });
});
