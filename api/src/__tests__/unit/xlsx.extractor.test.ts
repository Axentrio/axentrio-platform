import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { extractXlsx } from '../../knowledge/document-extractors/xlsx.extractor';

async function workbookBuffer(build: (wb: ExcelJS.Workbook) => void): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  build(wb);
  const ab = await wb.xlsx.writeBuffer();
  return Buffer.from(ab);
}

describe('extractXlsx', () => {
  it('emits sheet headers and pipe-joined cell text', async () => {
    const buf = await workbookBuffer((wb) => {
      const sheet = wb.addWorksheet('Numbers');
      sheet.addRow(['Name', 'Amount']);
      sheet.addRow(['Omzet', 117620]);
    });
    const text = await extractXlsx(buf);
    expect(text).toContain('## Sheet: Numbers');
    expect(text).toContain('Name|Amount');
    expect(text).toContain('Omzet|117620');
    expect(text).not.toContain('[truncated]');
  });

  it('returns empty string for a workbook with no sheets', async () => {
    const buf = await workbookBuffer(() => undefined);
    expect(await extractXlsx(buf)).toBe('');
  });

  it('caps sheets, rows, and columns and notes truncation', async () => {
    const buf = await workbookBuffer((wb) => {
      for (let s = 1; s <= 21; s++) {
        const sheet = wb.addWorksheet(`S${s}`);
        const values: string[] = [];
        for (let c = 1; c <= 31; c++) values.push(`c${c}`);
        sheet.addRow(values);
        if (s === 1) {
          for (let r = 2; r <= 501; r++) sheet.addRow([`r${r}`]);
        }
      }
    });
    const text = await extractXlsx(buf);
    expect(text).toContain('## Sheet: S20');
    expect(text).not.toContain('## Sheet: S21');
    expect(text).toMatch(/\[truncated\]/);
    const sheet1 = text.split('## Sheet: S2\n')[0];
    const dataRows = sheet1.split('\n').filter((line) => line.includes('|') || /^r\d+$/.test(line));
    expect(dataRows.length).toBeLessThanOrEqual(500);
    expect(dataRows[0]?.split('|').length).toBeLessThanOrEqual(30);
  });
});
