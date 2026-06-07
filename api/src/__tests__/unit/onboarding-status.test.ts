import { describe, it, expect } from 'vitest';
import { computeOnboardingStatus } from '../../routes/tenants';

describe('computeOnboardingStatus', () => {
  it('returns all false for empty tenant', () => {
    const result = computeOnboardingStatus({ settings: {} } as any, 0);
    expect(result.complete).toBe(false);
    expect(result.completedCount).toBe(0);
    expect(result.steps.aiEnabled).toBe(false);
  });

  it('detects AI enabled', () => {
    const result = computeOnboardingStatus({
      settings: { ai: { enabled: true } },
    } as any, 0);
    expect(result.steps.aiEnabled).toBe(true);
    expect(result.completedCount).toBe(1);
  });

  it('detects brand voice configured', () => {
    const result = computeOnboardingStatus({
      settings: { ai: { enabled: true, brandVoice: { name: 'MyBot' } } },
    } as any, 0);
    expect(result.steps.brandVoiceConfigured).toBe(true);
  });

  it('detects KB docs', () => {
    const result = computeOnboardingStatus({ settings: {} } as any, 5);
    expect(result.steps.knowledgeBaseHasDocs).toBe(true);
  });

  it('returns complete when all steps done', () => {
    const result = computeOnboardingStatus({
      settings: {
        ai: { enabled: true, brandVoice: { name: 'Bot' } },
        automations: { emailNotifications: { newLeadAlert: { enabled: true } } },
      },
    } as any, 3);
    expect(result.complete).toBe(true);
    expect(result.completedCount).toBe(4);
  });

  it('does not count brand voice when name is the default', () => {
    const result = computeOnboardingStatus({
      settings: { ai: { enabled: true, brandVoice: { name: 'Organization Assistant' } } },
    } as any, 0);
    expect(result.steps.brandVoiceConfigured).toBe(false);
  });

  it('returns totalCount of 4', () => {
    const result = computeOnboardingStatus({ settings: {} } as any, 0);
    expect(result.totalCount).toBe(4);
  });

  it('detects automations configured via bookingConfirmation', () => {
    const result = computeOnboardingStatus({
      settings: {
        automations: { emailNotifications: { bookingConfirmation: { enabled: true } } },
      },
    } as any, 0);
    expect(result.steps.automationsConfigured).toBe(true);
  });

  it('detects automations configured via conversationSummary', () => {
    const result = computeOnboardingStatus({
      settings: {
        automations: { emailNotifications: { conversationSummary: { enabled: true } } },
      },
    } as any, 0);
    expect(result.steps.automationsConfigured).toBe(true);
  });

  it('does not detect automations when all disabled', () => {
    const result = computeOnboardingStatus({
      settings: {
        automations: {
          emailNotifications: {
            bookingConfirmation: { enabled: false },
            newLeadAlert: { enabled: false },
          },
        },
      },
    } as any, 0);
    expect(result.steps.automationsConfigured).toBe(false);
  });
});
