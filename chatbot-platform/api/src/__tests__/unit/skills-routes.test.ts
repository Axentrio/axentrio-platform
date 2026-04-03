import { describe, it, expect, vi } from 'vitest';

vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: vi.fn().mockReturnValue({
      findOne: vi.fn(),
      save: vi.fn(),
    }),
  },
}));

vi.mock('../../agent/tool-registry', () => ({
  ToolRegistry: class {
    getBuiltinToolNames() {
      return ['kb_search', 'check_availability', 'create_booking', 'capture_lead', 'escalate_to_human'];
    }
  },
}));

import { validateSkill, validateToolNames } from '../../routes/skills.routes';

describe('Skills validation', () => {
  it('validates a correct skill', () => {
    const result = validateSkill({
      name: 'booking',
      trigger: 'User wants to schedule',
      tools: ['check_availability', 'create_booking'],
      instructions: 'Check availability first.',
    });
    expect(result.valid).toBe(true);
  });

  it('rejects skill with empty name', () => {
    const result = validateSkill({ name: '', trigger: 'test', tools: ['kb_search'], instructions: 'test' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('name');
  });

  it('rejects skill with invalid characters in name', () => {
    const result = validateSkill({ name: 'my skill!', trigger: 'test', tools: ['kb_search'], instructions: 'test' });
    expect(result.valid).toBe(false);
  });

  it('rejects skill with too-long instructions', () => {
    const result = validateSkill({ name: 'test', trigger: 'test', tools: ['kb_search'], instructions: 'x'.repeat(2001) });
    expect(result.valid).toBe(false);
  });

  it('validates tool names against registry', () => {
    const valid = validateToolNames(['kb_search', 'check_availability']);
    expect(valid.valid).toBe(true);

    const invalid = validateToolNames(['kb_search', 'nonexistent_tool']);
    expect(invalid.valid).toBe(false);
    expect(invalid.invalidTools).toContain('nonexistent_tool');
  });
});
