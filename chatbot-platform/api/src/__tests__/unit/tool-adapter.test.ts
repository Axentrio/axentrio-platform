// api/src/__tests__/unit/tool-adapter.test.ts
import { describe, it, expect } from 'vitest';
import type { ToolAdapter, ToolContext, ToolResult } from '../../agent/tool-adapter';

describe('ToolAdapter types', () => {
  it('ToolAdapter interface is implementable', () => {
    const adapter: ToolAdapter = {
      name: 'test_tool',
      description: 'A test tool',
      parameters: { type: 'object', properties: { input: { type: 'string' } } },
      hasSideEffects: false,
      async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
        return { success: true, data: { result: args.input } };
      },
    };
    expect(adapter.name).toBe('test_tool');
    expect(adapter.hasSideEffects).toBe(false);
  });

  it('ToolAdapter with preconditions', () => {
    const adapter: ToolAdapter = {
      name: 'create_booking',
      description: 'Create a booking',
      parameters: {},
      hasSideEffects: true,
      preconditions: { toolsCalled: ['check_availability'] },
      async execute() { return { success: true }; },
    };
    expect(adapter.preconditions?.toolsCalled).toContain('check_availability');
  });

  it('ToolResult can carry error', () => {
    const result: ToolResult = { success: false, error: 'Slot unavailable' };
    expect(result.success).toBe(false);
    expect(result.error).toBe('Slot unavailable');
  });
});
