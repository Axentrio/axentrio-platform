/**
 * Unit test for the concurrent-dedup behavior in `virus-scan-trigger`.
 *
 * Codex round PR1 #2 surfaced the risk: two concurrent /upload-complete
 * calls for the same sessionId would both pass the idempotency check (both
 * see status: 'pending'), both run a full scan, both emit duplicate audit
 * rows, and both attempt to delete-on-quarantine. The fix uses a
 * per-sessionId `inFlightScans` Map so a second caller arriving while a
 * scan is in progress receives the same in-flight Promise.
 *
 * Testing this through supertest is fragile because the HTTP layer
 * serializes request dispatch. The dedup is module-level behavior, so we
 * exercise it directly here at the unit level.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  getSessionMock,
  updateSessionStatusMock,
  deleteFileMock,
  scanFileMock,
  shouldGenerateThumbnailMock,
  logAuditMock,
} = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  updateSessionStatusMock: vi.fn(),
  deleteFileMock: vi.fn().mockResolvedValue(undefined),
  scanFileMock: vi.fn(),
  shouldGenerateThumbnailMock: vi.fn().mockReturnValue(false),
  logAuditMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../file-handling/upload.service', () => ({
  getUploadService: () => ({
    getSession: getSessionMock,
    updateSessionStatus: updateSessionStatusMock,
    deleteFile: deleteFileMock,
  }),
}));

vi.mock('../../file-handling/virus-scan.service', () => ({
  getVirusScanService: () => ({ scanFile: scanFileMock }),
}));

vi.mock('../../file-handling/thumbnail.service', () => ({
  getThumbnailService: () => ({
    shouldGenerateThumbnail: shouldGenerateThumbnailMock,
    generateThumbnail: vi.fn(),
  }),
}));

vi.mock('../../utils/audit', () => ({
  logAudit: logAuditMock,
}));

import { performScan } from '../../file-handling/virus-scan-trigger';

const SESSION_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const FILE_KEY = 'uploads/test/2026/05/20/hash.pdf';

beforeEach(() => {
  getSessionMock.mockReset();
  updateSessionStatusMock.mockReset();
  deleteFileMock.mockClear();
  scanFileMock.mockReset();
  logAuditMock.mockClear();
});

describe('performScan — concurrent dedup (codex round PR1 #2)', () => {
  it('two concurrent calls share the same scan + emit a single audit', async () => {
    getSessionMock.mockReturnValue({
      sessionId: SESSION_ID,
      fileKey: FILE_KEY,
      tenantId: 'tenant-1',
      userId: 'user-1',
      mimeType: 'application/pdf',
      status: 'pending',
    });

    // Manually-controlled scan promise so we can verify both callers land
    // before it resolves.
    let resolveScan!: (result: {
      clean: boolean;
      threats: string[];
      scannedAt: Date;
      scanDurationMs: number;
      fileKey: string;
      scanMethod: 'buffer';
    }) => void;
    const scanPromise = new Promise<ReturnType<typeof Object>>((resolve) => {
      resolveScan = resolve as never;
    });
    scanFileMock.mockReturnValue(scanPromise);

    // Fire two concurrent calls; both reach `performScan` synchronously
    // in the same microtask tick.
    const result1Promise = performScan(SESSION_ID, FILE_KEY);
    const result2Promise = performScan(SESSION_ID, FILE_KEY);

    // Both calls should be in-flight against the SAME inFlightScans entry.
    // scanFile must have been called exactly once at this point.
    expect(scanFileMock).toHaveBeenCalledTimes(1);

    resolveScan({
      clean: true,
      threats: [],
      scannedAt: new Date('2026-05-20T12:00:00Z'),
      scanDurationMs: 42,
      fileKey: FILE_KEY,
      scanMethod: 'buffer',
    });

    const [result1, result2] = await Promise.all([result1Promise, result2Promise]);

    expect(result1).toBe(result2); // literally the same ScanResult object
    expect(result1.clean).toBe(true);

    // No second scan was kicked off.
    expect(scanFileMock).toHaveBeenCalledTimes(1);
    // Single audit row — no duplicate FILE_SCAN_COMPLETED.
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    expect(logAuditMock.mock.calls[0][1]).toBe('FILE_SCAN_COMPLETED');
  });

  it('after a scan completes, a fresh call performs a new scan (map cleared)', async () => {
    getSessionMock.mockReturnValue({
      sessionId: SESSION_ID,
      fileKey: FILE_KEY,
      tenantId: 'tenant-1',
      userId: 'user-1',
      mimeType: 'application/pdf',
      status: 'pending',
    });
    scanFileMock.mockResolvedValue({
      clean: true,
      threats: [],
      scannedAt: new Date(),
      scanDurationMs: 1,
      fileKey: FILE_KEY,
      scanMethod: 'buffer',
    });

    await performScan(SESSION_ID, FILE_KEY);
    await performScan(SESSION_ID, FILE_KEY);

    // After the first scan resolved, the in-flight entry was cleared.
    // The second call SHOULD run a fresh scan (caller is expected to do
    // its own idempotency check at the route layer — performScan only
    // dedups concurrent in-flight calls, not completed-then-repeated calls).
    expect(scanFileMock).toHaveBeenCalledTimes(2);
  });

  it('infected scan also dedups + only deletes the file once', async () => {
    getSessionMock.mockReturnValue({
      sessionId: SESSION_ID,
      fileKey: FILE_KEY,
      tenantId: 'tenant-1',
      userId: 'user-1',
      mimeType: 'application/pdf',
      status: 'pending',
    });

    let resolveScan!: (result: never) => void;
    const scanPromise = new Promise((resolve) => {
      resolveScan = resolve as never;
    });
    scanFileMock.mockReturnValue(scanPromise);

    const p1 = performScan(SESSION_ID, FILE_KEY);
    const p2 = performScan(SESSION_ID, FILE_KEY);

    resolveScan({
      clean: false,
      threats: ['EICAR-Test-Signature'],
      scannedAt: new Date(),
      scanDurationMs: 99,
      fileKey: FILE_KEY,
      scanMethod: 'buffer',
    } as never);

    await Promise.all([p1, p2]);

    expect(scanFileMock).toHaveBeenCalledTimes(1);
    // Single quarantine audit + single delete (critical: the infected
    // file must not be deleted twice — second delete would 404 on S3).
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    expect(logAuditMock.mock.calls[0][1]).toBe('FILE_QUARANTINED');
    expect(deleteFileMock).toHaveBeenCalledTimes(1);
  });
});
