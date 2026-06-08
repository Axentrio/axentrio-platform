import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────────────────
// UploadSession repo (only `findOne` for the idempotency short-circuit and the
// `insert().orIgnore()` builder for persistSession). ServiceType repo `count`
// for the gate.
const uploadFindOne = vi.fn();
const insertExecute = vi.fn();
const serviceTypeCount = vi.fn();

function makeInsertBuilder() {
  const builder: any = {
    insert: () => builder,
    values: () => builder,
    orIgnore: () => builder,
    execute: (...a: any[]) => insertExecute(...a),
  };
  return builder;
}

vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: vi.fn((entity: any) => {
      const name = entity?.name || entity;
      if (name === 'UploadSession') {
        return {
          findOne: uploadFindOne,
          createQueryBuilder: () => makeInsertBuilder(),
        };
      }
      if (name === 'ServiceType') return { count: serviceTypeCount };
      return {};
    }),
  },
  getRepository: (entity: any) => {
    const name = entity?.name || entity;
    if (name === 'ServiceType') return { count: serviceTypeCount };
    if (name === 'UploadSession') return { findOne: uploadFindOne, createQueryBuilder: () => makeInsertBuilder() };
    return {};
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// S3 client `send`.
const s3Send = vi.fn();
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send = (...a: any[]) => s3Send(...a);
  },
  PutObjectCommand: class {
    input: any;
    constructor(input: any) {
      this.input = input;
    }
  },
  GetObjectCommand: class {
    constructor(public input: any) {}
  },
  DeleteObjectCommand: class {
    constructor(public input: any) {}
  },
  HeadObjectCommand: class {
    constructor(public input: any) {}
  },
  ListObjectsV2Command: class {
    constructor(public input: any) {}
  },
}));

// Presigned URL helper — deterministic.
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(async (_c: any, cmd: any) => `https://signed/${cmd.input.Key}`),
}));

// SSRF-guarded download.
const safeOutboundRequest = vi.fn();
vi.mock('../../security/ssrf-guard', () => ({
  safeOutboundRequest: (...a: any[]) => safeOutboundRequest(...a),
  SsrfError: class extends Error {},
}));

// sharp sniff.
const sharpMetadata = vi.fn();
vi.mock('sharp', () => ({
  default: () => ({ metadata: () => sharpMetadata() }),
}));

// Billing feature gate.
const requireFeature = vi.fn();
vi.mock('../../billing/enforce', () => ({
  requireFeature: (...a: any[]) => requireFeature(...a),
  enforceCountLimit: vi.fn(),
}));

// performScan.
const performScan = vi.fn();
vi.mock('../../file-handling/virus-scan-trigger', () => ({
  performScan: (...a: any[]) => performScan(...a),
}));

import { UploadService, resetUploadService } from '../../file-handling/upload.service';
import { maybeIngestInboundMedia, botHasActiveFileService } from '../../channels/inbound-pipeline';
import { getUploadService } from '../../file-handling/upload.service';

// Standalone ArrayBuffer (not a slice of Node's shared Buffer pool) so
// `Buffer.from(data)` inside the service has exactly this length.
const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_AB = new Uint8Array(PNG_BYTES).buffer;
const PNG_LEN = PNG_BYTES.length;

function baseInput(over: Partial<Record<string, unknown>> = {}) {
  return {
    url: 'https://cdn.example.com/img.jpg',
    tenantId: 'ten-1',
    chatSessionId: 'chat-1',
    botId: '11111111-1111-1111-1111-111111111111',
    externalUserId: 'fb-user-9',
    eventDedupeKey: 'mid.abc123',
    eventTimestamp: new Date('2026-06-08T10:00:00.000Z'),
    ...over,
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetUploadService();
  // Default: S3 configured.
  process.env.AWS_S3_BUCKET = 'test-bucket';
  process.env.AWS_ACCESS_KEY_ID = 'key';
  process.env.AWS_SECRET_ACCESS_KEY = 'secret';
  // Default: no existing row.
  uploadFindOne.mockResolvedValue(null);
  insertExecute.mockResolvedValue({});
  s3Send.mockResolvedValue({});
  safeOutboundRequest.mockResolvedValue({ status: 200, data: PNG_AB });
  sharpMetadata.mockResolvedValue({ format: 'png' });
});

