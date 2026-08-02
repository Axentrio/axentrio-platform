/**
 * Analytics export registry (P3 / ADR-0014, D7) — Enterprise-gated.
 *
 * Each dataset is one registry entry: { filename(range, format), headers, rows() }.
 * Adding a dataset is a registry edit, not a route change. Synchronous + in-memory —
 * data is small at SMB scale.
 *
 * A dataset produces `string[][]` ONCE and both serializers (`toCsv`, `toXlsx`) read
 * that same array, so neither format can select a different SET of rows or columns
 * than the other. They do still differ at the cell level, deliberately and in three known
 * places: the CSV prefixes a formula-injection candidate with `'` while the xlsx
 * relies on string-typed cells instead; the xlsx clamps a cell to Excel's 32767-char
 * ceiling; and exceljs drops XML-illegal control characters the CSV passes through.
 */
import ExcelJS from 'exceljs';
import { AppDataSource } from '../database/data-source';
import type { ExportDataset } from '../contracts/insights';

interface DateRange {
  from: Date;
  to: Date;
  /** Hard row cap pushed into SQL as LIMIT. Protects the container from an
   *  unbounded in-memory export on a large tenant. Omit for no cap. */
  limit?: number;
}

export type ExportFormat = 'csv' | 'xlsx';

export interface Exporter {
  filename: (range: DateRange, format?: ExportFormat) => string;
  headers: string[];
  rows: (tenantId: string, range: DateRange) => Promise<string[][]>;
}

const day = (d: Date) => d.toISOString().slice(0, 10);
const str = (v: unknown): string => (v == null ? '' : String(v));

/** The extension is the ONLY thing a format changes about a filename — derived here
 *  rather than at the call site so a `.csv` name can never end up on xlsx bytes. */
const rangedFilename =
  (base: string) =>
  (r: DateRange, format: ExportFormat = 'csv'): string =>
    `${base}_${day(r.from)}_${day(r.to)}.${format}`;

/**
 * Timestamp for a spreadsheet cell: `YYYY-MM-DD HH:MM:SS`, UTC.
 *
 * `String(someDate)` — what this used to emit — produces
 * "Tue Jun 30 2026 10:15:32 GMT+0000 (Coordinated Universal Time)", which Excel
 * imports as TEXT. The operator cannot sort or filter by it, which defeats most of
 * the reason to open leads in a spreadsheet at all.
 *
 * Space-separated rather than ISO's `T`/`Z` because Excel parses this form as a real
 * datetime in every locale we serve, while `2026-06-30T10:15:32Z` stays text. The
 * column is named `created_at_utc` so the dropped zone is stated rather than implied —
 * showing a Belgian operator an unlabelled 10:15 for a 12:15 event is exactly the kind
 * of quietly-wrong data this codebase avoids elsewhere.
 */
const ts = (v: unknown): string => {
  if (v == null) return '';
  const d = v instanceof Date ? v : new Date(String(v));
  if (Number.isNaN(d.getTime())) return str(v); // never lose a value to a parse failure
  return d.toISOString().replace('T', ' ').slice(0, 19);
};

