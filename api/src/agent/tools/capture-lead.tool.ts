import type { ToolAdapter, ToolContext, ToolResult } from '../tool-adapter';
import { ChatSession } from '../../database/entities/ChatSession';
import { upsertLead } from '../../leads/lead-capture.service';

export class CaptureLeadTool implements ToolAdapter {
  name = 'capture_lead';
  description =
    'Save the visitor\'s contact details. Call this whenever the visitor shares their email OR phone number during the conversation — you do not need both, either one is enough. Pass whatever name and contact details you have.';
  parameters = {
    type: 'object',
    properties: {
      name: { type: 'string', description: "Visitor's full name (optional if unknown)" },
      email: { type: 'string', description: "Visitor's email address" },
      phone: { type: 'string', description: "Visitor's phone number" },
    },
    required: [],
  };
  hasSideEffects = true;

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const name = (args.name as string | undefined) ?? null;
    const email = (args.email as string | undefined) ?? null;
    const phone = (args.phone as string | undefined) ?? null;

    if (!email && !phone) {
      return { success: false, error: 'Provide at least an email or a phone number.' };
    }

    try {
      // Channel of origin scopes the dedup identity (widget → email/phone key).
      let session: ChatSession | null = null;
      try {
        session = await ctx.dataSource.getRepository(ChatSession).findOne({ where: { id: ctx.sessionId } });
      } catch {
        // non-fatal
      }

      // The single deterministic write path (dedup, entitlement gate, webhook +
      // notification on a new lead). Same service every channel uses.
      const res = await upsertLead({
        dataSource: ctx.dataSource,
        tenantId: ctx.tenantId,
        sessionId: ctx.sessionId,
        botId: session?.botId ?? null,
        source: 'tool',
        channel: session?.channel ?? 'widget',
        name,
        email,
        phone,
      });

      return res
        ? { success: true, data: { message: 'Lead captured', leadId: res.leadId } }
        : { success: true, data: { message: 'Noted.' } }; // gated off / no identifier — never an error to the model
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Failed to capture lead' };
    }
  }
}
