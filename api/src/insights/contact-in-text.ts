/**
 * Guard for LLM-written insight text. The insight stores are presented as
 * aggregate, so a model that copies a customer's email or phone number out of a
 * transcript must not be saved. `isContactFragment` in `services/turn-timing.ts`
 * cannot help here: it only matches a whole short string that IS a contact value.
 */
const EMAIL_IN_TEXT = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
// Two written forms, both matched after the separators are removed:
//   international, "+32 470 12 34 56" or "0032 470 12 34 56";
//   domestic, "0470 12 34 56" or "0470/12.34.56" — the trunk "0" of the
//   shipped en / fr / nl markets. A domestic number carries 9 or 10 digits, so
//   the run needs 8 digits after the trunk "0" and a date such as "09/09/2026"
//   stays clean. The lookbehind keeps the run off a longer figure, so
//   "2026-09-09" and "1 000 000 000" stay clean too.
// Not `\b`: removing the separators joins the number to the following word, so
// a word boundary never appears after the last digit of "+32470123456 today".
const PHONE_IN_TEXT = /(?<![\d+])(?:\+\d{6,15}|0\d{8,14})(?!\d)/;

export function containsContactData(text: string): boolean {
  if (!text) return false;
  if (EMAIL_IN_TEXT.test(text)) return true;
  const digits = text.replace(/[\s()./-]/g, '');
  return PHONE_IN_TEXT.test(digits);
}

/**
 * How many contact values a block of text contains.
 *
 * Used at knowledge ingestion, where the answer is a warning rather than a block:
 * the tenant owns their knowledge base, and we cannot decide for them what belongs
 * in it — but a document full of customer emails is worth telling them about.
 * Counts only; the values themselves never leave this function.
 */
export function countContactMatches(text: string): { emails: number; phones: number } {
  if (!text) return { emails: 0, phones: 0 };
  const emails = text.match(new RegExp(EMAIL_IN_TEXT.source, 'gi'))?.length ?? 0;
  const digits = text.replace(/[\s()./-]/g, '');
  const phones = digits.match(new RegExp(PHONE_IN_TEXT.source, 'g'))?.length ?? 0;
  return { emails, phones };
}
