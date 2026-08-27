import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  query,
  messageFindOne,
  sessionFindOne,
  addFileJob,
  scheduleTurn,
  sendInformationalBotMessage,
  requireFeature,
  localizeMessage,
  getSession,
  ingestRemoteDocumentBuffer,
  detectMimeTypeFromBuffer,
  extractPdfDetailed,
  performScan,
  s3Send,
  downloadInboundMediaBytes,
  encrypt,
  decrypt,
} = vi.hoisted(() => ({
  query: vi.fn(),
  messageFindOne: vi.fn(),
  sessionFindOne: vi.fn(),
  addFileJob: vi.fn(),
  scheduleTurn: vi.fn(),
  sendInformationalBotMessage: vi.fn(),
  requireFeature: vi.fn(),
  localizeMessage: vi.fn(),
  getSession: vi.fn(),
  ingestRemoteDocumentBuffer: vi.fn(),
  detectMimeTypeFromBuffer: vi.fn(),
  extractPdfDetailed: vi.fn(),
  performScan: vi.fn(),
  s3Send: vi.fn(),
  downloadInboundMediaBytes: vi.fn(),
  encrypt: vi.fn((v: string) => `enc(${v})`),
  decrypt: vi.fn((v: string) => v.replace(/^enc\(/, '').replace(/\)$/, '')),
}));

vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    query: (...a: unknown[]) => query(...a),
    getRepository: (entity: { name: string }) => {
      if (entity.name === 'Message') return { findOne: messageFindOne };
      return { findOne: sessionFindOne };
    },
  },
}));
vi.mock('../../queue/message-queue', () => ({ addFileJob: (...a: unknown[]) => addFileJob(...a) }));
vi.mock('../../billing/enforce', () => ({ requireFeature: (...a: unknown[]) => requireFeature(...a) }));
vi.mock('../../llm/localize', () => ({ localizeMessage: (...a: unknown[]) => localizeMessage(...a) }));
vi.mock('../../utils/encryption', () => ({
  encrypt: (v: string) => encrypt(v),
  decrypt: (v: string) => decrypt(v),
}));
vi.mock('../../utils/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock('../../config/s3.config', () => ({ createS3Client: () => ({ send: (...a: unknown[]) => s3Send(...a) }) }));
vi.mock('../../config/environment', () => ({ config: { s3: { bucket: 'bucket' } } }));
vi.mock('../../file-handling/upload.service', () => ({
  getUploadService: () => ({
    getSession: (...a: unknown[]) => getSession(...a),
    ingestRemoteDocumentBuffer: (...a: unknown[]) => ingestRemoteDocumentBuffer(...a),
  }),
}));
vi.mock('../../file-handling/validation.service', () => ({
  getValidationService: () => ({
    detectMimeTypeFromBuffer: (...a: unknown[]) => detectMimeTypeFromBuffer(...a),
  }),
}));
vi.mock('../../file-handling/virus-scan-trigger', () => ({
  performScan: (...a: unknown[]) => performScan(...a),
}));
vi.mock('../../services/turn-coalescer', () => ({
  scheduleTurn: (...a: unknown[]) => scheduleTurn(...a),
}));
vi.mock('../../services/message-forwarding.service', () => ({
  sendInformationalBotMessage: (...a: unknown[]) => sendInformationalBotMessage(...a),
}));
vi.mock('../../knowledge/document-extractors/pdf.extractor', () => ({
  extractPdfDetailed: (...a: unknown[]) => extractPdfDetailed(...a),
}));
vi.mock('../../knowledge/document-extractors/docx.extractor', () => ({ extractDocx: vi.fn() }));
vi.mock('../../knowledge/document-extractors/xlsx.extractor', () => ({ extractXlsx: vi.fn() }));
vi.mock('../../knowledge/document-extractors/pptx.extractor', () => ({ extractPptx: vi.fn() }));
vi.mock('../../knowledge/document-extractors/pdf-ocr', () => ({
  ocrPdfWithVision: vi.fn(),
  ocrImageWithVision: vi.fn(),
}));
vi.mock('../../services/inbound-images', () => ({
  downloadInboundMediaBytes: (...a: unknown[]) => downloadInboundMediaBytes(...a),
  resolveWhatsAppMediaUrl: vi.fn(),
}));

import {
  createChatDocumentProcessor,
  renderDocumentForContext,
  supportedExtractionMime,
} from '../../services/chat-documents';
import { Message } from '../../database/entities/Message';

function fileMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    sessionId: 'sess-1',
    tenantId: 'ten-1',
    type: 'file',
    content: '',
    contentEncrypted: false,
    metadata: {
      fileName: 'sheet.pdf',
      fileType: 'application/pdf',
      uploadSessionId: 'up-1',
      extraction: { status: 'pending', startedAt: new Date().toISOString() },
    },
    ...overrides,
  } as Message;
}

