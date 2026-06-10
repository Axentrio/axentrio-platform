/**
 * Copilot tool: getEntitlements
 *
 * Returns the current tenant's RESOLVED feature flags (tier ⊕ per-tenant
 * overrides ⊕ status deny). The LLM uses this to answer questions like:
 *   - "Can my chatbot take bookings?" → check `features.bookings`
 *   - "Can I connect my Google/Outlook calendar?" → check `features.calendarSync`
 *   - "Why can't I use custom widget colours?" → check `features.customWidgetAppearance`
 *
 * Only the `features` slice is exposed. Limits (max sessions, daily
 * LLM call cap) are deliberately omitted in v1 — they're operator
 * metrics, not admin-facing facts, and the prompt template can lean
 * on getTenantSummary + plan docs instead.
 */
import { getEntitlements as resolveEntitlements } from '../../billing/entitlements';
import type { CopilotTool, CopilotToolContext } from './types';

export interface EntitlementsResult {
  features: {
    bookings: boolean;
    calendarSync: boolean;
    hideWidgetAttribution: boolean;
    customWidgetAppearance: boolean;
    leadCapture: boolean;
    platformAssistant: boolean;
    crm: boolean;
    handoff: boolean;
    fileUpload: boolean;
    unifiedInbox: boolean;
    channelWhatsapp: boolean;
    channelMessenger: boolean;
    channelInstagram: boolean;
    channelTelegram: boolean;
  };
}

export const getEntitlements: CopilotTool<Record<string, never>, EntitlementsResult> = {
  name: 'getEntitlements',
  description:
    'Return the current tenant\'s resolved feature flags as a flat boolean map: bookings (the chatbot can take appointments via the built-in scheduler, and the Bookings page is available), calendarSync (the tenant can connect an external Google/Outlook calendar so bookings are mirrored there), hideWidgetAttribution, customWidgetAppearance, leadCapture, platformAssistant, crm, handoff, fileUpload, unifiedInbox, channelWhatsapp/channelMessenger/channelInstagram/channelTelegram (whether each external messaging channel is included — the website chat widget is always available and has no flag). Flags reflect the plan tier plus any admin-set per-tenant overrides.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },

  async execute(_args, ctx: CopilotToolContext): Promise<EntitlementsResult> {
    const e = await resolveEntitlements(ctx.tenantId);

    return {
      features: {
        bookings: e.features.bookings,
        calendarSync: e.features.calendarSync,
        hideWidgetAttribution: e.features.hideWidgetAttribution,
        customWidgetAppearance: e.features.customWidgetAppearance,
        leadCapture: e.features.leadCapture,
        platformAssistant: e.features.platformAssistant,
        crm: e.features.crm,
        handoff: e.features.handoff,
        fileUpload: e.features.fileUpload,
        unifiedInbox: e.features.unifiedInbox,
        channelWhatsapp: e.features.channelWhatsapp,
        channelMessenger: e.features.channelMessenger,
        channelInstagram: e.features.channelInstagram,
        channelTelegram: e.features.channelTelegram,
      },
    };
  },
};
