import { describe, it, expect, beforeEach, vi } from 'vitest';

const { q } = vi.hoisted(() => ({ q: { queue: [] as unknown[][] } }));

vi.mock('../../database/data-source', () => ({
  AppDataSource: { query: async () => q.queue.shift() ?? [] },
}));

import ExcelJS from 'exceljs';
import { toCsv, toXlsx, fromCsv, getExporter, EXPORT_DATASETS, EXCEL_CSV } from '../../analytics/exporters';

const RANGE = { from: new Date('2026-06-01T00:00:00Z'), to: new Date('2026-06-08T00:00:00Z') };

beforeEach(() => { q.queue = []; });

/**
 * Read a generated workbook back the way a spreadsheet app would, rather than trusting
 * the in-memory model we just built — the bytes are the product here.
 */
async function readXlsx(buffer: Buffer) {
  const workbook = new ExcelJS.Workbook();
  // exceljs declares load() over its own ArrayBuffer-shaped `Buffer`; it accepts a
  // Node Buffer at runtime, which is what toXlsx returns.
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const sheet = workbook.worksheets[0];
  const table: string[][] = [];
  sheet.eachRow({ includeEmpty: true }, (row) => {
    // `row.values` is 1-based with a leading hole; slice it back to a plain array.
    table.push((row.values as unknown[]).slice(1).map((v) => (v == null ? '' : String(v))));
  });
  return { sheet, sheetName: sheet.name, headers: table[0] ?? [], rows: table.slice(1) };
}

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

describe('analytics · Excel-safe CSV (BE/NL/FR locale)', () => {
  it('EXCEL_CSV emits BOM, then the sep= hint, then semicolon-delimited rows', () => {
    expect(toCsv(['a', 'b'], [['1', '2']], EXCEL_CSV)).toBe('﻿sep=;\r\na;b\r\n1;2');
  });

  it('BOM is the very first codepoint — ahead of the sep= line', () => {
    // If sep= preceded the BOM, Excel would render "ï»¿" in cell A1 and lose the
    // UTF-8 detection that keeps é/ë/ç intact in Dutch and French names.
    const out = toCsv(['x'], [['Jérôme Peeters']], EXCEL_CSV);
    expect(out.codePointAt(0)).toBe(0xfeff);
    expect(out).toContain('Jérôme Peeters');
  });

  it('quotes on the ACTIVE delimiter, so a semicolon in free text cannot shift columns', () => {
    // The original writer quoted on a hardcoded comma. Under ';' that would have
    // let a visitor-authored note split one field across two columns.
    expect(toCsv(['x', 'y'], [['leak; then flood', 'ok']], EXCEL_CSV)).toBe(
      '﻿sep=;\r\nx;y\r\n"leak; then flood";ok',
    );
    // A comma is now ordinary content and must NOT be quoted.
    expect(toCsv(['x'], [['Kerkstraat 12, Antwerp']], EXCEL_CSV)).toBe(
      '﻿sep=;\r\nx\r\nKerkstraat 12, Antwerp',
    );
  });

  it('still neutralizes formula injection under the Excel preset', () => {
    // The guard must survive the delimiter switch — these fields carry
    // visitor- and model-authored free text straight into a spreadsheet.
    expect(toCsv(['x'], [['=cmd|calc']], EXCEL_CSV)).toBe("﻿sep=;\r\nx\r\n'=cmd|calc");
  });

  it('default (no opts) is unchanged RFC 4180 — other exporters keep their format', () => {
    expect(toCsv(['a'], [['1']])).toBe('a\r\n1');
    expect(toCsv(['a'], [['1']]).codePointAt(0)).not.toBe(0xfeff);
  });
});

