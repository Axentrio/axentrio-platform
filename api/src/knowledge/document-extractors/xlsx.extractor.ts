import ExcelJS from 'exceljs';

const MAX_SHEETS = 20;
const MAX_ROWS_PER_SHEET = 500;
const MAX_COLS_PER_ROW = 30;

function cellText(cell: ExcelJS.Cell): string {
  const text = cell.text;
  return typeof text === 'string' ? text : text == null ? '' : String(text);
}

/**
 * Extract worksheet text from an XLSX buffer. Caps sheets, rows, and columns
 * and notes truncation with a `[truncated]` line.
 */
export async function extractXlsx(buffer: Buffer): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  // exceljs accepts Buffer; the type lists only streams/paths.
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  if (workbook.worksheets.length === 0) return '';

  const parts: string[] = [];
  let truncated = workbook.worksheets.length > MAX_SHEETS;
  const sheets = workbook.worksheets.slice(0, MAX_SHEETS);

  for (const sheet of sheets) {
    parts.push(`## Sheet: ${sheet.name}`);
    let rowCount = 0;
    sheet.eachRow({ includeEmpty: false }, (row) => {
      if (rowCount >= MAX_ROWS_PER_SHEET) {
        truncated = true;
        return;
      }
      rowCount += 1;
      const last = Math.min(row.cellCount, MAX_COLS_PER_ROW);
      if (row.cellCount > MAX_COLS_PER_ROW) truncated = true;
      const values: string[] = [];
      for (let i = 1; i <= last; i++) {
        values.push(cellText(row.getCell(i)));
      }
      parts.push(values.join('|'));
    });
    if (rowCount >= MAX_ROWS_PER_SHEET) truncated = true;
  }

  if (truncated) parts.push('[truncated]');
  return parts.join('\n');
}
