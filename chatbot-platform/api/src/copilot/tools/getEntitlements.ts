/**
 * Copilot tool: getEntitlements
 *
 * Returns the current tenant's feature flags. The LLM uses this to
 * answer questions like:
 *   - "Can I connect Cal.com?" → check `features.calendarIntegrations`
 *   - "Why can't I use custom widget colours?" → check `features.customWidgetAppearance`
 *
 * Only the `features` slice is exposed. Limits (max sessions, daily
 * LLM call cap) are deliberately omitted in v1 — they're operator
 * metrics, not admin-facing facts, and the prompt template can lean
 * on getTenantSummary + plan docs instead.
 */
import { Tenant } from '../../database/entities/Tenant';
import { entitlementsFor } from '../../billing/entitlements';
import type { CopilotTool, CopilotToolContext } from './types';

export interface EntitlementsResult {
  features: {
    bookings: boolean;
    calendarIntegrations: boolean;
    hideWidgetAttribution: boolean;
    customWidgetAppearance: boolean;
    leadCapture: boolean;
    platformAssistant: boolean;
    crm: boolean;
    handoff: boolean;
    fileUpload: boolean;
    unifiedInbox: boolean;
  };
}

export const getEntitlements: CopilotTool<Record<string, never>, EntitlementsResult> = {
  name: 'getEntitlements',
  description:
    'Return the current tenant\'s feature flags as a flat boolean map: bookings, calendarIntegrations, hideWidgetAttribution, customWidgetAppearance, leadCapture, platformAssistant, crm, handoff, fileUpload, unifiedInbox.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },

  async execute(_args, ctx: CopilotToolContext): Promise<EntitlementsResult> {
    const tenant = await ctx.manager.findOne(Tenant, {
      where: { id: ctx.tenantId },
      select: ['id', 'tier', 'maxSessions', 'dailyLlmCallLimit'],
    });
    if (!tenant) {
      throw new Error(`getEntitlements: tenant ${ctx.tenantId} not found`);
    }

    const e = entitlementsFor(tenant.tier, {
      maxSessions: tenant.maxSessions ?? null,
      dailyLlmCallLimit: tenant.dailyLlmCallLimit ?? null,
    });

    return {
      features: {
        bookings: e.features.bookings,
        calendarIntegrations: e.features.calendarIntegrations,
        hideWidgetAttribution: e.features.hideWidgetAttribution,
        customWidgetAppearance: e.features.customWidgetAppearance,
        leadCapture: e.features.leadCapture,
        platformAssistant: e.features.platformAssistant,
        crm: e.features.crm,
        handoff: e.features.handoff,
        fileUpload: e.features.fileUpload,
        unifiedInbox: e.features.unifiedInbox,
      },
    };
  },
};
