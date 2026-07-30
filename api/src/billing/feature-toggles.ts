/**
 * Tenant self-service feature toggles — the allowlist of feature keys a
 * tenant's own admin may switch on/off (within their entitlement ceiling).
 *
 * Plan: .scratch/plan-tenant-feature-toggles.md § 2.
 *
 * Only these keys are tenant-toggleable. Dependent children (`crm`,
 * `calendarSync`, `gapEvidence`, `aiBusinessInsights`) are NOT listed — they
 * follow their parent through `enforceFeatureDependencies`. Plan-traits
 * (hideWidgetAttribution, customWidgetAppearance, fileUpload) are billing
 * positioning, never tenant-toggleable.
 *
 * The `satisfies` clause ties this runtime list to the `ToggleableFeatureKey`
 * wire type — adding a non-existent or non-toggleable key fails tsc.
 */
import type { ToggleableFeatureKey } from '../contracts/entitlements';

export type { ToggleableFeatureKey };

export const TENANT_TOGGLEABLE_FEATURES = [
  'channelWhatsapp',
  'channelMessenger',
  'channelInstagram',
  'channelTelegram',
  'leadCapture',
  // DELIBERATE EXCEPTION to the "no `requires:` children" rule above.
  // `proactiveLeadCapture` has `requires: 'leadCapture'`, so it still follows its
  // parent off — but it is listed here because it must be tenant-switchable in its
  // own right. It changes WHAT personal data the bot asks EU consumers for, which
  // is the controller's decision to make, not something that should flip silently
  // as a side-effect of a plan change. Ships default OFF at every tier.
  'proactiveLeadCapture',
  'bookings',
  'gapInsights',
] as const satisfies readonly ToggleableFeatureKey[];

const TOGGLEABLE_SET: ReadonlySet<string> = new Set(TENANT_TOGGLEABLE_FEATURES);

/**
 * Toggles that are OPT-IN: an absent preference means OFF, not on.
 *
 * The default for every other toggleable feature is "on when entitled" (absent key
 * = on), which is right for capabilities the tenant bought. It is wrong for anything
 * that changes what the bot says to a consumer without the tenant having asked:
 * `proactiveLeadCapture` makes the bot solicit a phone number or address, so being
 * entitled to it must not be the same as having switched it on. Enabling it is an
 * explicit, audited act.
 */
export const OPT_IN_FEATURES = ['proactiveLeadCapture'] as const satisfies readonly ToggleableFeatureKey[];

const OPT_IN_SET: ReadonlySet<string> = new Set(OPT_IN_FEATURES);

/** Type guard: is `key` a tenant-toggleable feature? */
export function isToggleableFeature(key: string): key is ToggleableFeatureKey {
  return TOGGLEABLE_SET.has(key);
}

/** Does this feature require an explicit `true` from the tenant to be active? */
export function isOptInFeature(key: string): boolean {
  return OPT_IN_SET.has(key);
}
