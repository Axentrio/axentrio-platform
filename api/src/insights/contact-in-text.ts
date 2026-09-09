/**
 * Guard for LLM-written insight text. The insight stores are presented as
 * aggregate, so a model that copies a customer's email or phone number out of a
 * transcript must not be saved. `isContactFragment` in `services/turn-timing.ts`
 * cannot help here: it only matches a whole short string that IS a contact value.
 */
const EMAIL_IN_TEXT = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
// Not `\b`: removing the separators joins the number to the following word, so
// a word boundary never appears after the last digit of "+32470123456 today".
const PHONE_IN_TEXT = /(?:\+|00)\d{6,15}(?!\d)/;

export function containsContactData(text: string): boolean {
  if (!text) return false;
  if (EMAIL_IN_TEXT.test(text)) return true;
  const digits = text.replace(/[\s().-]/g, '');
  return PHONE_IN_TEXT.test(digits);
}
