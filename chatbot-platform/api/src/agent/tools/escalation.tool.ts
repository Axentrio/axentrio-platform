import type { ToolAdapter, ToolContext, ToolResult } from '../tool-adapter';

export class EscalationTool implements ToolAdapter {
  name = 'escalate_to_human';
  description = 'Escalate the conversation to a human agent when the bot cannot resolve the customer issue.';
  parameters = {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        description: 'The reason for escalating to a human agent.',
      },
    },
    required: ['reason'],
  };
  hasSideEffects = true;

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      return {
        success: true,
        data: {
          escalated: true,
          reason: args.reason as string,
          sessionId: ctx.sessionId,
          tenantId: ctx.tenantId,
        },
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Failed to escalate conversation' };
    }
  }
}
