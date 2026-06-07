import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mocks (must come before imports) ────────────────────────────────────────

const mockFindOneOrFail = vi.fn();
const mockSave = vi.fn();

vi.mock('../../config/environment', () => ({
  config: { n8n: { defaultWebhookUrl: 'https://test-webhook.example.com/webhook' } },
}));

// Multi-bot Phase 4 (#16d): controller now talks to the Bot repo via the
// bot-config service (findOne + save) plus the Tenant repo for webhook
// auto-provisioning (findOneOrFail + save). A single shared mock is fine
// because the test bodies wire up both Tenant + Bot shapes identically.
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

vi.mock('../../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// M5: updateIntegrations / connectCalcom now call requireFeature when a
// calcom block is being set. The pure-function tier check has its own
// tests in calcom-access.test.ts — mock to a no-op here so the controller
// tests can focus on persistence/redaction behaviour.
vi.mock('../../billing/enforce', () => ({
  requireFeature: vi.fn().mockResolvedValue(undefined),
}));

// ── Imports (after mocks) ───────────────────────────────────────────────────

import { getIntegrations, updateIntegrations } from '../../knowledge/integrations.controller';

function mockReq(body: any = {}, tenantId = 'tenant-1') {
  return { body, tenantId } as any;
}

function mockRes() {
  const res: any = {};
  res.json = vi.fn().mockReturnValue(res);
  res.status = vi.fn().mockReturnValue(res);
  return res;
}

describe('Integrations Controller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── getIntegrations ───────────────────────────────────────────────────

  describe('getIntegrations', () => {
    it('should return hasApiKey: true when API key exists (never raw key)', async () => {
      mockFindOneOrFail.mockResolvedValue({
        settings: {
          integrations: {
            calcom: {
              apiKey: 'encrypted:secret-key',
              eventTypeId: 123,
            },
          },
        },
      });

      const req = mockReq();
      const res = mockRes();
      await getIntegrations(req, res);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: { calcom: { eventTypeId: 123, hasApiKey: true } },
      });

      // Ensure raw apiKey is NOT in the response payload
      const responseArg = res.json.mock.calls[0][0];
      expect(responseArg.data.calcom.apiKey).toBeUndefined();
    });

    it('should return empty object when no integrations configured', async () => {
      mockFindOneOrFail.mockResolvedValue({ settings: {} });

      const req = mockReq();
      const res = mockRes();
      await getIntegrations(req, res);

      expect(res.json).toHaveBeenCalledWith({ success: true, data: {} });
    });

    it('should return empty object when settings is undefined', async () => {
      mockFindOneOrFail.mockResolvedValue({ settings: undefined });

      const req = mockReq();
      const res = mockRes();
      await getIntegrations(req, res);

      expect(res.json).toHaveBeenCalledWith({ success: true, data: {} });
    });
  });

  // ── updateIntegrations ────────────────────────────────────────────────

  describe('updateIntegrations', () => {
    it('should encrypt API key before saving', async () => {
      const tenant = {
        settings: { integrations: {} },
      };
      mockFindOneOrFail.mockResolvedValue(tenant);
      mockSave.mockResolvedValue(tenant);

      const req = mockReq({
        calcom: {
          apiKey: 'my-raw-key',
          eventTypeId: 456,
        },
      });
      const res = mockRes();
      await updateIntegrations(req, res);

      expect(mockEncrypt).toHaveBeenCalledWith('my-raw-key');
      expect(mockSave).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: expect.objectContaining({
            integrations: expect.objectContaining({
              calcom: expect.objectContaining({
                apiKey: 'encrypted:my-raw-key',
              }),
            }),
          }),
        })
      );
    });

    it('should remove integration when calcom is null', async () => {
      const tenant = {
        settings: {
          integrations: {
            calcom: { apiKey: 'encrypted:old', eventTypeId: 99 },
          },
        },
      };
      mockFindOneOrFail.mockResolvedValue(tenant);
      mockSave.mockResolvedValue(tenant);

      const req = mockReq({ calcom: null });
      const res = mockRes();
      await updateIntegrations(req, res);

      // Saved settings should not have calcom
      const savedTenant = mockSave.mock.calls[0][0];
      expect(savedTenant.settings.integrations.calcom).toBeUndefined();

      // Response data should be empty
      expect(res.json).toHaveBeenCalledWith({ success: true, data: {} });
    });

    it('should never include raw apiKey in response', async () => {
      const tenant = { settings: { integrations: {} } };
      mockFindOneOrFail.mockResolvedValue(tenant);
      mockSave.mockResolvedValue(tenant);

      const req = mockReq({
        calcom: { apiKey: 'secret', eventTypeId: 100 },
      });
      const res = mockRes();
      await updateIntegrations(req, res);

      const responseArg = res.json.mock.calls[0][0];
      expect(responseArg.data.calcom.apiKey).toBeUndefined();
      expect(responseArg.data.calcom.hasApiKey).toBe(true);
    });

    it('does NOT auto-set tenant.webhookUrl when saving calcom (issue #3)', async () => {
      // Selecting a Cal.com event type used to point tenant.webhookUrl at the
      // dead default n8n webhook. It no longer does — bookings run through the
      // internal engine / platform agent.
      const tenant = {
        id: 'tenant-123',
        settings: { integrations: { calcom: { apiKey: 'encrypted:key' } } },
        webhookUrl: null,
        webhookSecret: null,
      };
      mockFindOneOrFail.mockResolvedValue(tenant);
      mockSave.mockResolvedValue(tenant);

      const req = mockReq({ calcom: { eventTypeId: 123 } }, 'tenant-123');
      const res = mockRes();
      await updateIntegrations(req, res);

      expect(res.json).toHaveBeenCalled();
      expect(tenant.webhookUrl).toBeNull();
      expect(mockSave).not.toHaveBeenCalledWith(
        expect.objectContaining({ webhookUrl: expect.any(String) })
      );
    });
  });
});