const exporters: Record<ExportDataset, Exporter> = {
  'outcomes-timeseries': {
    filename: rangedFilename('outcomes-timeseries'),
    headers: ['date', 'conversations', 'bookings', 'leads'],
    rows: async (tenantId, { from, to }) => {
      const [conv, book, lead] = await Promise.all([
        AppDataSource.query(
          `SELECT DATE(created_at) AS d, COUNT(*)::int AS c FROM chat_sessions
           WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3
           GROUP BY DATE(created_at)`, [tenantId, from, to]),
        AppDataSource.query(
          `SELECT DATE(created_at) AS d, COUNT(*)::int AS c FROM chatbot_bookings
           WHERE tenant_id = $1 AND status NOT IN ('cancelled','failed')
             AND created_at >= $2 AND created_at < $3
           GROUP BY DATE(created_at)`, [tenantId, from, to]),
        AppDataSource.query(
          `SELECT DATE(created_at) AS d, COUNT(*)::int AS c FROM chatbot_leads
           WHERE tenant_id = $1 AND deleted_at IS NULL
             AND created_at >= $2 AND created_at < $3
           GROUP BY DATE(created_at)`, [tenantId, from, to]),
      ]);
      const byDate = new Map<string, { conversations: number; bookings: number; leads: number }>();
      const ensure = (d: string) => {
        let row = byDate.get(d);
        if (!row) { row = { conversations: 0, bookings: 0, leads: 0 }; byDate.set(d, row); }
        return row;
      };
      for (const r of conv) ensure(day(new Date(r.d))).conversations = r.c;
      for (const r of book) ensure(day(new Date(r.d))).bookings = r.c;
      for (const r of lead) ensure(day(new Date(r.d))).leads = r.c;
      return [...byDate.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([d, v]) => [d, str(v.conversations), str(v.bookings), str(v.leads)]);
    },
  },

  gaps: {
    filename: rangedFilename('gaps'),
    headers: ['topic', 'status', 'severity', 'occurrences', 'distinct_visitors', 'first_detected_at', 'last_seen_at', 'resolved_at'],
    rows: async (tenantId, { from, to }) => {
      const rows = await AppDataSource.query(
        `SELECT ct.topic, g.status, g.severity, g.occurrences, g.distinct_visitors AS dv,
                g.first_detected_at AS fda, g.last_seen_at AS lsa, g.resolved_at AS ra
         FROM chatbot_gaps g
         LEFT JOIN chatbot_canonical_topics ct ON ct.id = g.canonical_topic_id
         WHERE g.tenant_id = $1 AND g.last_seen_at >= $2 AND g.last_seen_at < $3
         ORDER BY g.last_seen_at DESC`, [tenantId, from, to]);
      return rows.map((r: Record<string, unknown>) => [
        str(r.topic), str(r.status), str(r.severity), str(r.occurrences), str(r.dv),
        ts(r.fda), ts(r.lsa), ts(r.ra),
      ]);
    },
  },

  leads: {
    filename: rangedFilename('leads'),
    headers: ['created_at_utc', 'name', 'email', 'phone', 'channel', 'source', 'status', 'notes'],
    rows: async (tenantId, { from, to, limit }) => {
      // LIMIT is pushed into SQL, not applied after the fact: this route is bulk
      // PII egress on a table with no per-tenant size bound, so the cap has to
      // stop Postgres from materializing the rows, not just trim the response.
      const rows = await AppDataSource.query(
        `SELECT created_at AS ca, name, email, phone, channel, source, status, notes
         FROM chatbot_leads
         WHERE tenant_id = $1 AND deleted_at IS NULL
           AND created_at >= $2 AND created_at < $3
         ORDER BY created_at DESC
         ${limit ? 'LIMIT $4' : ''}`,
        limit ? [tenantId, from, to, limit] : [tenantId, from, to]);
      return rows.map((r: Record<string, unknown>) => [
        ts(r.ca), str(r.name), str(r.email), str(r.phone), str(r.channel), str(r.source), str(r.status), str(r.notes),
      ]);
    },
  },
};

export function getExporter(dataset: string): Exporter | null {
  return (exporters as Record<string, Exporter>)[dataset] ?? null;
}

export const EXPORT_DATASETS = Object.keys(exporters) as ExportDataset[];

export interface CsvOptions {
  /** Field delimiter. Default `,` (RFC 4180). */
  delimiter?: string;
  /** Prepend a UTF-8 BOM. Without it Excel decodes the file as the system
   *  legacy codepage, so `é`/`ë`/`ç` in Dutch/French names arrive as mojibake. */
  bom?: boolean;
  /** Prepend Excel's `sep=<delimiter>` hint line. Excel honours this in EVERY
   *  locale, which is what makes one file open correctly for both a Belgian
   *  install (list separator `;`) and a US one (`,`). Non-Excel parsers see it
   *  as a stray first row, so only enable it for explicitly Excel-bound files. */
  sepLine?: boolean;
}

/** Excel-safe preset for consumer-facing exports: our SMBs are BE/NL/FR and
 *  open these in a semicolon-locale Excel. See CsvOptions for why all three. */
export const EXCEL_CSV: CsvOptions = { delimiter: ';', bom: true, sepLine: true };

/**
 * Interchange preset: comma-delimited RFC 4180, BOM kept so accented names survive,
 * and NO `sep=` hint line — a strict parser reads that hint as a stray first row.
 *
 * This exists because `EXCEL_CSV` was only ever a workaround for CSV being the sole
 * export format. Now that `toXlsx` serves Excel directly, a file labelled "CSV" can go
 * back to being one, which is what a CRM importer, pandas, or `fromCsv` actually wants.
 */
export const INTERCHANGE_CSV: CsvOptions = { bom: true };

/** RFC 4180 CSV: quote fields containing the delimiter/quote/newline; double quotes.
 *  Also neutralize spreadsheet formula injection — a field whose first char is
 *  =, +, -, @, tab, or CR is executed as a formula by Excel/Sheets, and lead
 *  fields (notes, name) carry visitor/model-authored free text. Prefix such a
 *  value with a single quote so it imports as inert text. */
export function toCsv(headers: string[], rows: string[][], opts: CsvOptions = {}): string {
  const delimiter = opts.delimiter ?? ',';
  // Quote on the ACTIVE delimiter, not a hardcoded comma — otherwise switching
  // to ';' would leave a field containing ';' unquoted and shift every later column.
  const needsQuote = new RegExp(`["\\r\\n${delimiter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}]`);
  const esc = (raw: string) => {
    const f = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
    return needsQuote.test(f) ? `"${f.replace(/"/g, '""')}"` : f;
  };
  const body = [headers, ...rows].map((row) => row.map(esc).join(delimiter)).join('\r\n');
  // BOM must be the very first bytes of the file, ahead of the sep= hint.
  return `${opts.bom ? '﻿' : ''}${opts.sepLine ? `sep=${delimiter}\r\n` : ''}${body}`;
}