// ── ingestRemoteFile ─────────────────────────────────────────────────────────
//
// `getUploadSessionRepo()` uses CJS `require('../database/data-source')` which
// vitest's `vi.mock` does not intercept inside the source module — so DB access
// (getSession/persistSession) is stubbed at the instance level. putObjectBuffer
// → s3Send and the orchestration stay real.

function makeService(config?: Record<string, unknown>) {
  // Pass bucketName via config so `isConfigured()` doesn't depend on the
  // import-time AWS_S3_BUCKET (absent in CI). The "unconfigured" test overrides
  // it back to '' via its own config arg.
  const svc = new UploadService({ bucketName: 'test-bucket', ...config } as any);
  vi.spyOn(svc, 'getSession').mockResolvedValue(undefined);
  vi.spyOn(svc as any, 'persistSession').mockResolvedValue(undefined);
  vi.spyOn(svc, 'generatePublicUrl').mockResolvedValue('https://public/url');
  vi.spyOn(svc, 'deleteFile').mockResolvedValue(undefined);
  return svc;
}

describe('UploadService.ingestRemoteFile', () => {
  it('happy path: PUTs with SSE + exact metadata, persists pending, updates quota, returns needsScan:true', async () => {
    const svc = makeService();
    const persistSpy = svc['persistSession'] as unknown as ReturnType<typeof vi.fn>;
    const quotaSpy = vi.spyOn(svc as any, 'updateTenantQuota');

    const result = await svc.ingestRemoteFile(baseInput());

    expect(result).not.toBeNull();
    expect(result!.needsScan).toBe(true);
    expect(result!.fileKey).toMatch(/^uploads\/ten-1\/2026\/06\/08\/[0-9a-f-]+\.png$/);

    // PutObject with SSE + metadata.
    const putCall = s3Send.mock.calls.find((c) => c[0]?.input?.Body);
    expect(putCall).toBeTruthy();
    const put = putCall![0].input;
    expect(put.ServerSideEncryption).toBe('AES256');
    expect(put.ContentType).toBe('image/png');
    expect(put.Metadata['tenant-id']).toBe('ten-1');
    expect(put.Metadata['user-id']).toBe('meta:fb-user-9');
    expect(put.Metadata['session-id']).toBe('chat-1');
    expect(put.Metadata['content-type']).toBe('image/png');

    // persistSession called with userId = botId, status pending; quota once.
    expect(persistSpy).toHaveBeenCalledTimes(1);
    const [session, chatSessionId] = persistSpy.mock.calls[0];
    expect((session as any).userId).toBe('11111111-1111-1111-1111-111111111111');
    expect((session as any).status).toBe('pending');
    expect((session as any).uploadUrl).toBe('');
    expect(chatSessionId).toBe('chat-1');
    expect(quotaSpy).toHaveBeenCalledTimes(1);
    expect(quotaSpy).toHaveBeenCalledWith('ten-1', PNG_LEN);
  });

  it('follows a Meta CDN 302 redirect (re-validated per hop) then downloads', async () => {
    safeOutboundRequest.mockReset();
    safeOutboundRequest
      .mockResolvedValueOnce({ status: 302, headers: { location: 'https://scontent.example/real.png' }, data: new ArrayBuffer(0) })
      .mockResolvedValueOnce({ status: 200, data: PNG_AB });
    const svc = makeService();
    const result = await svc.ingestRemoteFile(baseInput());
    expect(result).not.toBeNull();
    expect(result!.needsScan).toBe(true);
    expect(safeOutboundRequest).toHaveBeenCalledTimes(2);
    expect(safeOutboundRequest.mock.calls[1][0].url).toBe('https://scontent.example/real.png');
  });

  it('returns null if redirects never resolve to a 2xx (loop bound)', async () => {
    safeOutboundRequest.mockReset();
    safeOutboundRequest.mockResolvedValue({ status: 302, headers: { location: 'https://scontent.example/a.png' }, data: new ArrayBuffer(0) });
    const svc = makeService();
    expect(await svc.ingestRemoteFile(baseInput())).toBeNull();
  });

  it('non-image (sharp throws) → null, no PUT', async () => {
    sharpMetadata.mockRejectedValue(new Error('unsupported'));
    const svc = makeService();
    expect(await svc.ingestRemoteFile(baseInput())).toBeNull();
    expect(s3Send.mock.calls.find((c) => c[0]?.input?.Body)).toBeUndefined();
  });

  it('disallowed format (e.g. tiff) → null', async () => {
    sharpMetadata.mockResolvedValue({ format: 'tiff' });
    const svc = makeService();
    expect(await svc.ingestRemoteFile(baseInput())).toBeNull();
  });

  it('over-cap (axios throws on maxContentLength) → null', async () => {
    safeOutboundRequest.mockRejectedValue(new Error('maxContentLength size exceeded'));
    const svc = makeService();
    expect(await svc.ingestRemoteFile(baseInput())).toBeNull();
  });

  it('SSRF error → null', async () => {
    safeOutboundRequest.mockRejectedValue(new Error('Blocked SSRF target'));
    const svc = makeService();
    expect(await svc.ingestRemoteFile(baseInput())).toBeNull();
  });

  it('non-2xx download → null', async () => {
    safeOutboundRequest.mockResolvedValue({ status: 404, data: PNG_AB });
    const svc = makeService();
    expect(await svc.ingestRemoteFile(baseInput())).toBeNull();
  });

  it('S3 unconfigured → null (no download)', async () => {
    // bucketName is part of config (DEFAULT_UPLOAD_CONFIG reads env at import);
    // override it to empty to simulate an unconfigured service.
    const svc = makeService({ bucketName: '' });
    expect(await svc.ingestRemoteFile(baseInput())).toBeNull();
    expect(safeOutboundRequest).not.toHaveBeenCalled();
  });

  it('over-quota → null, no persist', async () => {
    const svc = makeService();
    const persistSpy = svc['persistSession'] as unknown as ReturnType<typeof vi.fn>;
    vi.spyOn(svc as any, 'validateQuota').mockRejectedValue(new Error('Storage quota exceeded'));
    expect(await svc.ingestRemoteFile(baseInput())).toBeNull();
    expect(persistSpy).not.toHaveBeenCalled();
  });

  it('persist throws → deleteFile called + null', async () => {
    const svc = makeService();
    (svc['persistSession'] as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db down'));
    const deleteSpy = svc.deleteFile as unknown as ReturnType<typeof vi.fn>;
    expect(await svc.ingestRemoteFile(baseInput())).toBeNull();
    expect(deleteSpy).toHaveBeenCalledTimes(1);
  });

  it('existing terminal row (ready) → needsScan:false, no put/quota/download', async () => {
    const svc = makeService();
    (svc.getSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      fileKey: 'uploads/ten-1/x.png', status: 'ready',
    });
    const quotaSpy = vi.spyOn(svc as any, 'updateTenantQuota');
    const result = await svc.ingestRemoteFile(baseInput());
    expect(result).toEqual({ sessionId: expect.any(String), fileKey: 'uploads/ten-1/x.png', needsScan: false });
    expect(s3Send).not.toHaveBeenCalled();
    expect(quotaSpy).not.toHaveBeenCalled();
    expect(safeOutboundRequest).not.toHaveBeenCalled();
  });

  it('existing pending row → needsScan:true, no put/quota', async () => {
    const svc = makeService();
    (svc.getSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      fileKey: 'uploads/ten-1/y.png', status: 'pending',
    });
    const quotaSpy = vi.spyOn(svc as any, 'updateTenantQuota');
    const result = await svc.ingestRemoteFile(baseInput());
    expect(result!.needsScan).toBe(true);
    expect(result!.fileKey).toBe('uploads/ten-1/y.png');
    expect(s3Send).not.toHaveBeenCalled();
    expect(quotaSpy).not.toHaveBeenCalled();
  });

  it('same eventDedupeKey twice → same sessionId (deterministic)', async () => {
    const svc = makeService();
    const r1 = await svc.ingestRemoteFile(baseInput());
    const r2 = await svc.ingestRemoteFile(baseInput());
    expect(r1!.sessionId).toBe(r2!.sessionId);
  });

  it('falls back to messenger-<id> originalName when no Meta filename', async () => {
    const svc = makeService();
    const r = await svc.ingestRemoteFile(baseInput({ fileName: undefined }));
    const put = s3Send.mock.calls.find((c) => c[0]?.input?.Body)![0].input;
    expect(put.Metadata['original-name']).toMatch(/^messenger-[0-9a-f]{8}\.png$/);
    expect(r).not.toBeNull();
  });
});

