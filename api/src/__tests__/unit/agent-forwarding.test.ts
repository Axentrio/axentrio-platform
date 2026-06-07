import { describe, it, expect } from 'vitest';

/**
 * Pure routing-logic tests for platform agent integration.
 * No service mocking — just validates the decision function that
 * determines whether a message routes to platform agent, n8n custom,
 * or n8n default.
 */

type RoutingTarget = 'platform_agent' | 'n8n_custom' | 'n8n_default' | 'none';

interface RoutingInput {
  aiEnabled: boolean;
  usePlatformAgent: boolean;
  hasCustomWebhookUrl: boolean;
  hasDefaultWebhookUrl: boolean;
  agentServiceAvailable: boolean;
}

/**
 * Mirrors the routing logic in forwardMessageToN8n():
 * 1. Custom webhook → always n8n_custom (even if usePlatformAgent)
 * 2. AI enabled + usePlatformAgent + agentService → platform_agent
 * 3. AI enabled + default webhook → n8n_default
 * 4. Otherwise → none
 */
function determineRoute(input: RoutingInput): RoutingTarget {
  const { aiEnabled, usePlatformAgent, hasCustomWebhookUrl, hasDefaultWebhookUrl, agentServiceAvailable } = input;

  // Custom webhook always wins
  if (hasCustomWebhookUrl) return 'n8n_custom';

  // Platform agent path: AI on + opted in + service ready
  if (aiEnabled && usePlatformAgent && agentServiceAvailable) return 'platform_agent';

  // Default n8n for AI-enabled tenants
  if (aiEnabled && hasDefaultWebhookUrl) return 'n8n_default';

  return 'none';
}

describe('Agent Forwarding Routing', () => {
  it('routes to platform agent when AI enabled + usePlatformAgent=true + no webhookUrl', () => {
    const target = determineRoute({
      aiEnabled: true,
      usePlatformAgent: true,
      hasCustomWebhookUrl: false,
      hasDefaultWebhookUrl: true,
      agentServiceAvailable: true,
    });
    expect(target).toBe('platform_agent');
  });

  it('routes to n8n when tenant has custom webhookUrl (even if usePlatformAgent=true)', () => {
    const target = determineRoute({
      aiEnabled: true,
      usePlatformAgent: true,
      hasCustomWebhookUrl: true,
      hasDefaultWebhookUrl: true,
      agentServiceAvailable: true,
    });
    expect(target).toBe('n8n_custom');
  });

  it('routes to n8n default when AI enabled but usePlatformAgent=false', () => {
    const target = determineRoute({
      aiEnabled: true,
      usePlatformAgent: false,
      hasCustomWebhookUrl: false,
      hasDefaultWebhookUrl: true,
      agentServiceAvailable: true,
    });
    expect(target).toBe('n8n_default');
  });
});

import { isCustomWebhookUrl } from '../../services/message-forwarding.service';

describe('isCustomWebhookUrl — custom vs auto-provisioned default', () => {
  const DEFAULT = 'http://n8n.railway.internal:5678/webhook/chatbot-platform';

  it('treats a url equal to the platform default as NOT custom (the 404-handoff bug)', () => {
    // Regression: an auto-provisioned default webhookUrl must not shadow the
    // platform-agent path. This is what made AI bots hand off on every message.
    expect(isCustomWebhookUrl(DEFAULT, DEFAULT)).toBe(false);
  });

  it('treats an explicit different url as custom', () => {
    expect(isCustomWebhookUrl('https://acme.app/n8n/webhook', DEFAULT)).toBe(true);
  });

  it('null / undefined webhookUrl is not custom', () => {
    expect(isCustomWebhookUrl(null, DEFAULT)).toBe(false);
    expect(isCustomWebhookUrl(undefined, DEFAULT)).toBe(false);
  });

  it('localhost urls are never custom (dev leftovers)', () => {
    expect(isCustomWebhookUrl('http://localhost:5678/webhook/x', DEFAULT)).toBe(false);
  });
});
