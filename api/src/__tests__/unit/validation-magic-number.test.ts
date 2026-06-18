import { describe, it, expect } from 'vitest';
import { getValidationService } from '../../file-handling/validation.service';

// The KB upload (#20) gates on validateFileBuffer's magic-number-derived
// detectedMimeType, so a file's CLAIMED type can't smuggle other bytes past it.
describe('validateFileBuffer — magic-number detection (KB upload #20)', () => {
  const v = getValidationService();

  it('detects a real PDF (magic %PDF-) regardless of the claimed type', async () => {
    const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64)]);
    const res = await v.validateFileBuffer(pdf, 'doc.pdf', 'application/pdf');
    expect(res.valid).toBe(true);
    expect(res.detectedMimeType).toBe('application/pdf');
  });

  it('does NOT detect a plain-text file forged as a PDF as application/pdf', async () => {
    const fake = Buffer.from('this is definitely not a pdf, just text pretending to be one');
    const res = await v.validateFileBuffer(fake, 'evil.pdf', 'application/pdf');
    // The controller gate (detectedMimeType must be pdf/docx) therefore rejects it.
    expect(res.detectedMimeType).not.toBe('application/pdf');
  });
});
