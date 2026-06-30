import { describe, it, expect } from 'vitest';
import { previewLedger } from '../../templates/template-preview';

describe('previewLedger (L10/Phase 4 — mock-context preview)', () => {
  it('returns prompt + ledger; scope is customer_reply', () => {
    const r = previewLedger({ body: 'You are a plumber bot.', tier: 'pro', channel: 'widget' });
    expect(typeof r.prompt).toBe('string');
    expect(r.scope).toBe('customer_reply');
    expect(r.includedBlocks).toContain('TEMPLATE_BODY');
    expect(r.allowedTools).toContain('kb_search');
  });

  it('models capture_lead only when tier != free, and the proactive channel block only for pro/enterprise', () => {
    const proWa = previewLedger({ body: '', tier: 'pro', channel: 'whatsapp' });
    expect(proWa.allowedTools).toContain('capture_lead');
    expect(proWa.includedBlocks).toContain('CHANNEL_LEAD_CAPTURE');

    const essWa = previewLedger({ body: '', tier: 'essential', channel: 'whatsapp' });
    expect(essWa.allowedTools).toContain('capture_lead'); // essential still has leadCapture
    expect(essWa.excludedBlocks).toContainEqual({ key: 'CHANNEL_LEAD_CAPTURE', reason: 'tier' });

    const free = previewLedger({ body: '', tier: 'free', channel: 'widget' });
    expect(free.allowedTools).not.toContain('capture_lead');
  });

  it('models booking tools when the booking module is mock-active → BOOKING included', () => {
    const withBooking = previewLedger({ body: '', tier: 'pro', activeModules: ['booking'] });
    expect(withBooking.allowedTools).toContain('create_booking');
    expect(withBooking.includedBlocks).toContain('BOOKING');

    const noBooking = previewLedger({ body: '', tier: 'pro', activeModules: [] });
    expect(noBooking.excludedBlocks).toContainEqual({ key: 'BOOKING', reason: 'toolAbsent' });
  });
});
