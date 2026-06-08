/**
 * Help FAQ — shared helpers used by both the public FAQ surface
 * (FaqContent, BotInstructionsHelpDrawer) and the super-admin editor.
 *
 * The Q&A content itself lives in the database; see useFaqQueries.ts.
 */

import type { FaqTranslation } from '@/queries/useFaqQueries';

/**
 * Section ids that have a code consumer and must keep existing.
 * The backend marks these `isReserved = true` and rejects deletion or moves
 * that would leave them empty.
 *
 * `ai-bot` — BotInstructionsHelpDrawer renders only this section
 */
const RESERVED_SECTION_IDS = ['ai-bot'] as const;
export type ReservedSectionId = (typeof RESERVED_SECTION_IDS)[number];

const SUPPORTED_LANGS = ['en', 'nl', 'fr'] as const;
type SupportedLang = (typeof SUPPORTED_LANGS)[number];

const isSupportedLang = (v: string): v is SupportedLang =>
  (SUPPORTED_LANGS as readonly string[]).includes(v);

/**
 * Pick a translation for the given i18next language tag. Handles tags like
 * `en-US` by stripping the region. Falls back to the `fallback` language
 * (default `en`) when the requested language is missing or empty — the
 * backend guarantees a non-empty `en`.
 */
export function pickTranslation(
  record: FaqTranslation | undefined,
  lang: string,
  fallback: SupportedLang = 'en'
): string {
  if (!record) return '';
  const base = lang.split('-')[0]?.toLowerCase() ?? '';
  if (isSupportedLang(base)) {
    const value = record[base];
    if (value && value.length > 0) return value;
  }
  return record[fallback] ?? '';
}
