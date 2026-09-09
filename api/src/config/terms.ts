/**
 * The version of the Terms a customer accepts.
 *
 * It must equal the `lastUpdated` on the published page
 * (`portal/src/pages/legal/Terms.tsx`). A test asserts it, because a version that
 * drifts from the page records consent to a document nobody was shown — which is
 * worse than no record at all.
 */
export const CURRENT_TERMS_VERSION = '2026-06-09';
