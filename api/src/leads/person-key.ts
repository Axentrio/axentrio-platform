/**
 * Person key — the identity rule for "these two lead rows are the same human".
 *
 * `chatbot_leads` is identity-POLYMORPHIC: one row per durable contact, keyed on
 * `dedupe_key` with precedence channel-identity → email → phone. That is correct for
 * the write path (an upsert has to land on exactly one row) but it means the same
 * person messaging on WhatsApp and later typing their number into the widget owns TWO
 * rows — `whatsapp:32475…` and `phone:32475…`. No per-row counter can express "this
 * person came back", because the second visit creates a row instead of touching one.
 *
 * The person key is the grouping key that spans those rows. It is DERIVED, never
 * authored, and deliberately narrow:
 *
 * **Only an exact match on a normalised identifier merges.** Phone normalised to
 * E.164, or email lowercased and trimmed. Names are NEVER compared, not even exactly:
 * "Jan Peeters" is not a person, it is a string thousands of people share. Wrongly
 * merging two customers shows one person another person's history — an unrecoverable
 * data-protection incident — while a missed repeat costs a badge that does not appear.
 * Every judgement call below is resolved towards the missed repeat.
 *
 * Three specific things this module refuses to do, each because it would merge people
 * who are not the same:
 *
 *  1. **No transitive chaining.** A row is keyed on ONE identifier, chosen by
 *     precedence — never on "shares a phone with X, which shares an email with Y".
 *     One shared household or reception number would otherwise pull two unrelated
 *     customers, and then their emails, into a single person.
 *  2. **No provider-specific folding.** `a+work@x.com` and `a+home@x.com` stay
 *     distinct. Plus-address stripping is famous as a gmail trick and would silently
 *     merge `shared+alice@company.com` with `shared+bob@company.com`.
 *  3. **No country guessing.** A national-format number (`0475 12 34 56`) is not
 *     E.164 and cannot be made into one without knowing the country. Inferring it
 *     from the tenant's locale would merge a Belgian `0475123456` with a French one.
 *     Such a number yields no phone key at all — the contact simply never groups on
 *     phone. This is the single biggest source of missed repeats and it is the
 *     intended trade.
 *
 *     LIMIT, stated precisely because an earlier version of this comment overstated
 *     it: the column stores digits only, so a number typed in a national format with
 *     no trunk prefix (`4155550100`) is not distinguishable BY SHAPE from an
 *     international one. Library validation rejects such numbers when they are invalid
 *     under the country their leading digits imply — which covers the NANP cases —
 *     but a national number that is also valid under some other country code would
 *     still key wrongly. That residue cannot be removed without knowing the origin
 *     country, which the stored value no longer carries.
 *
 * Dependency-free on purpose, like `lead-tombstone.ts`: the capture path, the read
 * path and the nightly sweep all need it, and a new static import edge in this
 * codebase has previously broken unrelated unit suites through vi.mock hoisting and
 * module load order.
 */

import { isValidPhoneNumber } from 'libphonenumber-js';

/**
 * Shape gate before the library: a country code never starts with 0, and E.164 caps
 * the whole number at 15 digits. Cheap rejection of obvious non-numbers.
 */
const E164_DIGITS = /^[1-9]\d{7,14}$/;

/**
 * Identifiers that are placeholders rather than people. `chatbot_leads` is fed by CSV
 * import and manual entry as well as the bot, and filler values are what operators
 * type into a required field. Without this, every contact carrying the same filler
 * merges into one "person": three imported rows sharing `unknown@example.com` became
 * a single customer with three conversations.
 *
 * Phone fillers are mostly caught by validation (1111111111 is not a valid number in
 * any country), so this list is deliberately short and email-shaped.
 */
const PLACEHOLDER_LOCAL_PARTS = new Set([
  'unknown', 'none', 'na', 'n/a', 'nobody', 'noreply', 'no-reply', 'test', 'email',
  'placeholder', 'anonymous', 'customer', 'client', 'x',
]);

/**
 * Normalise a stored phone to E.164, or `null` when it cannot be established.
 *
 * `chatbot_leads.phone` is already digits-only (`normalizePhone` in
 * lead-capture.service strips `+`, spaces and dashes before the insert), so a number
 * that arrived as `+32 475 12 34 56` is stored as `32475123456` and a WhatsApp `wa_id`
 * is stored the same way. Both land on `+32475123456` here, which is exactly the
 * collision the person key exists to catch. A leading `00` is the other international
 * spelling and is dropped to the same form.
 *
 * Returning `null` rather than a best guess is the whole point: an unusable number
 * costs a missed repeat, an invented country code costs a wrong merge.
 */
export function normalizePersonPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let digits = String(raw).trim();
  // Keep only digits and a leading international marker, then reduce to digits.
  digits = digits.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  else if (digits.startsWith('00')) digits = digits.slice(2);
  digits = digits.replace(/\D/g, '');
  if (!E164_DIGITS.test(digits)) return null;
  // The shape gate alone is not enough, and the gap is not academic. Because the column
  // is digits-only, a NANP number typed nationally (`4155550100`) is indistinguishable
  // BY SHAPE from an international one, and prefixing it with `+` silently reinterprets
  // it as another country: +41 is Switzerland, +212 is Morocco, +33 is France. Real
  // validation rejects every one of those as not-a-number in the country its prefix
  // claims, while accepting genuine BE/NL/FR numbers.
  //
  // It does NOT make the ambiguity disappear — a national number that happens to be
  // valid under some other country code would still key wrongly. Nothing can fix that
  // without knowing the country the digits came from, which the stored value no longer
  // carries. It shrinks the window to numbers that are valid in two places at once.
  if (!isValidPhoneNumber(`+${digits}`)) return null;
  return `+${digits}`;
}

/**
 * Normalise an email to its comparison form: trimmed and lowercased, nothing else.
 *
 * Validated to the same shape the CSV importer enforces, then screened for filler
 * local-parts. An `@`-contains check was too weak for a value used as an identity: it
 * is the merge direction that costs, and a placeholder address is exactly the value
 * many unrelated rows share.
 */
const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function normalizePersonEmail(raw: string | null | undefined): string | null {
  const email = (raw ?? '').trim().toLowerCase();
  if (!email || !EMAIL_SHAPE.test(email)) return null;
  const local = email.slice(0, email.indexOf('@'));
  if (PLACEHOLDER_LOCAL_PARTS.has(local)) return null;
  return email;
}

/**
 * The person key for a lead row, or `null` when neither identifier is usable.
 *
 * PHONE WINS when both are present, and that ordering is load-bearing rather than
 * arbitrary: every external channel identifies a customer by phone (a WhatsApp
 * `wa_id` IS a phone number) and never by email, so phone is the only identifier
 * that can bridge a channel row to a widget row — which is the repeat this platform
 * actually misses. Keying a phone+email row on its email instead would leave it
 * unable to group with the WhatsApp row belonging to the same person.
 *
 * The namespace prefix keeps the two spaces apart so a pathological value can never
 * make an email collide with a phone.
 */
export function computePersonKey(input: {
  phone?: string | null;
  email?: string | null;
}): string | null {
  const phone = normalizePersonPhone(input.phone);
  if (phone) return `phone:${phone}`;
  const email = normalizePersonEmail(input.email);
  if (email) return `email:${email}`;
  return null;
}
