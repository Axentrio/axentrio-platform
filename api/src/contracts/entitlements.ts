/**
 * Wire contract: GET /api/v1/entitlements — the single source of truth for
 * the shapes BOTH packages compile against. The portal imports these
 * type-only (no runtime coupling); the api types its responses with them.
 *
 * Rules for this directory:
 *  - pure types only — no imports, no runtime code (the portal type-checks
 *    these files under its own tsconfig)
 *  - additive changes are safe; renames/removals are breaking and must ship
 *    with a portal change in the same commit (the shared type makes tsc
 *    fail on whichever side forgets)
 */

export type InternalPlanId = 'free' | 'essential' | 'pro' | 'enterprise';
export type SupportTier = 'none' | 'email' | 'priority';

/** Flat boolean feature map — every gate on both sides reads `features.x`. */
export interface PlanFeatures {
  unifiedInbox: boolean;
  bookings: boolean;
  calendarSync: boolean;
  leadCapture: boolean;
  platformAssistant: boolean;
  crm: boolean;
  hideWidgetAttribution: boolean;
  customWidgetAppearance: boolean;
  handoff: boolean;
  fileUpload: boolean;
  channelWhatsapp: boolean;
  channelMessenger: boolean;
  channelInstagram: boolean;
  channelTelegram: boolean;
  /** Tiered Insights ladder (ADR-0013). */
  gapInsights: boolean;
  gapEvidence: boolean;
  aiBusinessInsights: boolean;
}

export interface PlanLimits {
  agents: number | null;
  bots?: number | null;
  sessions: number | null;
  dailyLlmCalls: number | null;
}

export interface EntitlementsDto {
  planId: InternalPlanId;
  billable?: boolean;
  limits: PlanLimits;
  features: PlanFeatures;
  support: SupportTier;
  /** Module ids active for the tenant (feature- or enablement-gated). */
  activeModules: string[];
}

export interface PlanDefinitionDto {
  id: InternalPlanId;
  displayName: string;
  rank: number;
  priceEurMonthly: number | null;
  isSelfServeCheckoutable: boolean;
  limits: PlanLimits;
  features: PlanFeatures;
  support: SupportTier;
}

export interface EntitlementsResponse {
  current: EntitlementsDto;
  plans: PlanDefinitionDto[];
  selfServePlans: InternalPlanId[];
}
