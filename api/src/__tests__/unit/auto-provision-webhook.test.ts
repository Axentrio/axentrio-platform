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

// Multi-bot Phase 4 (#16d): updateAiSettings now also talks to the Bot repo
// (via getAnchorBotConfig + updateAnchorBotSettings) — those call `findOne`.
vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: () => ({
      findOne: mockFindOneOrFail,
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

// Issue #3: updateAiSettings no longer auto-provisions the default n8n webhook.
// AI bots are answered by the platform agent, not the (dead) default webhook.
// A genuinely custom tenant.webhookUrl must be left untouched.
describe('updateAiSettings no longer auto-provisions the default webhook (issue #3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDefaultWebhookUrl = 'http://n8n:5678/webhook/default';
    mockInboundSecret = 'shared-inbound-secret';
    mockSave.mockImplementation(async (t: any) => t);
  });

  it('does NOT set webhookUrl when AI is enabled and none exists', async () => {
    const tenant = makeTenant({ settings: {} });
    mockFindOneOrFail.mockResolvedValue(tenant);

    const { req, res } = makeMockReqRes({ enabled: true });
    await updateAiSettings(req, res);

    expect(tenant.webhookUrl).toBeUndefined();
    expect(tenant.webhookSecret).toBeUndefined();
  });

  it('leaves an existing custom webhookUrl untouched', async () => {
    const tenant = makeTenant({
      webhookUrl: 'http://custom.webhook/endpoint',
      settings: {},
    });
    mockFindOneOrFail.mockResolvedValue(tenant);

    const { req, res } = makeMockReqRes({ enabled: true });
    await updateAiSettings(req, res);

    expect(tenant.webhookUrl).toBe('http://custom.webhook/endpoint');
  });

  it('does NOT set webhookUrl when AI is disabled', async () => {
    const tenant = makeTenant({ settings: {} });
    mockFindOneOrFail.mockResolvedValue(tenant);

    const { req, res } = makeMockReqRes({ enabled: false });
    await updateAiSettings(req, res);

    expect(tenant.webhookUrl).toBeUndefined();
  });
});
