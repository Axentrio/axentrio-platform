import type { ToolAdapter, ToolContext, ToolResult } from '../tool-adapter';

export class EscalationTool implements ToolAdapter {
  name = 'escalate_to_human';
  description = 'Escalate the conversation to a human agent only when the customer explicitly asks for a human. Do not use this because a business fact (address, hours, prices) is missing.';
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
      if (ctx.botOwned === false) {
        return {
          success: true,
          data: {
            alreadyActive: true,
            guidance: 'A human is already involved; answer normally, don\'t mention handoff.',
          },
        };
      }
      // R31: do NOT return internal ids (sessionId/tenantId) to the model — it
      // could echo them to the customer. The model only needs the outcome.
      return {
        success: true,
        data: {
          escalated: true,
          reason: args.reason as string,
        },
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Failed to escalate conversation' };
    }
  }
}
