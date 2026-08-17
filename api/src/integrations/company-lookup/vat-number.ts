/**
 * Belgian enterprise / VAT number handling.
 *
 * The same ten digits are the company's enterprise number in the Crossroads Bank for
 * Enterprises (KBO/BCE) and, prefixed with `BE`, its VAT number — so one field answers
 * both. People type it every way imaginable: `BE 0400.378.485`, `be0400378485`,
 * `0400 378 485`. All of those are the same company and all of them must work, because
 * this is the first thing a new customer is asked for and a format quibble is a terrible
 * first impression.
 *
 * Dependency-free on purpose: the signup route, the lookup service and the portal
 * validator all need the same rules, and this must not drag a transport or a cache in
 * with it.
 */

export interface ParsedVat {
  /** Ten digits, no prefix or punctuation — the CBE enterprise number. */
  enterpriseNumber: string;
  /** The VIES/VAT form, e.g. `BE0400378485`. */
  vatNumber: string;
}

/**
 * A Belgian enterprise number is exactly ten digits and begins with 0 or 1. Numbers
 * beginning 0 are companies; 1 was opened when the 0-range began to run out. Anything
 * else is not one, and guessing costs a bad lookup rather than a helpful one.
 */
const BE_ENTERPRISE = /^[01]\d{9}$/;

export function parseBelgianVat(raw: string | null | undefined): ParsedVat | null {
  if (!raw) return null;

  const cleaned = String(raw)
    .toUpperCase()
    .replace(/^BE/, '')
    .replace(/[^0-9]/g, '');

  // A nine-digit number is the pre-2005 form; it is still written that way on old
  // paperwork and letterheads, and the modern number is the same digits with a leading
  // zero. Accepting it costs nothing and rejecting it would fail a real company.
  const normalised = cleaned.length === 9 ? `0${cleaned}` : cleaned;

  return BE_ENTERPRISE.test(normalised)
    ? { enterpriseNumber: normalised, vatNumber: `BE${normalised}` }
    : null;
}

/** Two-letter country prefix + 2–12 alphanumerics, e.g. `NL123456789B01`. */
const EU_VAT = /^[A-Z]{2}[A-Z0-9]{2,12}$/;
/** Permissive fallback; `tenants.vat_number` is varchar(16). */
const LOOSE_VAT = /^[A-Z0-9]{4,16}$/;

export type NormalisedVat =
  | { ok: true; value: string }
  | { ok: false; reason: 'too_long' | 'invalid' };

/**
 * Account-information VAT. Belgian numbers keep the existing canonical form
 * (`BE` + 10 digits). Other values are accepted when they look like an EU VAT
 * or a short alphanumeric identifier, and rejected (never truncated) past 16
 * characters so they fit the column.
 */
export function normalizeAccountVat(raw: string | null | undefined): NormalisedVat {
  if (raw == null) return { ok: false, reason: 'invalid' };

  const normalised = String(raw)
    .trim()
    .toUpperCase()
    .replace(/[.\s-]/g, '');

  if (!normalised) return { ok: false, reason: 'invalid' };
  if (normalised.length > 16) return { ok: false, reason: 'too_long' };

  // Bare digits or a BE prefix: keep the Belgian canonical form so existing
  // BE tenants write the same value they always have. Do NOT run this on a
  // foreign prefix — `parseBelgianVat('DE123456789')` would strip letters and
  // mis-read a German number as Belgian.
  if (/^(BE)?\d+$/.test(normalised)) {
    const parsed = parseBelgianVat(normalised);
    if (parsed) return { ok: true, value: parsed.vatNumber };
  }

  if (EU_VAT.test(normalised) || LOOSE_VAT.test(normalised)) {
    return { ok: true, value: normalised };
  }

  return { ok: false, reason: 'invalid' };
}

/** `0400378485` → `0400.378.485`, the form printed on Belgian invoices. */
export function formatEnterpriseNumber(enterpriseNumber: string): string {
  return `${enterpriseNumber.slice(0, 4)}.${enterpriseNumber.slice(4, 7)}.${enterpriseNumber.slice(7)}`;
}

/**
 * Belgian legal forms, as they appear at the START of the registered name that VIES
 * returns — "NV Colruyt Group", "SA BNP Paribas Fortis".
 *
 * Ordered longest-first so `BVBA` is matched before `BV` would swallow its prefix.
 * Both language versions of each form are listed because the register stores whichever
 * the company registered in, and a Brussels company answers in French while a Flemish
 * one answers in Dutch — from the same API, on the same day.
 */
const LEGAL_FORMS = [
  'BVBA', 'SPRL', 'CVBA', 'SCRL', 'COMM.V', 'COMM V', 'SCS', 'VZW', 'ASBL',
  'SCRI', 'CVOA', 'VOF', 'SNC', 'ESV', 'GIE', 'NV', 'SA', 'BV', 'SRL', 'CV', 'SC',
];

export interface NameAndForm {
  /** The trading name with the legal form removed. */
  name: string;
  /** The legal form if the register's name carried one, else null. */
  legalForm: string | null;
}

/**
 * Split "NV Colruyt Group" into its legal form and its name.
 *
 * DERIVED, NOT AUTHORITATIVE. VIES does not return a legal-form field, and this reads
 * a convention rather than a record: a company registered without the form in its name
 * yields null, which is correct — better an empty field the customer can fill than a
 * confident guess about their legal status. If this ever needs to be authoritative it
 * has to come from a CBE dataset, not from parsing.
 */
export function splitLegalForm(registeredName: string | null | undefined): NameAndForm {
  const value = (registeredName ?? '').trim();
  if (!value) return { name: '', legalForm: null };

  const upper = value.toUpperCase();
  for (const form of LEGAL_FORMS) {
    // Only at the start, and only followed by a separator — otherwise "SA" would match
    // the first two letters of "SANITAIR JANSSENS".
    if (upper.startsWith(`${form} `) || upper.startsWith(`${form}. `)) {
      const rest = value.slice(value.toUpperCase().indexOf(form) + form.length).replace(/^[.\s]+/, '');
      return { name: rest.trim(), legalForm: form };
    }
  }
  return { name: value, legalForm: null };
}
