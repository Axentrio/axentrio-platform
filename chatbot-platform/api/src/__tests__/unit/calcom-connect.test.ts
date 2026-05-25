import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mocks (must come before imports) ────────────────────────────────────────

const mockFindOneOrFail = vi.fn();
const mockSave = vi.fn();

// Multi-bot Phase 4 (#16d): integrations.controller writes to Bot.settings.
// A single shared findOne+save is sufficient — connectCalcom calls findOne
// (via getAnchorBotConfig) twice (once to read, once inside the writer) and
// save once.
vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: vi.fn(() => ({
      findOne: mockFindOneOrFail,
      findOneOrFail: mockFindOneOrFail,
      save: mockSave,
    })),
  },
}));

const mockEncrypt = vi.fn((val: string) => `encrypted:${val}`);
vi.mock('../../utils/encryption', () => ({
  encrypt: (val: string) => mockEncrypt(val),
}));

// axios mock: factory uses vi.fn() inline (no top-level variable — avoids hoisting error)
vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
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

vi.mock('../../config/environment', () => ({
  config: {
    n8n: {
      defaultWebhookUrl: 'https://test-webhook.example.com/webhook',
    },
  },
}));

// ── Imports (after mocks) ───────────────────────────────────────────────────

import axios from 'axios';
import { connectCalcom } from '../../knowledge/integrations.controller';

// Typed handle to the mocked axios.get
const mockAxiosGet = axios.get as ReturnType<typeof vi.fn>;

function mockReq(body: any = {}, tenantId = 'tenant-1') {
  return { body, tenantId } as any;
}

function mockRes() {
  const res: any = {};
  res.json = vi.fn().mockReturnValue(res);
  res.status = vi.fn().mockReturnValue(res);
  return res;
}

const sampleEventTypes = [
  { id: 1, title: 'Consultation', slug: 'consultation', lengthInMinutes: 30 },
  { id: 2, title: '', slug: 'quick-call', lengthInMinutes: 15 },
];

describe('connectCalcom', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws BadRequestError if apiKey is missing', async () => {
    const req = mockReq({});
    const res = mockRes();

    await expect(connectCalcom(req, res)).rejects.toThrow(/A valid API key is required/);
    expect(res.json).not.toHaveBeenCalled();
  });

  it('throws BadRequestError if Cal.com rejects the key (401)', async () => {
    const axiosError: any = new Error('Unauthorized');
    axiosError.response = { status: 401 };
    mockAxiosGet.mockRejectedValue(axiosError);

    const req = mockReq({ apiKey: 'bad-key' });
    const res = mockRes();

    await expect(connectCalcom(req, res)).rejects.toThrow(/Invalid or expired API key/);
  });

  it('throws BadRequestError if no event types found', async () => {
    mockAxiosGet.mockResolvedValue({ data: { data: { eventTypeGroups: [] } } });

    const req = mockReq({ apiKey: 'valid-key' });
    const res = mockRes();

    await expect(connectCalcom(req, res)).rejects.toThrow(/No event types found/);
  });

  it('returns 200 with encrypted key stored and event types returned', async () => {
    mockAxiosGet.mockResolvedValue({
      data: {
        data: {
          eventTypeGroups: [{ eventTypes: sampleEventTypes }],
        },
      },
    });

    const tenant = {
      settings: {
        integrations: {
          calcom: {
            apiKey: 'encrypted:old-key',
            eventTypeId: 99,
            webhookUrl: 'https://existing-webhook.example.com',
            language: 'fr',
            collectFields: true,
          },
        },
      },
    };
    mockFindOneOrFail.mockResolvedValue(tenant);
    mockSave.mockResolvedValue(tenant);

    const req = mockReq({ apiKey: 'new-raw-key' });
    const res = mockRes();

    await connectCalcom(req, res);

    // Should encrypt the key
    expect(mockEncrypt).toHaveBeenCalledWith('new-raw-key');

    // Should save with encrypted key and cleared eventTypeId
    const savedTenant = mockSave.mock.calls[0][0];
    expect(savedTenant.settings.integrations.calcom.apiKey).toBe('encrypted:new-raw-key');
    expect(savedTenant.settings.integrations.calcom.eventTypeId).toBeUndefined();

    // Should preserve language and collectFields
    expect(savedTenant.settings.integrations.calcom.language).toBe('fr');
    expect(savedTenant.settings.integrations.calcom.collectFields).toBe(true);

    // Should return 200 with event types wrapped in the success envelope
    expect(res.status).not.toHaveBeenCalledWith(400);
    const jsonArg = res.json.mock.calls[0][0];
    expect(jsonArg.success).toBe(true);
    expect(jsonArg.data.eventTypes).toHaveLength(2);
    expect(jsonArg.data.eventTypes[0]).toEqual({
      id: 1,
      title: 'Consultation',
      slug: 'consultation',
      length: 30,
    });
    // Falls back to slug when title is empty
    expect(jsonArg.data.eventTypes[1]).toEqual({
      id: 2,
      title: 'quick-call',
      slug: 'quick-call',
      length: 15,
    });
  });

  it('auto-sets webhookUrl if currently null/undefined', async () => {
    mockAxiosGet.mockResolvedValue({
      data: {
        data: {
          eventTypeGroups: [{ eventTypes: sampleEventTypes }],
        },
      },
    });

    const tenant = {
      settings: {
        integrations: {
          calcom: {},
        },
      },
    };
    mockFindOneOrFail.mockResolvedValue(tenant);
    mockSave.mockResolvedValue(tenant);

    const req = mockReq({ apiKey: 'some-key' });
    const res = mockRes();

    await connectCalcom(req, res);

    const savedTenant = mockSave.mock.calls[0][0];
    expect(savedTenant.settings.integrations.calcom.webhookUrl).toBe(
      'https://test-webhook.example.com/webhook'
    );
  });

  it('does NOT overwrite existing webhookUrl', async () => {
    mockAxiosGet.mockResolvedValue({
      data: {
        data: {
          eventTypeGroups: [{ eventTypes: sampleEventTypes }],
        },
      },
    });

    const tenant = {
      settings: {
        integrations: {
          calcom: {
            webhookUrl: 'https://custom-webhook.example.com',
          },
        },
      },
    };
    mockFindOneOrFail.mockResolvedValue(tenant);
    mockSave.mockResolvedValue(tenant);

    const req = mockReq({ apiKey: 'some-key' });
    const res = mockRes();

    await connectCalcom(req, res);

    const savedTenant = mockSave.mock.calls[0][0];
    expect(savedTenant.settings.integrations.calcom.webhookUrl).toBe(
      'https://custom-webhook.example.com'
    );
  });
});
