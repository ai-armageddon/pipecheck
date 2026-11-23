import { jsonToCsv, parseCsv, rowsToCsv } from './csv';

describe('CSV browser helpers', () => {
  test('parses quoted commas, escaped quotes, and newlines', () => {
    const parsed = parseCsv('name,notes\r\n"Smith, Jane","Said ""hello""\nand left"\r\n');

    expect(parsed.headers).toEqual(['name', 'notes']);
    expect(parsed.rows).toEqual([['Smith, Jane', 'Said "hello"\nand left']]);
  });

  test('serializes cells without corrupting delimiters', () => {
    const csv = rowsToCsv(['name', 'city'], [['Jane', 'Austin, Metro']]);

    expect(csv).toBe('name,city\nJane,"Austin, Metro"');
    expect(parseCsv(csv).rows[0]).toEqual(['Jane', 'Austin, Metro']);
  });

  test('converts a JSON array using the union of its fields', () => {
    const csv = jsonToCsv([{ name: 'Jane' }, { name: 'Sam', active: true }]);

    expect(parseCsv(csv)).toEqual({
      headers: ['name', 'active'],
      rows: [['Jane', ''], ['Sam', 'true']],
    });
  });

  test('rejects JSON shapes the ingest flow cannot represent', () => {
    expect(() => jsonToCsv({ name: 'Jane' })).toThrow('array of objects');
    expect(() => jsonToCsv([])).toThrow('array of objects');
  });

  test('rejects arrays of arrays, nulls, and objects without fields', () => {
    expect(() => jsonToCsv([['a', 'b']])).toThrow('array of objects');
    expect(() => jsonToCsv([null])).toThrow('array of objects');
    expect(() => jsonToCsv([{}])).toThrow('at least one field');
  });

  test('keeps nested values and nulls representable', () => {
    const csv = jsonToCsv([{ name: 'Jane', tags: ['a', 'b'], meta: { vip: true }, note: null, zero: 0 }]);

    expect(parseCsv(csv).rows[0]).toEqual(['Jane', '["a","b"]', '{"vip":true}', '', '0']);
  });

  test('strips a byte-order mark and ignores blank lines', () => {
    const parsed = parseCsv('\uFEFFname,city\n\nJane,Austin\n\n');

    expect(parsed.headers).toEqual(['name', 'city']);
    expect(parsed.rows).toEqual([['Jane', 'Austin']]);
  });

  test('handles empty and missing input', () => {
    expect(parseCsv('')).toEqual({ headers: [], rows: [] });
    expect(parseCsv(null)).toEqual({ headers: [], rows: [] });
  });

  test('round-trips the bundled JSON sample', () => {
    const sample = JSON.parse(require('fs').readFileSync(`${__dirname}/../../public/samples/pipecheck-demo.json`, 'utf8'));
    const parsed = parseCsv(jsonToCsv(sample));

    expect(parsed.headers).toEqual(Object.keys(sample[0]));
    expect(parsed.rows).toHaveLength(sample.length);
    expect(parsed.rows[1][3]).toBe('Austin, Metro');
  });
});

test('uses the header dialect and keeps empty records aligned with source row numbers', () => {
  expect(parseCsv('id;"note, in units, USD"\n1;"a;b"\n;\n\n2;0')).toEqual({
    headers: ['id', 'note, in units, USD'], rows: [['1', 'a;b'], ['', ''], ['2', '0']],
  });
});