describe('analytics · real .xlsx export', () => {
  const HEADERS = ['created_at_utc', 'name', 'email', 'phone', 'notes'];
  const ROWS = [
    ['2026-06-03 10:00:00', 'Jérôme Peeters', 'j@x.io', '+32 475 46 44 21', 'Leak; then flood'],
    ['2026-06-04 09:30:00', 'Anaïs Vandenbërghe', '', '0475464421', 'Says "urgent", 2 days\nwaiting'],
  ];

  it('carries the SAME logical rows as the CSV of the same input', async () => {
    // The two formats share one `Exporter.rows` array, and this is the assertion that
    // keeps them honest: an operator must never get a different dataset by clicking a
    // different button. Compared against the CSV read back through our own reader, so
    // the delimiter/quoting/BOM framing is unwound the way Excel would unwind it.
    const csv = fromCsv(toCsv(HEADERS, ROWS, EXCEL_CSV));
    const xlsx = await readXlsx(await toXlsx(HEADERS, ROWS));

    expect(xlsx.headers.map((h) => h.toLowerCase())).toEqual(csv.headers);
    expect(xlsx.rows).toEqual(csv.rows);
    expect(xlsx.rows).toEqual(ROWS); // …and both still equal what the exporter produced
  });

  it('writes a leading = + - @ as an inert TEXT cell, with no apostrophe added', async () => {
    // The CSV guard prefixes `'` because Excel strips it while IMPORTING. An xlsx is
    // never imported, so the same prefix would survive into the operator's data — the
    // guard here is the cell TYPE instead.
    const hostile = [
      ['=HYPERLINK("http://evil","click")'],
      ['+1+2'],
      ['-2+3'],
      ['@SUM(A1)'],
    ];
    const { sheet, rows } = await readXlsx(await toXlsx(['x'], hostile));

    expect(rows).toEqual(hostile); // verbatim — no `'`, nothing evaluated
    for (let i = 0; i < hostile.length; i++) {
      const cell = sheet.getRow(i + 2).getCell(1);
      expect(cell.type).toBe(ExcelJS.ValueType.String);
      expect(cell.formula).toBeUndefined();
    }
  });

  it('round-trips é / ë / ï — the whole reason this format exists', async () => {
    // The CSV needs a BOM + Excel's own import guesswork to keep these; the xlsx
    // stores UTF-8 outright, so a mojibake here would mean we broke the encoding.
    const { rows } = await readXlsx(await toXlsx(['name'], [['Jérôme'], ['Vandenbërghe'], ['naïef']]));
    expect(rows).toEqual([['Jérôme'], ['Vandenbërghe'], ['naïef']]);
  });

  it('keeps every cell as text, so a phone number is not silently renumbered', async () => {
    // `+32 475 …` coerced to a number becomes 32475…, and `0475` loses its leading zero.
    // Excel shows no sign either happened — the operator just dials the wrong number.
    const { sheet, rows } = await readXlsx(await toXlsx(['phone'], [['0475464421'], ['+32 475 46 44 21']]));
    expect(rows).toEqual([['0475464421'], ['+32 475 46 44 21']]);
    expect(sheet.getRow(2).getCell(1).type).toBe(ExcelJS.ValueType.String);
  });

  it('puts the headers in row 1 of a named sheet, frozen so they survive scrolling', async () => {
    const { sheet, sheetName, headers } = await readXlsx(await toXlsx(HEADERS, ROWS, 'Leads'));
    expect(sheetName).toBe('Leads');
    expect(headers).toEqual(HEADERS);
    expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
  });

  it('emits a header-only workbook when the range holds no rows', async () => {
    // A zero-lead export must still open as a valid spreadsheet, not a corrupt file.
    const { headers, rows } = await readXlsx(await toXlsx(HEADERS, []));
    expect(headers).toEqual(HEADERS);
    expect(rows).toEqual([]);
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
      { ca: '2026-06-03T10:00:00Z', name: 'Ada', email: 'ada@x.io', phone: null,
        channel: 'whatsapp', source: 'tool', status: 'new', notes: 'Leak under the sink' },
    ]];
    const rows = await ex.rows('t1', RANGE);
    expect(ex.headers).toEqual(['created_at_utc', 'name', 'email', 'phone', 'channel', 'source', 'status', 'notes']);
    // The timestamp is NORMALIZED on the way out — ISO in, Excel-parseable datetime
    // out. It used to pass through verbatim, which Excel imported as unsortable text.
    expect(rows[0]).toEqual([
      '2026-06-03 10:00:00', 'Ada', 'ada@x.io', '', 'whatsapp', 'tool', 'new', 'Leak under the sink',
    ]);
    expect(ex.filename(RANGE)).toBe('leads_2026-06-01_2026-06-08.csv');
  });

  it('names the file for the requested format, defaulting to csv', () => {
    // The extension is derived, not spelled at the call site: `.csv` bytes named
    // `.xlsx` (or the reverse) is a file the operator cannot open at all.
    for (const dataset of EXPORT_DATASETS) {
      const ex = getExporter(dataset)!;
      expect(ex.filename(RANGE)).toBe(ex.filename(RANGE, 'csv'));
      expect(ex.filename(RANGE, 'csv').endsWith('.csv')).toBe(true);
      expect(ex.filename(RANGE, 'xlsx')).toBe(ex.filename(RANGE, 'csv').replace(/\.csv$/, '.xlsx'));
    }
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

describe('analytics · timestamps are spreadsheet-usable', () => {
  it('emits YYYY-MM-DD HH:MM:SS, not a verbose JS date string', async () => {
    // `String(new Date())` gives "Tue Jun 30 2026 10:15:32 GMT+0000 (Coordinated
    // Universal Time)", which Excel imports as TEXT — unsortable, unfilterable, which
    // defeats most of the reason to open leads in a spreadsheet. Found on production.
    q.queue = [[{ ca: new Date('2026-06-30T10:15:32.000Z'), name: 'Ann', email: 'a@b.c',
                  phone: null, channel: 'widget', source: 'tool', status: 'new', notes: null }]];
    const rows = await getExporter('leads')!.rows('t', RANGE);
    expect(rows[0][0]).toBe('2026-06-30 10:15:32');
    expect(rows[0][0]).not.toMatch(/GMT|Coordinated/);
  });

  it('names the column created_at_utc, so the dropped zone is stated not implied', () => {
    // Space-separated (not ISO T/Z) because Excel parses THIS form as a real datetime
    // in every locale we serve. That drops the offset, so the header has to say UTC —
    // showing a Belgian operator an unlabelled 10:15 for a 12:15 event is quietly wrong.
    expect(getExporter('leads')!.headers[0]).toBe('created_at_utc');
  });

  it('never loses a value when a timestamp cannot be parsed', async () => {
    q.queue = [[{ ca: 'not-a-date', name: 'Ann', email: null, phone: null,
                  channel: null, source: 'tool', status: 'new', notes: null }]];
    const rows = await getExporter('leads')!.rows('t', RANGE);
    expect(rows[0][0]).toBe('not-a-date'); // degrades to the raw value, never to ''
  });
});
