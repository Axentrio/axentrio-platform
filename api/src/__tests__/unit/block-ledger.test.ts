import { describe, it, expect } from 'vitest';
import { composeSystemPrompt } from '../../llm/compose-system-prompt';

// Minimal ToolAdapter stub — only `.name` is read by the composer.
const tool = (name: string) => ({ name } as any);
const ai = { enabled: true } as any;
const base = { mode: 'agent' as const, ai, tenantName: 'Acme' };

const included = (ctx: any) => composeSystemPrompt({ ...base, ...ctx }).ledger.getIncluded();
const excluded = (ctx: any) => composeSystemPrompt({ ...base, ...ctx }).ledger.getExcluded();

describe('block ledger — agent mode', () => {
  it('returns { prompt, ledger }; prompt is the composed string', () => {
    const out = composeSystemPrompt({ ...base, tools: [] });
    expect(typeof out.prompt).toBe('string');
    expect(out.prompt).toContain('LANGUAGE');
    expect(out.ledger).toBeDefined();
  });

  it('records allowedTools from the passed tool list', () => {
    const out = composeSystemPrompt({ ...base, tools: [tool('kb_search'), tool('capture_lead')] });
    expect(out.ledger.getAllowedTools()).toEqual(['kb_search', 'capture_lead']);
  });

  it('KNOWLEDGE: include with kb_search, exclude(toolAbsent) without', () => {
    expect(included({ tools: [tool('kb_search')] })).toContain('KNOWLEDGE');
    expect(excluded({ tools: [] })).toContainEqual({ key: 'KNOWLEDGE', reason: 'toolAbsent' });
  });

  it('CONTACT_DETAILS: include with capture_lead, exclude(toolAbsent) without', () => {
    expect(included({ tools: [tool('capture_lead')] })).toContain('CONTACT_DETAILS');
    expect(excluded({ tools: [] })).toContainEqual({ key: 'CONTACT_DETAILS', reason: 'toolAbsent' });
  });

  it('CHANNEL_LEAD_CAPTURE (L8 tier guard): pro/enterprise on a non-widget channel → include; essential/no-tier on a channel → exclude(tier); widget → exclude(channel); no capture_lead → exclude(toolAbsent)', () => {
    const cap = [tool('capture_lead')];
    // proactive only for pro/enterprise on a real channel
    expect(included({ tools: cap, channel: 'whatsapp', tier: 'pro' })).toContain('CHANNEL_LEAD_CAPTURE');
    expect(included({ tools: cap, channel: 'whatsapp', tier: 'enterprise' })).toContain('CHANNEL_LEAD_CAPTURE');
    // essential / free / absent tier on a channel → fail-safe passive (exclude tier)
    expect(excluded({ tools: cap, channel: 'whatsapp', tier: 'essential' })).toContainEqual({ key: 'CHANNEL_LEAD_CAPTURE', reason: 'tier' });
    expect(excluded({ tools: cap, channel: 'whatsapp' })).toContainEqual({ key: 'CHANNEL_LEAD_CAPTURE', reason: 'tier' });
    // widget (any tier) → channel
    expect(excluded({ tools: cap, channel: 'widget', tier: 'pro' })).toContainEqual({ key: 'CHANNEL_LEAD_CAPTURE', reason: 'channel' });
    expect(excluded({ tools: cap, tier: 'pro' })).toContainEqual({ key: 'CHANNEL_LEAD_CAPTURE', reason: 'channel' });
    // no capture_lead → toolAbsent
    expect(excluded({ tools: [] })).toContainEqual({ key: 'CHANNEL_LEAD_CAPTURE', reason: 'toolAbsent' });
  });

  it('SOCIAL_SHORT_REPLY (L11/AC14): include on a non-widget channel (any tier), exclude(channel) on widget/absent', () => {
    expect(included({ tools: [], channel: 'whatsapp' })).toContain('SOCIAL_SHORT_REPLY');
    expect(included({ tools: [], channel: 'instagram', tier: 'essential' })).toContain('SOCIAL_SHORT_REPLY');
    expect(excluded({ tools: [], channel: 'widget' })).toContainEqual({ key: 'SOCIAL_SHORT_REPLY', reason: 'channel' });
    expect(excluded({ tools: [] })).toContainEqual({ key: 'SOCIAL_SHORT_REPLY', reason: 'channel' });
  });

  it('CONTACT_DETAILS (passive) stays for any tier with capture_lead', () => {
    expect(included({ tools: [tool('capture_lead')], channel: 'whatsapp', tier: 'essential' })).toContain('CONTACT_DETAILS');
  });

  it('ESCALATION: include with escalate_to_human, exclude(toolAbsent) without', () => {
    expect(included({ tools: [tool('escalate_to_human')] })).toContain('ESCALATION');
    expect(excluded({ tools: [] })).toContainEqual({ key: 'ESCALATION', reason: 'toolAbsent' });
  });

  it('BOOKING: include when configured, exclude(bookingConfigured) when tools present but unconfigured, exclude(toolAbsent) when no tools', () => {
    expect(included({ tools: [tool('create_booking')], bookingConfigured: true })).toContain('BOOKING');
    expect(excluded({ tools: [tool('create_booking')], bookingConfigured: false })).toContainEqual({ key: 'BOOKING', reason: 'bookingConfigured' });
    expect(excluded({ tools: [] })).toContainEqual({ key: 'BOOKING', reason: 'toolAbsent' });
  });

  it('TEMPLATE_BODY: included with a real body, AND via the generic-core fallback when blank (AC4); empty only when no ai slice', () => {
    expect(included({ tools: [], templateBody: 'You are a plumber bot.' })).toContain('TEMPLATE_BODY');
    // empty real body + ai present → generic service-business core fallback → still TEMPLATE_BODY
    expect(included({ tools: [], templateBody: '' })).toContain('TEMPLATE_BODY');
    // only a missing ai slice yields no core
    expect(excluded({ ai: undefined, tools: [] })).toContainEqual({ key: 'TEMPLATE_BODY', reason: 'empty' });
  });

  it('CUSTOM_INSTRUCTIONS: include when present, exclude(empty) when absent', () => {
    const withCustom = { enabled: true, brandVoice: { customInstructions: 'Be concise.' } } as any;
    expect(included({ ai: withCustom, tools: [] })).toContain('CUSTOM_INSTRUCTIONS');
    expect(excluded({ tools: [] })).toContainEqual({ key: 'CUSTOM_INSTRUCTIONS', reason: 'empty' });
  });

  it('EXTRA_INFO: include when present, exclude(empty) when absent', () => {
    const withExtra = { enabled: true, extraInfo: 'We are closed on Sundays.' } as any;
    expect(included({ ai: withExtra, tools: [] })).toContain('EXTRA_INFO');
    expect(excluded({ tools: [] })).toContainEqual({ key: 'EXTRA_INFO', reason: 'empty' });
  });

  it('CUSTOMER_NAME: include when known, exclude(empty) when not', () => {
    expect(included({ tools: [], customerName: 'Ian' })).toContain('CUSTOMER_NAME');
    expect(excluded({ tools: [] })).toContainEqual({ key: 'CUSTOMER_NAME', reason: 'empty' });
  });

  it('AVAILABLE_SKILLS: include when an enabled skill has its tools, exclude(empty) otherwise', () => {
    const skill = { name: 'FAQ', trigger: 'questions', tools: ['kb_search'], instructions: 'answer', maxSteps: 1, enabled: true };
    expect(included({ tools: [tool('kb_search')], skills: [skill] })).toContain('AVAILABLE_SKILLS');
    expect(excluded({ tools: [tool('kb_search')], skills: [] })).toContainEqual({ key: 'AVAILABLE_SKILLS', reason: 'empty' });
  });

  it('KB_CONTEXT: include when present, exclude(empty) when absent', () => {
    expect(included({ tools: [], kbContext: 'Opening hours: 9-5' })).toContain('KB_CONTEXT');
    expect(excluded({ tools: [] })).toContainEqual({ key: 'KB_CONTEXT', reason: 'empty' });
  });

  it('SPECIALTY_<key> (S4): include with the exception block when requiresSpecialPrompt + block text', () => {
    const specialties = [{ key: 'emergency', name: 'Emergency call-out', block: 'EMERGENCY HANDLING: act fast.', requiresSpecialPrompt: true }];
    const out = composeSystemPrompt({ ...base, tools: [], specialties });
    expect(out.ledger.getIncluded()).toContain('SPECIALTY_emergency');
    expect(out.prompt).toContain('EMERGENCY HANDLING: act fast.');
  });

  it('SPECIALTY_<key>: exclude(specialty) when selected but carries no exception prompt (retrieval-bias only)', () => {
    const specialties = [{ key: 'leaks', name: 'Leaks', block: null, requiresSpecialPrompt: false }];
    expect(excluded({ tools: [], specialties })).toContainEqual({ key: 'SPECIALTY_leaks', reason: 'specialty' });
  });

  it('SPECIALTY_<key>: exclude(empty) when requiresSpecialPrompt but the block text is missing (misconfig, fail-safe)', () => {
    const specialties = [{ key: 'x', name: 'X', block: null, requiresSpecialPrompt: true }];
    expect(excluded({ tools: [], specialties })).toContainEqual({ key: 'SPECIALTY_x', reason: 'empty' });
  });

  it('does NOT record MODULE_<id> keys (those are owned by agent.service)', () => {
    const out = composeSystemPrompt({ ...base, tools: [], moduleSections: ['## SERVICES\nHaircut'] });
    expect(out.ledger.getIncluded().some((k) => k.startsWith('MODULE_'))).toBe(false);
    expect(out.ledger.getExcluded().some((e) => e.key.startsWith('MODULE_'))).toBe(false);
  });
});
