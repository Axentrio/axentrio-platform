/**
 * Operator reply attachments — POST /chats/:id/messages with uploadSessionId.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { createAuthMocks, configureMockAuth } from '../helpers/auth';

const { auth } = createAuthMocks();

vi.mock('@clerk/express', () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../../websocket/socket.handler', () => ({
  emitToSession: vi.fn(),
  emitToTenantAgents: vi.fn(),
  emitToAgent: vi.fn(),
}));

vi.mock('../../utils/audit', () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../channels/outbound-router', () => ({
  routeOutboundMessage: vi.fn().mockResolvedValue({ success: true }),
  routeTypingIndicator: vi.fn(),
  sendChannelTypingIndicator: vi.fn(),
}));

import { app } from '../../server';
import { AppDataSource } from '../../database/data-source';
import { UploadSession } from '../../database/entities/UploadSession';
import { Message } from '../../database/entities/Message';
import {
  createTestTenant,
  createTestAnchorBot,
  createTestUser,
  createTestAgent,
  createTestSession,
} from '../helpers/factories';
import { decrypt } from '../../utils/encryption';
import { formatResponseForChannel } from '../../channels/types';
import { whatsappAdapter } from '../../channels/whatsapp';
import { registerChannelAdapter } from '../../channels/channel-registry';
import { instagramAdapter } from '../../channels/meta';

async function makeTenantWithAi() {
  const tenant = await createTestTenant({ settings: { ai: { apiKey: 'sk-test' } } as never });
  await createTestAnchorBot(tenant);
  return tenant;
}

async function makeOperator(tenantId: string) {
  const user = await createTestUser(tenantId, { role: 'admin' });
  const agent = await createTestAgent(tenantId, user.id);
  return { user, agent };
}

async function createReadyUpload(
  tenantId: string,
  chatSessionId: string,
  overrides: Partial<UploadSession> = {},
): Promise<UploadSession> {
  const repo = AppDataSource.getRepository(UploadSession);
  const sessionId = randomUUID();
  return repo.save(
    repo.create({
      sessionId,
      tenantId,
      chatSessionId,
      userId: randomUUID(),
      fileKey: `uploads/${tenantId}/test/${sessionId}.pdf`,
      fileHash: 'deadbeef',
      originalName: 'doc.pdf',
      fileSize: 1024,
      mimeType: 'application/pdf',
      uploadUrl: 'https://example.com/upload',
      publicUrl: 'https://example.com/public',
      status: 'ready',
      expiresAt: new Date(Date.now() + 3_600_000),
      ...overrides,
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  registerChannelAdapter(instagramAdapter);
});
describe('POST /chats/:id/messages — attachments', () => {
  it('persists a ready file attachment with empty content', async () => {
    const tenant = await makeTenantWithAi();
    const { agent } = await makeOperator(tenant.id);
    const session = await createTestSession(tenant.id, { status: 'bot' });
    const upload = await createReadyUpload(tenant.id, session.id);
    configureMockAuth(auth, { userId: agent.id, tenantId: tenant.id, role: 'admin' });

    const res = await request(app)
      .post(`/api/v1/chats/${session.id}/messages`)
      .send({ clientMessageId: 'attach-1', content: '', attachment: { uploadSessionId: upload.sessionId } });

    expect(res.status).toBe(201);
    expect(res.body.data.outcome).toBe('sent');

    const row = await AppDataSource.getRepository(Message).findOneByOrFail({ id: res.body.data.message.id });
    expect(row.type).toBe('file');
    expect(row.metadata?.uploadSessionId).toBe(upload.sessionId);
    expect(decrypt(row.content, row.id)).toBe('');
  });

  it('rejects a session that has not finished scanning', async () => {
    const tenant = await makeTenantWithAi();
    const { agent } = await makeOperator(tenant.id);
    const session = await createTestSession(tenant.id, { status: 'bot' });
    const upload = await createReadyUpload(tenant.id, session.id, { status: 'pending' });
    configureMockAuth(auth, { userId: agent.id, tenantId: tenant.id, role: 'admin' });

    const res = await request(app)
      .post(`/api/v1/chats/${session.id}/messages`)
      .send({ clientMessageId: 'attach-2', content: '', attachment: { uploadSessionId: upload.sessionId } });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('ATTACHMENT_NOT_READY');
  });

  it('returns 404 when the upload belongs to another chat', async () => {
    const tenant = await makeTenantWithAi();
    const { agent } = await makeOperator(tenant.id);
    const session = await createTestSession(tenant.id, { status: 'bot' });
    const other = await createTestSession(tenant.id, { status: 'bot' });
    const upload = await createReadyUpload(tenant.id, other.id);
    configureMockAuth(auth, { userId: agent.id, tenantId: tenant.id, role: 'admin' });

    const res = await request(app)
      .post(`/api/v1/chats/${session.id}/messages`)
      .send({ clientMessageId: 'attach-3', content: '', attachment: { uploadSessionId: upload.sessionId } });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('requires content when no attachment is sent', async () => {
    const tenant = await makeTenantWithAi();
    const { agent } = await makeOperator(tenant.id);
    const session = await createTestSession(tenant.id, { status: 'bot' });
    configureMockAuth(auth, { userId: agent.id, tenantId: tenant.id, role: 'admin' });

    const res = await request(app)
      .post(`/api/v1/chats/${session.id}/messages`)
      .send({ clientMessageId: 'attach-4', content: '' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('content is required');
  });

  it('rejects document attachments on Instagram sessions', async () => {
    const tenant = await makeTenantWithAi();
    const { agent } = await makeOperator(tenant.id);
    const session = await createTestSession(tenant.id, {
      status: 'bot',
      channel: 'instagram',
      source: 'instagram',
    });
    const upload = await createReadyUpload(tenant.id, session.id);
    configureMockAuth(auth, { userId: agent.id, tenantId: tenant.id, role: 'admin' });

    const res = await request(app)
      .post(`/api/v1/chats/${session.id}/messages`)
      .send({ clientMessageId: 'attach-5', content: '', attachment: { uploadSessionId: upload.sessionId } });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('ATTACHMENT_UNSUPPORTED_ON_CHANNEL');
  });
});

describe('formatMediaMessage mediaUrl split', () => {
  it('does not duplicate mediaUrl into content for WhatsApp caps', () => {
    const caps = whatsappAdapter.outboundTransport.getCapabilities();
    const result = formatResponseForChannel(
      { type: 'image', mediaUrl: 'https://x/y.png', content: '' },
      caps,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'image',
      mediaUrl: 'https://x/y.png',
      content: undefined,
    });
  });
});