// ── gate: maybeIngestInboundMedia ─────────────────────────────────────────────

function makeEvent(over: any = {}): any {
  return {
    type: 'message',
    message: { type: 'image', content: '', mediaUrl: 'https://cdn/x.jpg', ...over.message },
    sender: { externalUserId: 'fb-9', externalThreadId: 't-1' },
    dedupeKey: 'mid.gate1',
    timestamp: new Date('2026-06-08T10:00:00.000Z'),
    rawEventType: 'message',
    ...over,
  };
}
const conn = (channel: string): any => ({ tenantId: 'ten-1', channel });
const sess = (): any => ({ id: 'chat-1', botId: 'bot-1' });

describe('maybeIngestInboundMedia gate', () => {
  let ingestSpy: any;
  beforeEach(() => {
    requireFeature.mockResolvedValue(undefined);
    serviceTypeCount.mockResolvedValue(1);
    performScan.mockResolvedValue({ clean: true });
    ingestSpy = vi
      .spyOn(getUploadService(), 'ingestRemoteFile')
      .mockResolvedValue({ sessionId: 'sid', fileKey: 'fk', needsScan: true });
  });

  it('invokes ingest + performScan for a valid image on an entitled bot with file service', async () => {
    await maybeIngestInboundMedia(makeEvent(), conn('messenger'), sess());
    expect(ingestSpy).toHaveBeenCalledTimes(1);
    expect(performScan).toHaveBeenCalledWith('sid', 'fk');
  });

  it('skips when needsScan is false (no scan)', async () => {
    ingestSpy.mockResolvedValue({ sessionId: 'sid', fileKey: 'fk', needsScan: false });
    await maybeIngestInboundMedia(makeEvent(), conn('messenger'), sess());
    expect(performScan).not.toHaveBeenCalled();
  });

  it('skips non-image', async () => {
    await maybeIngestInboundMedia(makeEvent({ message: { type: 'text', content: 'hi', mediaUrl: undefined } }), conn('messenger'), sess());
    expect(ingestSpy).not.toHaveBeenCalled();
  });

  it('skips sticker (image with stickerId)', async () => {
    await maybeIngestInboundMedia(
      makeEvent({ message: { type: 'image', mediaUrl: 'https://cdn/s.png', mediaMetadata: { stickerId: '123' } } }),
      conn('messenger'),
      sess(),
    );
    expect(ingestSpy).not.toHaveBeenCalled();
  });

  it('skips whatsapp', async () => {
    await maybeIngestInboundMedia(makeEvent(), conn('whatsapp'), sess());
    expect(ingestSpy).not.toHaveBeenCalled();
  });

  it('skips when not entitled (requireFeature throws)', async () => {
    requireFeature.mockRejectedValue(new Error('plan_limit_file_upload'));
    await maybeIngestInboundMedia(makeEvent(), conn('messenger'), sess());
    expect(ingestSpy).not.toHaveBeenCalled();
  });

  it('skips when bot has no active file service', async () => {
    serviceTypeCount.mockResolvedValue(0);
    await maybeIngestInboundMedia(makeEvent(), conn('messenger'), sess());
    expect(ingestSpy).not.toHaveBeenCalled();
  });

  it('a thrown ingest rejects (caller is responsible for catch)', async () => {
    ingestSpy.mockRejectedValue(new Error('boom'));
    await expect(maybeIngestInboundMedia(makeEvent(), conn('messenger'), sess())).rejects.toThrow('boom');
  });
});

describe('botHasActiveFileService', () => {
  it('true when count > 0', async () => {
    serviceTypeCount.mockResolvedValue(2);
    expect(await botHasActiveFileService('ten-1', 'bot-1')).toBe(true);
    expect(serviceTypeCount).toHaveBeenCalledWith({
      where: { tenantId: 'ten-1', botId: 'bot-1', isActive: true, fileUploadAllowed: true },
    });
  });
  it('false when count is 0', async () => {
    serviceTypeCount.mockResolvedValue(0);
    expect(await botHasActiveFileService('ten-1', 'bot-1')).toBe(false);
  });
});
