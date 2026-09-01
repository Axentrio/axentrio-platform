/**
 * After a clean scan the session must leave the writable upload key.
 * The client's presigned PUT still targets that key, so we copy to a
 * sibling `.scanned.` key, point `file_key` at the copy, then delete
 * the original. Thumbnail generation must use the copy, not the original.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  getSessionMock,
  updateSessionStatusMock,
  deleteFileMock,
  copyObjectMock,
  scanFileMock,
  shouldGenerateThumbnailMock,
  generateThumbnailMock,
  logAuditMock,
} = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  updateSessionStatusMock: vi.fn(),
  deleteFileMock: vi.fn().mockResolvedValue(undefined),
  copyObjectMock: vi.fn().mockResolvedValue(undefined),
  scanFileMock: vi.fn(),
  shouldGenerateThumbnailMock: vi.fn().mockReturnValue(false),
  generateThumbnailMock: vi.fn().mockResolvedValue('https://thumb'),
  logAuditMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../file-handling/upload.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../file-handling/upload.service')>();
  return {
    ...actual,
    getUploadService: () => ({
      getSession: getSessionMock,
      updateSessionStatus: updateSessionStatusMock,
      deleteFile: deleteFileMock,
      copyObject: copyObjectMock,
      setThumbnailUrl: vi.fn(),
    }),
  };
});

vi.mock('../../file-handling/virus-scan.service', () => ({
  getVirusScanService: () => ({ scanFile: scanFileMock }),
}));

vi.mock('../../file-handling/thumbnail.service', () => ({
  getThumbnailService: () => ({
    shouldGenerateThumbnail: shouldGenerateThumbnailMock,
    generateThumbnail: generateThumbnailMock,
  }),
}));

vi.mock('../../utils/audit', () => ({
  logAudit: logAuditMock,
}));

import { performScan, scannedCopyKey } from '../../file-handling/virus-scan-trigger';
import { s3CopySource } from '../../file-handling/upload.service';

const SESSION_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const FILE_KEY = 'uploads/test/2026/05/20/hash.png';
const SCANNED_KEY = 'uploads/test/2026/05/20/hash.scanned.png';

const session = {
  sessionId: SESSION_ID,
  fileKey: FILE_KEY,
  tenantId: 'tenant-1',
  userId: 'user-1',
  mimeType: 'image/png',
  status: 'pending',
};

const clean = {
  clean: true as const,
  threats: [],
  scannedAt: new Date('2026-05-20T12:00:00Z'),
  scanDurationMs: 42,
  fileKey: FILE_KEY,
  scanMethod: 'buffer' as const,
};

beforeEach(() => {
  getSessionMock.mockReset();
  updateSessionStatusMock.mockReset();
  deleteFileMock.mockClear();
  copyObjectMock.mockClear();
  copyObjectMock.mockResolvedValue(undefined);
  scanFileMock.mockReset();
  shouldGenerateThumbnailMock.mockReset();
  shouldGenerateThumbnailMock.mockReturnValue(false);
  generateThumbnailMock.mockClear();
  logAuditMock.mockClear();
  getSessionMock.mockResolvedValue(session);
});

describe('scannedCopyKey', () => {
  it('inserts .scanned before the extension', () => {
    expect(scannedCopyKey('uploads/t/a.png')).toBe('uploads/t/a.scanned.png');
    expect(scannedCopyKey('uploads/t/hash.pdf')).toBe('uploads/t/hash.scanned.pdf');
  });

  it('appends .scanned when there is no extension', () => {
    expect(scannedCopyKey('uploads/t/hash')).toBe('uploads/t/hash.scanned');
  });

  it('does not copy a copy', () => {
    expect(scannedCopyKey('uploads/t/a.scanned.png')).toBe('uploads/t/a.scanned.png');
  });

  it('keeps extra dots in the name', () => {
    expect(scannedCopyKey('uploads/t/a.b.c.pdf')).toBe('uploads/t/a.b.c.scanned.pdf');
  });

  it('keeps spaces and percent in the last segment', () => {
    expect(scannedCopyKey('uploads/t/file name.png')).toBe('uploads/t/file name.scanned.png');
    expect(scannedCopyKey('uploads/t/hash.png%20x')).toBe('uploads/t/hash.scanned.png%20x');
  });
});

describe('s3CopySource', () => {
  it('encodes spaces and percent in key segments', () => {
    expect(s3CopySource('bucket', 'uploads/t/file name.png')).toBe(
      'bucket/uploads/t/file%20name.png',
    );
    expect(s3CopySource('bucket', 'uploads/t/a.png%20x')).toBe(
      'bucket/uploads/t/a.png%2520x',
    );
  });

  it('does not encode slashes that separate key segments', () => {
    expect(s3CopySource('handsoff-knowledge', 'uploads/ten/2026/09/01/ab.png')).toBe(
      'handsoff-knowledge/uploads/ten/2026/09/01/ab.png',
    );
  });
});

describe('performScan — copy off the writable upload key', () => {
  it('copies, points file_key at the copy, then deletes the original', async () => {
    scanFileMock.mockResolvedValue(clean);
    await performScan(SESSION_ID, FILE_KEY);
    expect(copyObjectMock).toHaveBeenCalledWith(FILE_KEY, SCANNED_KEY);
    expect(updateSessionStatusMock).toHaveBeenCalledWith(SESSION_ID, 'ready', clean, SCANNED_KEY);
    expect(deleteFileMock).toHaveBeenCalledWith(FILE_KEY);
    expect(deleteFileMock.mock.invocationCallOrder[0]).toBeGreaterThan(
      copyObjectMock.mock.invocationCallOrder[0],
    );
  });

  it('marks failed and keeps the original when the copy throws', async () => {
    scanFileMock.mockResolvedValue(clean);
    copyObjectMock.mockRejectedValue(new Error('R2 copy failed'));
    await expect(performScan(SESSION_ID, FILE_KEY)).rejects.toThrow('R2 copy failed');
    expect(updateSessionStatusMock).toHaveBeenCalledWith(SESSION_ID, 'failed');
    expect(updateSessionStatusMock).not.toHaveBeenCalledWith(
      SESSION_ID,
      'ready',
      expect.anything(),
      expect.anything(),
    );
    expect(deleteFileMock).not.toHaveBeenCalled();
  });

  it('does not copy or delete when the key is already a scanned copy', async () => {
    scanFileMock.mockResolvedValue(clean);
    await performScan(SESSION_ID, SCANNED_KEY);
    expect(copyObjectMock).not.toHaveBeenCalled();
    expect(deleteFileMock).not.toHaveBeenCalled();
    expect(updateSessionStatusMock).toHaveBeenCalledWith(SESSION_ID, 'ready', clean, undefined);
  });

  it('thumbnails the scanned key, not the original', async () => {
    scanFileMock.mockResolvedValue(clean);
    shouldGenerateThumbnailMock.mockReturnValue(true);
    await performScan(SESSION_ID, FILE_KEY);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(generateThumbnailMock).toHaveBeenCalledWith(SCANNED_KEY, 'image/png');
  });
});
