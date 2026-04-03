// api/src/__tests__/unit/prompt-builder.test.ts
import { describe, it, expect } from 'vitest';
import { PromptBuilder } from '../../agent/prompt-builder';
import type { ToolAdapter } from '../../agent/tool-adapter';
import type { Tenant } from '../../database/entities/Tenant';

describe('PromptBuilder', () => {
  const builder = new PromptBuilder();

  const baseTenant = {
    name: 'TestCo',
    settings: {
      ai: {
        enabled: true,
        brandVoice: { name: 'TestBot', tone: 'friendly', customInstructions: 'Always greet the customer.' },
        guardrails: { topicsToAvoid: ['politics'], maxResponseLength: 500, escalationKeywords: [] },
      },
    },
  } as unknown as Tenant;

  const mockTools: ToolAdapter[] = [
    { name: 'kb_search', description: 'Search KB', parameters: {}, hasSideEffects: false, execute: async () => ({ success: true }) },
    { name: 'escalate_to_agent', description: 'Escalate', parameters: {}, hasSideEffects: true, execute: async () => ({ success: true }) },
  ];

  it('includes brand voice in system prompt', () => {
    const prompt = builder.build(baseTenant, mockTools);
    expect(prompt).toContain('TestBot');
    expect(prompt).toContain('friendly');
    expect(prompt).toContain('Always greet the customer.');
  });

  it('includes guardrails', () => {
    const prompt = builder.build(baseTenant, mockTools);
    expect(prompt).toContain('politics');
    expect(prompt).toContain('500');
  });

  it('includes escalation instruction', () => {
    const prompt = builder.build(baseTenant, mockTools);
    expect(prompt).toContain('escalate_to_agent');
  });

  it('includes skill instructions when skills are configured', () => {
    const tenantWithSkills = {
      ...baseTenant,
      settings: {
        ...baseTenant.settings,
        skills: [{
          name: 'booking',
          trigger: 'User wants to schedule',
          tools: ['check_availability', 'create_booking'],
          instructions: 'Always check availability first.',
          maxSteps: 8,
          enabled: true,
        }],
      },
    } as unknown as Tenant;
    const prompt = builder.build(tenantWithSkills, mockTools);
    expect(prompt).toContain('booking');
    expect(prompt).toContain('Always check availability first.');
  });

  it('skips disabled skills', () => {
    const tenantWithDisabled = {
      ...baseTenant,
      settings: {
        ...baseTenant.settings,
        skills: [{ name: 'disabled_skill', trigger: 'x', tools: [], instructions: 'SECRET', maxSteps: 5, enabled: false }],
      },
    } as unknown as Tenant;
    const prompt = builder.build(tenantWithDisabled, mockTools);
    expect(prompt).not.toContain('SECRET');
  });
});
