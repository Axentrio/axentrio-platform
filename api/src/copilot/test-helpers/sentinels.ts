/**
 * Per-tenant sentinel strings for the Copilot tools' cross-tenant
 * regression tests (security invariant #10).
 *
 * Each tool's test seeds tenant A and tenant B side-by-side, calls
 * the tool as tenant A, then JSON-stringifies the response and
 * asserts ZERO of the `TENANT_B_VALUES` strings appear anywhere.
 *
 * Sentinels are crafted to be:
 *   - Unique to their tenant (no false positives against the corpus
 *     or the platform-wide vocabulary)
 *   - Recognisable in JSON output (no encoding ambiguity)
 *   - Long enough that a partial leak still trips the check
 */

export const TENANT_A_SENTINELS = {
  tenantName: 'tenant-a-axenAlphaSnTNamE-7K2',
  tenantSlug: 'tenant-a-slug-aZ9p4q',
  apiKey: 'sk_taenAaPiKy_alpha_61TKn8mn',
  webhookUrl: 'https://tenant-a.example.com/webhooks/taenAwbHkurL',
  webhookSecret: 'whsec_taenAhKsR_alpha_28ksRmnXp',
  customDomain: 'tenant-a-domAiNxN9.example.com',
  billingEmail: 'billing-tenant-a@taenAbiLngEm.test',
  stripeCustomerId: 'cus_TenantACustomerXa9k1n',
  stripeSubscriptionId: 'sub_TenantASubscriptionXa9k1n',
  botName: 'tenant-a-botNamEx_alpha',
  publicKey: 'pk_taenAbotPubLk_alpha_5kPLmH',
  brandVoiceName: 'tenant-a-brandVoIcEnM_alpha',
  brandVoiceTone: 'tenant-a-brandToNexN_alpha',
  brandVoiceInstructions: 'tenant-a-customInsTrUcTx_alpha_secretShouldNotLeak',
  greetingMessage: 'tenant-a-greeTinGmEs_alpha_x9Z2',
  fallbackMessage: 'tenant-a-falLbAcKmEs_alpha_p7K3',
  leadName: 'tenant-a-leadFulLnAme-alphaQq1',
  leadEmail: 'lead-tenant-a@tenant-a-leadDoMxN9.test',
  leadPhone: '+44-77-tenant-a-9928xx',
  leadNotes: 'tenant-a-leadNoTes_alpha_confidentialShouldNotLeak',
  channelLabel: 'tenant-a-channelLBxL_alpha',
  platformAccountId: 'fb_pageId_tenant-a_alphaB91',
  visitorId: 'visitor-tenant-a-alpha-7K2pN3',
} as const;

export const TENANT_B_SENTINELS = {
  tenantName: 'tenant-b-betaXxNTnAmE-9M4',
  tenantSlug: 'tenant-b-slug-bY7r3s',
  apiKey: 'sk_tbenBaPiKy_beta_82MNkPjL',
  webhookUrl: 'https://tenant-b.example.com/webhooks/tbenBwbHkurL',
  webhookSecret: 'whsec_tbenBhKsR_beta_47fRmZxY',
  customDomain: 'tenant-b-domAiNxN4.example.com',
  billingEmail: 'billing-tenant-b@tbenBbiLngEm.test',
  stripeCustomerId: 'cus_TenantBCustomerYb7m2p',
  stripeSubscriptionId: 'sub_TenantBSubscriptionYb7m2p',
  botName: 'tenant-b-botNamEx_beta',
  publicKey: 'pk_tbenBbotPubLk_beta_7kPLnH',
  brandVoiceName: 'tenant-b-brandVoIcEnM_beta',
  brandVoiceTone: 'tenant-b-brandToNexN_beta',
  brandVoiceInstructions: 'tenant-b-customInsTrUcTx_beta_secretShouldNotLeak',
  greetingMessage: 'tenant-b-greeTinGmEs_beta_y8W3',
  fallbackMessage: 'tenant-b-falLbAcKmEs_beta_q6L4',
  leadName: 'tenant-b-leadFulLnAme-betaRr2',
  leadEmail: 'lead-tenant-b@tenant-b-leadDoMxN4.test',
  leadPhone: '+44-77-tenant-b-8847yy',
  leadNotes: 'tenant-b-leadNoTes_beta_confidentialShouldNotLeak',
  channelLabel: 'tenant-b-channelLBxL_beta',
  platformAccountId: 'fb_pageId_tenant-b_betaC82',
  visitorId: 'visitor-tenant-b-beta-9M4qP3',
} as const;

/**
 * Every sentinel string for a tenant flattened into an array. Suitable
 * for `expect(JSON.stringify(toolResult)).not.toContain(...)` loops.
 */
export const TENANT_A_VALUES = Object.values(TENANT_A_SENTINELS) as readonly string[];
export const TENANT_B_VALUES = Object.values(TENANT_B_SENTINELS) as readonly string[];

/**
 * Convenience assertion: `obj` (typically a tool result) contains no
 * sentinel from the foreign tenant. Throws on first violation with the
 * offending sentinel name so the test failure points at exactly which
 * field leaked.
 */
export function assertNoForeignSentinels(
  obj: unknown,
  foreignSentinels: Readonly<Record<string, string>>,
): void {
  const serialized = JSON.stringify(obj);
  for (const [field, value] of Object.entries(foreignSentinels)) {
    if (serialized.includes(value)) {
      throw new Error(
        `Cross-tenant leak: foreign sentinel '${field}' = '${value}' appeared in tool response. ` +
          `Full response: ${serialized}`,
      );
    }
  }
}
