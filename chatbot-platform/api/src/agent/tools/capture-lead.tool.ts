import type { ToolAdapter, ToolContext, ToolResult } from '../tool-adapter';
import { emitWebhookEvent, buildEventBase } from '../../webhooks/webhook.emitter';
import { ChatSession } from '../../database/entities/ChatSession';
import type { LeadCreatedEvent } from '../../webhooks/webhook.types';

export class CaptureLeadTool implements ToolAdapter {
  name = 'capture_lead';
  description =
    'Save visitor contact information when they share their name and email during conversation. Call this whenever the visitor provides their email address.';
  parameters = {
    type: 'object',
    properties: {
      name: { type: 'string', description: "Visitor's full name" },
      email: { type: 'string', description: "Visitor's email address" },
      phone: { type: 'string', description: "Visitor's phone number (optional)" },
    },
    required: ['name', 'email'],
  };
  hasSideEffects = true;

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const name = args.name as string;
    const email = args.email as string;
    const phone = args.phone as string | undefined;

    try {
      // Persist lead info into session metadata
      await ctx.dataSource
        .createQueryBuilder()
        .update('chat_sessions')
        .set({
          metadata: () =>
            `jsonb_set(metadata, '{lead}', '${JSON.stringify({ name, email, ...(phone ? { phone } : {}) })}'::jsonb, true)`,
        })
        .where('id = :id', { id: ctx.sessionId })
        .execute();

      // Build and fire webhook event (fire-and-forget)
      let session: ChatSession | null = null;
      try {
        session = await ctx.dataSource
          .getRepository(ChatSession)
          .findOne({ where: { id: ctx.sessionId } });
      } catch {
        // non-fatal — session base will use defaults
      }

      const base = buildEventBase('lead.created', ctx.tenantId, {
        id: ctx.sessionId,
        channel: session?.channel ?? 'widget',
        visitorId: session?.visitorId ?? 'unknown',
        startedAt: session?.startedAt?.toISOString() ?? new Date().toISOString(),
        messageCount: session?.messageCount ?? 0,
        tags: session?.tags,
      });

      const event: LeadCreatedEvent = {
        ...base,
        type: 'lead.created',
        lead: { name, email, ...(phone ? { phone } : {}), source: 'tool' },
      };

      emitWebhookEvent(event);

      return { success: true, data: { message: 'Lead captured', name, email } };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to capture lead',
      };
    }
  }
}
