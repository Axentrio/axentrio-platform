import { describe, it, expect, vi } from 'vitest';

vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: vi.fn().mockReturnValue({
      findOne: vi.fn(),
      save: vi.fn(),
    }),
  },
}));

vi.mock('../../middleware/clerk.middleware', () => ({
  requireClerkAuth: vi.fn(),
  autoProvision: vi.fn(),
}));

vi.mock('../../middleware/auth.middleware', () => ({
  requireRole: vi.fn(() => vi.fn()),
}));

vi.mock('../../middleware/super-admin.middleware', () => ({
  resolveTenantContext: vi.fn(),
}));

import { validateAutomationUpdate } from '../../routes/automations.routes';

describe('validateAutomationUpdate', () => {
  it('accepts a valid bookingConfirmation update', () => {
    const result = validateAutomationUpdate('bookingConfirmation', {
      enabled: true,
      subject: 'Your booking is confirmed',
      body: 'Thank you for booking with us.',
    });
    expect(result.valid).toBe(true);
  });

  it('accepts a valid newLeadAlert with recipients', () => {
    const result = validateAutomationUpdate('newLeadAlert', {
      enabled: true,
      subject: 'New lead alert',
      body: 'A new lead has been captured.',
      recipients: ['admin@example.com'],
    });
    expect(result.valid).toBe(true);
  });

  it('rejects newLeadAlert enabled without recipients', () => {
    const result = validateAutomationUpdate('newLeadAlert', {
      enabled: true,
      subject: 'New lead alert',
      body: 'A new lead has been captured.',
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('recipients');
  });

  it('rejects an unknown automation type', () => {
    const result = validateAutomationUpdate('unknownType', {
      enabled: true,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid automation type');
  });

  it('rejects subject over 200 characters', () => {
    const result = validateAutomationUpdate('bookingConfirmation', {
      subject: 'x'.repeat(201),
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('subject');
  });
});