describe('supportedExtractionMime', () => {
  it('maps pdf, office, text, and images and rejects the rest', () => {
    expect(supportedExtractionMime('application/pdf')).toBe('pdf');
    expect(supportedExtractionMime('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe('xlsx');
    expect(supportedExtractionMime('text/plain')).toBe('text');
    expect(supportedExtractionMime('image/png')).toBe('image');
    expect(supportedExtractionMime('video/mp4')).toBeNull();
  });
});

describe('renderDocumentForContext', () => {
  it('fences ready text and uses the failed placeholder otherwise', () => {
    const ready = fileMessage({
      metadata: {
        fileName: 'sheet.pdf',
        extraction: { status: 'ready', text: 'enc(hello)', textEncrypted: true, pages: 2 },
      },
    });
    const fenced = renderDocumentForContext(ready, 'live');
    expect(fenced).toContain('sheet.pdf');
    expect(fenced).toContain('2 pages');
    expect(fenced).toContain('<<<ATTACHED_DOCUMENT');
    expect(fenced).toContain('hello');
    expect(fenced).toContain('ATTACHED_DOCUMENT>>>');

    const failed = fileMessage({
      metadata: { fileName: 'sheet.pdf', extraction: { status: 'failed' } },
    });
    expect(renderDocumentForContext(failed, 'live')).toContain('could not be read');

    const unsupported = fileMessage({
      metadata: { fileName: 'old.doc', extraction: { status: 'unsupported' } },
    });
    expect(renderDocumentForContext(unsupported, 'live')).toContain('is a format this system cannot read');

    const infected = fileMessage({
      metadata: { extraction: { status: 'infected' } },
    });
    expect(renderDocumentForContext(infected, 'live')).toContain('failed the security scan');
  });
});

describe('createChatDocumentProcessor', () => {
  const processor = createChatDocumentProcessor();
  const session = { id: 'sess-1', tenantId: 'ten-1', botId: 'bot-1' };

  beforeEach(() => {
    vi.clearAllMocks();
    getSession.mockResolvedValue({ status: 'ready', fileKey: 'k1', tenantId: 'ten-1', chatSessionId: 'sess-1' });
    messageFindOne.mockResolvedValue(fileMessage());
    sessionFindOne.mockResolvedValue(session);
    scheduleTurn.mockResolvedValue(undefined);
    s3Send.mockResolvedValue({
      Body: { transformToByteArray: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]) },
    });
    detectMimeTypeFromBuffer.mockReturnValue('application/pdf');
    extractPdfDetailed.mockResolvedValue({
      text: 'Jaarrekening 2025 Omzet 117620 extra digital text for the scanned-page rule',
      pages: 1,
    });
    encrypt.mockImplementation((v: string) => `enc(${v})`);
    downloadInboundMediaBytes.mockResolvedValue(Buffer.from('%PDF-1.4'));
  });

  it('marks ready, encrypts text, and schedules a turn on the happy path', async () => {
    await processor({
      data: {
        kind: 'chat-document',
        messageId: 'msg-1',
        sessionId: 'sess-1',
        source: 'widget',
        mimeKind: 'pdf',
      },
    } as never);
    expect(extractPdfDetailed).toHaveBeenCalled();
    const payload = String(query.mock.calls[0]?.[1]?.[1] ?? '');
    expect(payload).toContain('"status":"ready"');
    expect(payload).toContain('enc(');
    expect(payload).toContain('Omzet 117620');
    expect(scheduleTurn).toHaveBeenCalled();
  });

  it('marks failed and still schedules a turn when download fails', async () => {
    getSession.mockResolvedValue({ status: 'pending', fileKey: 'k1' });
    await processor({
      data: {
        kind: 'chat-document',
        messageId: 'msg-1',
        sessionId: 'sess-1',
        source: 'widget',
        mimeKind: 'pdf',
      },
    } as never);
    const writes = query.mock.calls.map((c) => String(c[1]?.[1] ?? ''));
    expect(writes.some((w) => w.includes('"status":"failed"'))).toBe(true);
    expect(scheduleTurn).toHaveBeenCalled();
  });

  it('fails when the upload session belongs to another tenant', async () => {
    getSession.mockResolvedValue({ status: 'ready', fileKey: 'k1', tenantId: 'other-tenant' });
    await processor({
      data: {
        kind: 'chat-document',
        messageId: 'msg-1',
        sessionId: 'sess-1',
        source: 'widget',
        mimeKind: 'pdf',
      },
    } as never);
    const writes = query.mock.calls.map((c) => String(c[1]?.[1] ?? ''));
    expect(writes.some((w) => w.includes('"status":"failed"'))).toBe(true);
    expect(extractPdfDetailed).not.toHaveBeenCalled();
  });

  it('fails when the upload session belongs to another chat', async () => {
    getSession.mockResolvedValue({ status: 'ready', fileKey: 'k1', tenantId: 'ten-1', chatSessionId: 'sess-other' });
    await processor({
      data: {
        kind: 'chat-document',
        messageId: 'msg-1',
        sessionId: 'sess-1',
        source: 'widget',
        mimeKind: 'pdf',
      },
    } as never);
    const writes = query.mock.calls.map((c) => String(c[1]?.[1] ?? ''));
    expect(writes.some((w) => w.includes('"status":"failed"'))).toBe(true);
    expect(extractPdfDetailed).not.toHaveBeenCalled();
  });


  it('marks infected and does not store text when the scan is dirty', async () => {
    messageFindOne.mockResolvedValue(fileMessage({
      metadata: {
        fileName: 'sheet.pdf',
        fileType: 'application/pdf',
        fileUrl: 'https://cdn.example/file.pdf',
        extraction: { status: 'pending', startedAt: new Date().toISOString() },
      },
    }));
    ingestRemoteDocumentBuffer.mockResolvedValue({ sessionId: 'up-scan', fileKey: 'k1' });
    performScan.mockResolvedValue({ clean: false });
    await processor({
      data: {
        kind: 'chat-document',
        messageId: 'msg-1',
        sessionId: 'sess-1',
        source: 'messenger',
        mimeKind: 'pdf',
      },
    } as never);
    const writes = query.mock.calls.map((c) => String(c[1]?.[1] ?? ''));
    expect(writes.some((w) => w.includes('"status":"infected"'))).toBe(true);
    expect(writes.some((w) => w.includes('"text"'))).toBe(false);
    expect(scheduleTurn).toHaveBeenCalled();
  });
});
