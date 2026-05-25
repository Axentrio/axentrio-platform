import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mocks (must come before imports) ────────────────────────────────────────

const mockQuery = vi.fn();

vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    query: (...args: unknown[]) => mockQuery(...args),
    getRepository: vi.fn(),
  },
}));

vi.mock('../../config/environment', () => ({
  config: {
    n8n: {
      defaultWebhookUrl: 'http://n8n:5678/webhook/default',
      inboundSecret: 'inbound-secret',
    },
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
  decrypt: vi.fn((v: string) => v),
  encrypt: vi.fn((v: string) => `enc:${v}`),
}));

// Mock all the entity imports and service dependencies that message-forwarding.service
// uses at module level (getRepository calls at line 25-28)
vi.mock('../../database/entities/ChatSession', () => ({ ChatSession: class {} }));
vi.mock('../../database/entities/Message', () => ({ Message: class {} }));
vi.mock('../../database/entities/Tenant', () => ({ Tenant: class {} }));
vi.mock('../../database/entities/Participant', () => ({ Participant: class {} }));
vi.mock('../../database/entities/HandoffRequest', () => ({ HandoffRequest: class {} }));
vi.mock('../../n8n/outbound.service', () => ({ OutboundService: class {} }));
vi.mock('../../n8n/fallback.service', () => ({ FallbackService: class {} }));
vi.mock('../../n8n/types', () => ({}));
vi.mock('../../websocket/socket.handler', () => ({ emitToTenantAgents: vi.fn() }));
vi.mock('../../llm/rag.service', () => ({ generateResponse: vi.fn() }));
vi.mock('../../channels/outbound-router', () => ({ routeOutboundMessage: vi.fn() }));

// ── Imports (after mocks) ───────────────────────────────────────────────────

import { buildTenantAiConfig, buildKnowledgeBaseMetadata } from '../../services/message-forwarding.service';

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

describe('Payload Enrichment Helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('buildTenantAiConfig', () => {
    // Multi-bot Phase 4 (#16d): signature is now (tenantName, botAiSettings).
    // The behavioural AI slice lives on Bot.settings, not Tenant.settings.
    it('should return undefined when AI is disabled', () => {
      expect(buildTenantAiConfig('Test Tenant', { enabled: false } as any)).toBeUndefined();
    });

    it('should return undefined when AI settings are missing', () => {
      expect(buildTenantAiConfig('Test Tenant', undefined)).toBeUndefined();
    });

    it('should return correct structure with all fields mapped', () => {
      const ai = {
        enabled: true,
        provider: 'openai' as const,
        model: 'gpt-4',
        brandVoice: {
          name: 'TestBot',
          tone: 'friendly',
          customInstructions: 'Be helpful',
        },
        guardrails: {
          topicsToAvoid: ['politics'],
          confidenceThreshold: 0.8,
          maxResponseLength: 300,
          escalationKeywords: ['human', 'agent'],
          greetingMessage: 'Hi!',
          fallbackMessage: 'Sorry',
          offHoursMessage: 'Closed',
        },
      };

      const result = buildTenantAiConfig('Test Tenant', ai);

      expect(result).toEqual({
        brandName: 'TestBot',
        brandTone: 'friendly',
        systemPrompt: 'Be helpful',
        guardrails: {
          topicsToAvoid: ['politics'],
          confidenceThreshold: 0.8,
          maxResponseLength: 300,
          escalationKeywords: ['human', 'agent'],
        },
      });
    });

    it('should use defaults when optional fields are missing', () => {
      const ai = {
        enabled: true,
        provider: 'openai' as const,
        model: 'gpt-4',
        brandVoice: {} as any,
        guardrails: {} as any,
      };

      const result = buildTenantAiConfig('My Tenant', ai);

      expect(result).toBeDefined();
      expect(result!.brandName).toBe('My Tenant');
      expect(result!.brandTone).toBe('professional');
      expect(result!.systemPrompt).toBe('');
      expect(result!.guardrails.topicsToAvoid).toEqual([]);
      expect(result!.guardrails.confidenceThreshold).toBe(0.7);
      expect(result!.guardrails.maxResponseLength).toBe(500);
      expect(result!.guardrails.escalationKeywords).toEqual([]);
    });
  });

  describe('buildKnowledgeBaseMetadata', () => {
    it('should return enabled: true with documentCount when docs exist', async () => {
      mockQuery.mockResolvedValue([{ count: 5 }]);

      const result = await buildKnowledgeBaseMetadata(VALID_UUID);

      expect(result).toEqual({ enabled: true, documentCount: 5 });
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('knowledge_documents'),
        [VALID_UUID],
      );
    });

    it('should return enabled: false with documentCount 0 when no docs', async () => {
      mockQuery.mockResolvedValue([{ count: 0 }]);

      const result = await buildKnowledgeBaseMetadata(VALID_UUID);

      expect(result).toEqual({ enabled: false, documentCount: 0 });
    });

    it('should return enabled: false with documentCount 0 on DB error', async () => {
      mockQuery.mockRejectedValue(new Error('connection refused'));

      const result = await buildKnowledgeBaseMetadata(VALID_UUID);

      expect(result).toEqual({ enabled: false, documentCount: 0 });
    });
  });
});
