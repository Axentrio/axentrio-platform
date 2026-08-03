/**
 * Who may run an insights analysis, when, and how it is triggered.
 *
 * The three tiers differ in HOW analysis happens, not only in what it shows:
 *
 *   Essential  — manual only, ≥15 new conversations, at most once per 72h
 *   Pro        — manual only, ≥8 new conversations, at most once per 24h
 *   Enterprise — automatic rolling, no button and no cooldown
 *
 * The tier is read from the FEATURE FLAGS, never a tier name, so a super-admin
 * override or a mid-cycle plan change moves a tenant between policies without a
 * second source of truth (ADR-0013). The flags already encode exactly these three
 * bands: `gapInsights` alone is Essential, `+gapEvidence` is Pro, `+aiBusinessInsights`
 * is Enterprise.
 *
 * WHY A MINIMUM AND A COOLDOWN AT ALL. Each analysed conversation costs one LLM call,
 * and the value of a pattern is a function of how many conversations support it — an
 * "insight" drawn from three chats is noise with a confident font. The minimum protects
 * the OUTPUT; the cooldown protects the BILL. They are separate limits because they fail
 * differently: below the minimum we have nothing worth saying, while inside the cooldown
 * we may well have something and are simply declining to pay for it again yet.
 *
 * Pure and dependency-free: the route, the job and the portal copy all derive from this,
 * so there is one place where "can this tenant analyse right now" is decided.
 */
import type { PlanFeatures } from '../billing/types';

export type InsightsTier = 'none' | 'essential' | 'pro' | 'enterprise';

export interface AnalysisPolicy {
  tier: InsightsTier;
  /** Does analysis run on a schedule without the tenant asking? */
  automatic: boolean;
  /** Minimum NEW analysable conversations before a manual run is allowed. */
  minNewChats: number;
  /** Hours that must pass between manual runs. */
  cooldownHours: number;
}

const POLICIES: Record<InsightsTier, AnalysisPolicy> = {
  none: { tier: 'none', automatic: false, minNewChats: Infinity, cooldownHours: Infinity },
  essential: { tier: 'essential', automatic: false, minNewChats: 15, cooldownHours: 72 },
  // The spec says "8 to 10"; 8 is the lower bound, chosen because the cost ceiling is
  // the cooldown rather than the threshold, and a higher bar only means a Pro tenant
  // with a quiet week cannot analyse at all.
  pro: { tier: 'pro', automatic: false, minNewChats: 8, cooldownHours: 24 },
  enterprise: { tier: 'enterprise', automatic: true, minNewChats: 0, cooldownHours: 0 },
};

export function insightsTierOf(features: PlanFeatures): InsightsTier {
  if (!features.gapInsights) return 'none';
  if (features.aiBusinessInsights) return 'enterprise';
  if (features.gapEvidence) return 'pro';
  return 'essential';
}

export function analysisPolicyFor(features: PlanFeatures): AnalysisPolicy {
  return POLICIES[insightsTierOf(features)];
}

export interface EligibilityInput {
  policy: AnalysisPolicy;
  /** Analysable conversations closed since the last analysis. */
  newChats: number;
  /** When a manual run last happened; null if never. */
  lastManualRunAt: Date | null;
  now: Date;
}

export type IneligibleReason = 'not_entitled' | 'automatic' | 'not_enough_chats' | 'cooling_down';

export interface Eligibility {
  eligible: boolean;
  reason: IneligibleReason | null;
  newChats: number;
  minNewChats: number;
  /** When the cooldown expires. Null when not cooling down. */
  nextAllowedAt: Date | null;
}

/**
 * Both limits are reported even when the first one already fails, so the portal can say
 * "12 of 15 conversations, and you could run again in 4 hours" instead of revealing one
 * obstacle at a time. Order of precedence is deliberate: entitlement, then whether a
 * button exists at all, then data, then time.
 */
export function checkEligibility(input: EligibilityInput): Eligibility {
  const { policy, newChats, lastManualRunAt, now } = input;

  const nextAllowedAt =
    lastManualRunAt && policy.cooldownHours > 0 && Number.isFinite(policy.cooldownHours)
      ? new Date(lastManualRunAt.getTime() + policy.cooldownHours * 3_600_000)
      : null;
  const coolingDown = nextAllowedAt != null && nextAllowedAt > now;

  const base = { newChats, minNewChats: policy.minNewChats, nextAllowedAt };

  if (policy.tier === 'none') return { ...base, eligible: false, reason: 'not_entitled' };
  // Enterprise has no button: analysis is already continuous, so a manual run would
  // only duplicate work that is about to happen anyway.
  if (policy.automatic) return { ...base, eligible: false, reason: 'automatic' };
  if (newChats < policy.minNewChats) return { ...base, eligible: false, reason: 'not_enough_chats' };
  if (coolingDown) return { ...base, eligible: false, reason: 'cooling_down' };

  return { ...base, eligible: true, reason: null };
}
