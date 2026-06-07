import { describe, it, expect } from 'vitest';

/**
 * Pure routing-logic tests for platform agent integration.
 * No service mocking — just validates the decision function that
 * determines whether a message routes to platform agent, n8n custom,
 * or n8n default.
 */

type RoutingTarget = 'platform_agent' | 'n8n_custom' | 'none';

interface RoutingInput {
  aiEnabled: boolean;
  hasCustomWebhookUrl: boolean;
  agentServiceAvailable: boolean;
}

/**
 * Mirrors the routing logic in forwardMessageToN8n() after issue #3. The legacy
 * usePlatformAgent flag is no longer consulted — AI-enabled bots without a
 * custom webhook always use the platform agent:
 * 1. Custom webhook → always n8n_custom
 * 2. AI enabled + agentService → platform_agent
 * 3. Otherwise → none (session stays waiting — the dead default n8n webhook is
 *    NEVER used as a fallback anymore).
 */
function determineRoute(input: RoutingInput): RoutingTarget {
  const { aiEnabled, hasCustomWebhookUrl, agentServiceAvailable } = input;

  // Custom webhook always wins
  if (hasCustomWebhookUrl) return 'n8n_custom';

  // Platform agent path: AI on + service ready (flag-independent)
  if (aiEnabled && agentServiceAvailable) return 'platform_agent';

  return 'none';
}

describe('Agent Forwarding Routing (post issue #3)', () => {
  it('routes to platform agent when AI enabled + no custom webhook', () => {
    const target = determineRoute({
      aiEnabled: true,
      hasCustomWebhookUrl: false,
      agentServiceAvailable: true,
    });
    expect(target).toBe('platform_agent');
  });

  it('routes to n8n when tenant has a custom webhookUrl', () => {
    const target = determineRoute({
      aiEnabled: true,
      hasCustomWebhookUrl: true,
      agentServiceAvailable: true,
    });
    expect(target).toBe('n8n_custom');
  });

  it('routes to none (waiting) when AI disabled and no custom webhook', () => {
    const target = determineRoute({
      aiEnabled: false,
      hasCustomWebhookUrl: false,
      agentServiceAvailable: true,
    });
    expect(target).toBe('none');
  });

  it('routes to none (waiting) when AI enabled but agent service unavailable — never the dead default', () => {
    const target = determineRoute({
      aiEnabled: true,
      hasCustomWebhookUrl: false,
      agentServiceAvailable: false,
    });
    expect(target).toBe('none');
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
