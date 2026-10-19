import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { issueIndex, parseTsv, toTsv, tsvHeader, TsvHeaderError, unknownColumns, validate, type ColumnSpec } from './model';

const cols = (...names: string[]): ColumnSpec[] => names.map((name) => ({ name }));

describe('parseTsv', () => {
  it('reads Unix, Windows and old-Mac line endings, and a byte-order mark, the same', () => {
    const want = parseTsv('a\tb\n1\t2\n');
    for (const text of ['a\tb\r\n1\t2\r\n', 'a\tb\r1\t2', '﻿a\tb\n1\t2'])
      expect(parseTsv(text)).toEqual(want);
  });

  it('trims header names, so a stray space does not lose a column', () => {
    expect(parseTsv(' a \tb\n1\t2', cols('a', 'b')).rows).toEqual([{ a: '1', b: '2' }]);
  });

  it('projects a file onto a spec: missing columns blank, unknown ones dropped', () => {
    expect(parseTsv('b\tzzz\n2\tx', cols('a', 'b')).rows).toEqual([{ a: '', b: '2' }]);
    expect(unknownColumns('b\tzzz\n2\tx', cols('a', 'b'))).toEqual(['zzz']);
  });

  it('pads a short row with blanks', () => {
    expect(parseTsv('a\tb\tc\n1', cols('a', 'b', 'c')).rows).toEqual([{ a: '1', b: '', c: '' }]);
  });

  it('refuses a header that names a column twice', () => {
    expect(() => tsvHeader('a\tb\ta\n1\t2\t3')).toThrow(TsvHeaderError);
    expect(() => parseTsv('a\ta\n1\t2')).toThrow(/names a column twice: a/);
  });

  it('reads an empty file as no rows', () => {
    expect(parseTsv('', cols('a')).rows).toEqual([]);
    expect(parseTsv('a\tb\n').rows).toEqual([]);
  });

  it('round-trips any table through toTsv and parseTsv', () => {
    const cell = fc.string({ unit: fc.constantFrom('a', 'Z', '0', ' ', '.', '_', '-', 'é') });
    fc.assert(
      fc.property(fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9_]{0,8}$/), { minLength: 1, maxLength: 6 }), fc.nat(5), (names, n) => {
        const columns = cols(...names);
        const rows = fc.sample(fc.record(Object.fromEntries(names.map((k) => [k, cell]))), n + 1) as Record<string, string>[];
        // A row of only blanks is indistinguishable from a trailing empty line; the
        // sheets never write one, so it is out of scope here.
        const kept = rows.filter((r) => Object.values(r).some((v) => v !== ''));
        expect(parseTsv(toTsv({ columns, rows: kept }), columns).rows).toEqual(kept);
      })
    );
  });
});

describe('validate', () => {
  const spec: ColumnSpec[] = [
    { name: 'id', required: true, unique: true },
    { name: 'kind', enum: ['a', 'b'] },
    { name: 'code', pattern: /^[ACGT]{3}$/ },
    { name: 'n', validate: (v) => (v && isNaN(Number(v)) ? 'not a number' : null) }
  ];

  it('flags each rule, by row and column', () => {
    const rows = [
      { id: 'x', kind: 'a', code: 'ACG', n: '1' },
      { id: 'x', kind: 'c', code: 'AC', n: 'one' },
      { id: '', kind: '', code: '', n: '' }
    ];
    expect(validate({ columns: spec, rows })).toEqual([
      { row: 0, column: 'id', message: 'duplicate value' },
      { row: 1, column: 'id', message: 'duplicate value' },
      { row: 1, column: 'kind', message: 'not one of: a, b' },
      { row: 1, column: 'code', message: 'invalid format' },
      { row: 1, column: 'n', message: 'not a number' },
      { row: 2, column: 'id', message: 'required' }
    ]);
  });

  it('indexes several issues on one cell into one message', () => {
    const idx = issueIndex([
      { row: 0, column: 'a', message: 'one' },
      { row: 0, column: 'a', message: 'two' }
    ]);
    expect(idx.get('0:a')).toBe('one; two');
  });
});
