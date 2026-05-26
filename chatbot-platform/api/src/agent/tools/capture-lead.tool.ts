import type { ToolAdapter, ToolContext, ToolResult } from '../tool-adapter';
import { emitWebhookEvent, buildEventBase } from '../../webhooks/webhook.emitter';
import { ChatSession } from '../../database/entities/ChatSession';
import { Lead } from '../../database/entities/Lead';
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
      // Load the session so we can populate bot_id on the Lead row and have
      // the channel/visitor metadata for the outbound webhook event.
      let session: ChatSession | null = null;
      try {
        session = await ctx.dataSource
          .getRepository(ChatSession)
          .findOne({ where: { id: ctx.sessionId } });
      } catch {
        // non-fatal — webhook event base will use defaults
      }

      // M6: leads are now first-class. Write to `chatbot_leads` as the
      // source of truth.
      const leadRepo = ctx.dataSource.getRepository(Lead);
      const lead = await leadRepo.save(
        leadRepo.create({
          tenantId: ctx.tenantId,
          sessionId: ctx.sessionId,
          botId: session?.botId ?? null,
          name,
          email,
          phone: phone ?? null,
          source: 'tool',
          metadata: {},
        }),
      );

      // Keep the legacy `session.metadata.lead` mirror so existing n8n
      // workflows that read it still work. A future cleanup migration
      // will retire this once everything's been switched over.
      await ctx.dataSource.query(
        `UPDATE chat_sessions SET metadata = jsonb_set(COALESCE(metadata, '{}'), '{lead}', $1::jsonb) WHERE id = $2`,
        [
          JSON.stringify({
            name,
            email,
            phone: phone ?? null,
            capturedAt: lead.createdAt.toISOString(),
            leadId: lead.id,
          }),
          ctx.sessionId,
        ],
      );

      // Fire-and-forget outbound webhook so external systems (n8n, CRM)
      // can react in real time. The event shape pre-dates the Lead table
      // and is intentionally backwards-compatible.
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

      return {
        success: true,
        data: { message: 'Lead captured', name, email, leadId: lead.id },
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to capture lead',
      };
    }
  }
}
