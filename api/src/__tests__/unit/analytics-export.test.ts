import { describe, it, expect, beforeEach, vi } from 'vitest';

const { q } = vi.hoisted(() => ({ q: { queue: [] as unknown[][] } }));

vi.mock('../../database/data-source', () => ({
  AppDataSource: { query: async () => q.queue.shift() ?? [] },
}));

import { toCsv, getExporter, EXPORT_DATASETS } from '../../analytics/exporters';

const RANGE = { from: new Date('2026-06-01T00:00:00Z'), to: new Date('2026-06-08T00:00:00Z') };

beforeEach(() => { q.queue = []; });

describe('analytics · CSV serialization (P3 D7)', () => {
  it('joins headers + rows with CRLF', () => {
    expect(toCsv(['a', 'b'], [['1', '2'], ['3', '4']])).toBe('a,b\r\n1,2\r\n3,4');
  });

  it('quotes and escapes per RFC 4180 (comma, quote, newline)', () => {
    expect(toCsv(['x'], [['a,b']])).toBe('x\r\n"a,b"');
    expect(toCsv(['x'], [['he said "hi"']])).toBe('x\r\n"he said ""hi"""');
    expect(toCsv(['x'], [['line1\nline2']])).toBe('x\r\n"line1\nline2"');
  });

  it('neutralizes spreadsheet formula injection (leading = + - @) with a leading quote', () => {
    expect(toCsv(['x'], [['=HYPERLINK("http://evil")']])).toBe('x\r\n"\'=HYPERLINK(""http://evil"")"');
    expect(toCsv(['x'], [['+1+2']])).toBe("x\r\n'+1+2");
    expect(toCsv(['x'], [['@SUM(A1)']])).toBe("x\r\n'@SUM(A1)");
    expect(toCsv(['x'], [['-2+3']])).toBe("x\r\n'-2+3");
    expect(toCsv(['x'], [['safe text']])).toBe('x\r\nsafe text'); // untouched
  });
});

describe('analytics · exporter registry (P3 D7)', () => {
  it('exposes exactly the three P3 datasets', () => {
    expect([...EXPORT_DATASETS].sort()).toEqual(['gaps', 'leads', 'outcomes-timeseries']);
  });

  it('returns null for an unknown dataset', () => {
    expect(getExporter('nope')).toBeNull();
  });

  it('leads exporter shapes rows in header order, nulls → empty string', async () => {
    const ex = getExporter('leads')!;
    q.queue = [[
      { ca: '2026-06-03T10:00:00Z', name: 'Ada', email: 'ada@x.io', phone: null, channel: 'whatsapp', source: 'tool', status: 'new', notes: 'Leak under the sink' },
    ]];
    const rows = await ex.rows('t1', RANGE);
    expect(ex.headers).toEqual(['created_at', 'name', 'email', 'phone', 'channel', 'source', 'status', 'notes']);
    expect(rows[0]).toEqual(['2026-06-03T10:00:00Z', 'Ada', 'ada@x.io', '', 'whatsapp', 'tool', 'new', 'Leak under the sink']);
    expect(ex.filename(RANGE)).toBe('leads_2026-06-01_2026-06-08.csv');
  });

  it('outcomes-timeseries merges the three sparse series by date, ascending', async () => {
    const ex = getExporter('outcomes-timeseries')!;
    q.queue = [
      [{ d: '2026-06-02', c: 5 }, { d: '2026-06-01', c: 3 }], // conversations
      [{ d: '2026-06-02', c: 2 }],                            // bookings
      [{ d: '2026-06-01', c: 1 }],                            // leads
    ];
    const rows = await ex.rows('t1', RANGE);
    expect(rows).toEqual([
      ['2026-06-01', '3', '0', '1'],
      ['2026-06-02', '5', '2', '0'],
    ]);
  });
});
