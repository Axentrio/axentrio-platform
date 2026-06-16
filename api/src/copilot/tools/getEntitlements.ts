/**
 * Copilot tool: getEntitlements
 *
 * Returns the current tenant's feature flags in TWO layers so the assistant
 * can tell apart "not on your plan" from "your admin turned it off":
 *   - `features`         — EFFECTIVE: what is actually live right now
 *                          (plan ⊕ admin overrides ⊕ status deny ⊕ the tenant's
 *                          own on/off toggle).
 *   - `entitledFeatures` — the entitlement CEILING: what the plan grants,
 *                          BEFORE the tenant's toggle. A feature that is
 *                          entitled but not effective was switched off by the
 *                          tenant (Settings → Features), NOT a plan limit.
 *   - `disabledByTenant` — convenience list of features that are entitled but
 *                          toggled off — point the user to Settings → Features,
 *                          not an upgrade.
 *
 * Examples:
 *   - "Can my chatbot take bookings?" → `features.bookings`
 *   - "Why aren't bookings working?" → if `entitledFeatures.bookings` is true
 *     but `features.bookings` is false, it's switched off in Settings → Features;
 *     otherwise it needs a plan upgrade.
 *
 * Limits (max sessions, daily LLM cap) are deliberately omitted in v1 — they're
 * operator metrics, not admin-facing facts.
 */
import { getEntitlements as resolveEntitlements } from '../../billing/entitlements';
import { TENANT_TOGGLEABLE_FEATURES } from '../../billing/feature-toggles';
import type { PlanFeatures } from '../../contracts/entitlements';
import type { CopilotTool, CopilotToolContext } from './types';

export interface EntitlementsResult {
  /** EFFECTIVE flags — live right now (ceiling ∧ tenant toggle). */
  features: PlanFeatures;
  /** Entitlement CEILING — what the plan grants, before the tenant's toggle. */
  entitledFeatures: PlanFeatures;
  /** Entitled-but-toggled-off features — fixable in Settings → Features, not via upgrade. */
  disabledByTenant: string[];
}

export const getEntitlements: CopilotTool<Record<string, never>, EntitlementsResult> = {
  name: 'getEntitlements',
  description:
    "Return the current tenant's feature flags in two layers. `features` is the EFFECTIVE map (what is live right now): bookings, calendarSync, hideWidgetAttribution, customWidgetAppearance, leadCapture, platformAssistant, crm, handoff, fileUpload, unifiedInbox, channelWhatsapp/channelMessenger/channelInstagram/channelTelegram (the website chat widget is always on and has no flag). `entitledFeatures` is the plan CEILING before the tenant's own on/off toggle. When a feature is in `entitledFeatures` (or listed in `disabledByTenant`) but false in `features`, the tenant's admin TURNED IT OFF in Settings → Features — tell them to re-enable it there, do NOT tell them to upgrade. When a feature is false in BOTH, it needs a plan upgrade.",
  parameters: { type: 'object', properties: {}, additionalProperties: false },

  async execute(_args, ctx: CopilotToolContext): Promise<EntitlementsResult> {
    const e = await resolveEntitlements(ctx.tenantId);
    const disabledByTenant = TENANT_TOGGLEABLE_FEATURES.filter(
      (key) => e.entitledFeatures[key] && !e.features[key],
    );

    return {
      features: e.features,
      entitledFeatures: e.entitledFeatures,
      disabledByTenant,
    };
  },
};
