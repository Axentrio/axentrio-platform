import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mocks (must come before imports) ────────────────────────────────────────

let mockDefaultWebhookUrl: string | undefined = 'http://n8n:5678/webhook/default';
let mockInboundSecret: string | undefined = 'shared-inbound-secret';

vi.mock('../../config/environment', () => ({
  config: {
    n8n: {
      get defaultWebhookUrl() { return mockDefaultWebhookUrl; },
      get inboundSecret() { return mockInboundSecret; },
    },
    s3: {},
  },
}));

const mockFindOneOrFail = vi.fn();
const mockSave = vi.fn();

vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: () => ({
      findOneOrFail: mockFindOneOrFail,
      save: mockSave,
    }),
    query: vi.fn(),
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../utils/encryption', () => ({
  encrypt: vi.fn((v: string) => `enc:${v}`),
  decrypt: vi.fn((v: string) => v),
}));

vi.mock('../../database/entities/Tenant', () => ({ Tenant: class {} }));
vi.mock('../../knowledge/knowledge.service', () => ({ KnowledgeService: class {} }));
vi.mock('../../llm/rag.service', () => ({ generateResponse: vi.fn() }));
vi.mock('../../config/s3.config', () => ({ createS3Client: vi.fn() }));

// ── Imports (after mocks) ───────────────────────────────────────────────────

import { updateAiSettings } from '../../knowledge/knowledge.controller';

const TENANT_ID = '550e8400-e29b-41d4-a716-446655440000';

function makeMockReqRes(body: Record<string, unknown>) {
  const req = {
    tenantId: TENANT_ID,
    body,
    params: {},
    query: {},
  } as any;

  const resBody: { json?: unknown; status?: number } = {};
  const res = {
    json: vi.fn((data: unknown) => { resBody.json = data; }),
    status: vi.fn().mockReturnThis(),
    send: vi.fn(),
  } as any;

  return { req, res, resBody };
}

function makeTenant(overrides: Record<string, any> = {}) {
  return {
    id: TENANT_ID,
    name: 'Test Tenant',
    webhookUrl: undefined as string | undefined,
    webhookSecret: undefined as string | undefined,
    settings: { ai: {} } as any,
    ...overrides,
  };
}

describe('Auto-provisioning webhook in updateAiSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDefaultWebhookUrl = 'http://n8n:5678/webhook/default';
    mockInboundSecret = 'shared-inbound-secret';
    mockSave.mockImplementation(async (t: any) => t);
  });

  it('should auto-provision webhookUrl when AI is enabled and no webhookUrl exists', async () => {
    const tenant = makeTenant({ settings: {} });
    mockFindOneOrFail.mockResolvedValue(tenant);

    const { req, res } = makeMockReqRes({ enabled: true });
    await updateAiSettings(req, res);

    expect(mockSave).toHaveBeenCalled();
    const savedTenant = mockSave.mock.calls[0][0];
    expect(savedTenant.webhookUrl).toBe('http://n8n:5678/webhook/default');
  });

  it('should auto-provision both webhookUrl and webhookSecret when both are missing', async () => {
    const tenant = makeTenant({ settings: {} });
    mockFindOneOrFail.mockResolvedValue(tenant);

    const { req, res } = makeMockReqRes({ enabled: true });
    await updateAiSettings(req, res);

    const savedTenant = mockSave.mock.calls[0][0];
    expect(savedTenant.webhookUrl).toBe('http://n8n:5678/webhook/default');
    expect(savedTenant.webhookSecret).toBe('shared-inbound-secret');
  });

  it('should NOT overwrite existing webhookUrl when AI is enabled', async () => {
    const tenant = makeTenant({
      webhookUrl: 'http://custom.webhook/endpoint',
      settings: {},
    });
    mockFindOneOrFail.mockResolvedValue(tenant);

    const { req, res } = makeMockReqRes({ enabled: true });
    await updateAiSettings(req, res);

    const savedTenant = mockSave.mock.calls[0][0];
    expect(savedTenant.webhookUrl).toBe('http://custom.webhook/endpoint');
  });

  it('should NOT set webhookUrl when AI is disabled', async () => {
    const tenant = makeTenant({ settings: {} });
    mockFindOneOrFail.mockResolvedValue(tenant);

    const { req, res } = makeMockReqRes({ enabled: false });
    await updateAiSettings(req, res);

    const savedTenant = mockSave.mock.calls[0][0];
    expect(savedTenant.webhookUrl).toBeUndefined();
  });

  it('should NOT set webhookUrl when defaultWebhookUrl is not configured', async () => {
    mockDefaultWebhookUrl = undefined;
    const tenant = makeTenant({ settings: {} });
    mockFindOneOrFail.mockResolvedValue(tenant);

    const { req, res } = makeMockReqRes({ enabled: true });
    await updateAiSettings(req, res);

    const savedTenant = mockSave.mock.calls[0][0];
    expect(savedTenant.webhookUrl).toBeUndefined();
  });

  it('should preserve existing webhookSecret when webhookUrl is auto-provisioned', async () => {
    const tenant = makeTenant({
      webhookSecret: 'existing-secret',
      settings: {},
    });
    mockFindOneOrFail.mockResolvedValue(tenant);

    const { req, res } = makeMockReqRes({ enabled: true });
    await updateAiSettings(req, res);

    const savedTenant = mockSave.mock.calls[0][0];
    expect(savedTenant.webhookUrl).toBe('http://n8n:5678/webhook/default');
    expect(savedTenant.webhookSecret).toBe('existing-secret');
  });
});