/** OOXML spreadsheet media type. The long one is not decorative — Excel refuses to
 *  open a .xlsx served as application/octet-stream on some Windows/SharePoint paths. */
export const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * Excel refuses to open a workbook containing a cell longer than this and offers to
 * "repair" it — which silently drops the sheet, i.e. the whole export. `Lead.notes` is
 * an uncapped `text` column, so a single long visitor message is enough to trigger it.
 * Truncating one cell loses the tail of one note; not truncating loses the file.
 */
const XLSX_MAX_CELL_CHARS = 32767;
const XLSX_TRUNCATION_MARK = '…[truncated]';

function clampCell(value: string): string {
  if (value.length <= XLSX_MAX_CELL_CHARS) return value;
  // Marked, not silently cut: an operator reading a note must be able to tell that
  // what they are looking at is not all of it.
  return value.slice(0, XLSX_MAX_CELL_CHARS - XLSX_TRUNCATION_MARK.length) + XLSX_TRUNCATION_MARK;
}

/**
 * A real .xlsx of the SAME `headers`/`rows` `toCsv` receives — so the operator is no
 * longer relying on Excel's CSV import behaviour to read their own data.
 *
 * Every cell is written as a string, deliberately. `Exporter.rows` is `string[][]` and
 * stays that way: coercing digits to numbers would strip the leading zero off a Belgian
 * postcode and render `+32 475 …` as 32475 — a phone number the operator would then
 * fail to dial, having been given no sign anything was changed.
 *
 * That same typing IS the formula-injection guard. A JS string becomes an explicitly
 * typed string cell in the sheet XML, and Excel only evaluates a cell that was written
 * as a formula, so `=HYPERLINK(...)` in a visitor-authored note is inert on open. The
 * CSV guard's leading `'` must NOT be reused here: Excel strips that apostrophe while
 * IMPORTING a CSV, but an xlsx is never imported, so it would survive as a literal
 * character in the operator's data.
 */
export async function toXlsx(
  headers: string[],
  rows: string[][],
  sheetName = 'Export',
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);
  sheet.addRow(headers.map(clampCell));
  for (const row of rows) sheet.addRow(row.map(clampCell));
  // The point of shipping a spreadsheet rather than a CSV: the header stays visible
  // and readable while the operator scrolls a few thousand leads.
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  // Buffered, not streamed: the caller has to write its audit row and set
  // X-Export-Truncated BEFORE the first byte leaves, and the row cap already bounds
  // this to ~10k rows (a few hundred KB).
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export interface ParsedCsv {
  headers: string[];
  rows: string[][];
}

/**
 * Minimal RFC 4180 reader — the symmetric partner of `toCsv`, deliberately not a
 * dependency. It has to survive its own output first: our export emits a UTF-8 BOM, a
 * `sep=;` hint line, semicolons, and a `'` prefix on formula-injection candidates. An
 * importer that cannot read the file this platform produces would be indefensible, so
 * all four are handled explicitly.
 *
 * Delimiter detection order: the `sep=` line if present, otherwise whichever of `;` or
 * `,` appears more often in the header line. Sniffing the HEADER only — a data row can
 * legitimately contain either character inside quotes.
 */
export function fromCsv(input: string): ParsedCsv {
  let text = input.replace(/^﻿/, ''); // our own BOM

  let delimiter: string | null = null;
  const sep = /^sep=(.)\r?\n/i.exec(text);
  if (sep) {
    delimiter = sep[1];
    text = text.slice(sep[0].length);
  }
  if (!delimiter) {
    const headerLine = text.split(/\r?\n/, 1)[0] ?? '';
    const semis = (headerLine.match(/;/g) ?? []).length;
    const commas = (headerLine.match(/,/g) ?? []).length;
    delimiter = semis > commas ? ';' : ',';
  }

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  const endField = () => {
    row.push(unguard(field));
    field = '';
  };
  const endRow = () => {
    endField();
    // Skip blank trailing lines rather than emitting a phantom one-empty-field row.
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === '') {
      inQuotes = true;
    } else if (ch === delimiter) {
      endField();
    } else if (ch === '\r') {
      // swallow; the \n handles the row break
    } else if (ch === '\n') {
      endRow();
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) endRow();

  const headers = (rows.shift() ?? []).map((h) => h.trim().toLowerCase());
  return { headers, rows };
}

/**
 * Undo `toCsv`'s formula-injection guard, and ONLY that.
 *
 * The guard prefixes a `'` to fields starting with = + - @ tab or CR. Stripping every
 * leading apostrophe would corrupt legitimate values (a name like `'t Hooft`, common in
 * Dutch), so this strips one only when what follows is a character the guard actually
 * targets.
 */
function unguard(value: string): string {
  return /^'[=+\-@\t\r]/.test(value) ? value.slice(1) : value;
}
