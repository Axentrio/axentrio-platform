/**
 * Look a company up from its VAT number, so signup can fill in the boring fields and
 * refuse obvious fakes.
 *
 * SOURCE: the European Commission's VIES register. For Belgium it returns more than
 * validity — the registered name and address come back too, which is why this needs no
 * second provider. A number that is not VAT-registered, or belongs to a business that
 * has ceased, comes back `isValid: false`, which is the fake/closed check the product
 * asked for. Legal form is not a VIES field and is DERIVED from the registered name
 * (see vat-number.ts) — flagged as such rather than presented as a record.
 *
 * THE DEFINING CONSTRAINT IS LATENCY. Measured against the live service: 3.0s, 5.3s,
 * 6.8s, 8.3s for the same number. This is a government register, not a CDN. Everything
 * below follows from that:
 *
 *   - it is CACHED hard. A company's registered name and address change once in years,
 *     so a week-old answer is as good as a fresh one, and the cache is what keeps a
 *     signup form usable and keeps us off VIES's rate limits.
 *   - it TIMES OUT well before the user gives up, and a timeout is a normal outcome
 *     rather than an error.
 *   - it NEVER blocks. `unavailable` is a first-class result: the caller shows the
 *     fields empty and lets the customer type them, because losing a signup to someone
 *     else's downtime is a far worse outcome than an unverified company record.
 *
 * Fail-open on Redis too, matching the house pattern (copilot/limits): no cache just
 * means every lookup is slow, not that lookups stop.
 */
import axios from 'axios';
import type Redis from 'ioredis';
import { logger } from '../../utils/logger';
import { normalizeAccountVat, parseBelgianVat, splitLegalForm } from './vat-number';

export type LookupStatus = 'found' | 'not_found' | 'invalid_format' | 'unsupported' | 'unavailable';

export interface CompanyDetails {
  vatNumber: string;
  enterpriseNumber: string;
  name: string;
  /** Derived from the registered name, null when it carried no form. */
  legalForm: string | null;
  street: string | null;
  postalCode: string | null;
  city: string | null;
  countryCode: string;
}

export interface LookupResult {
  status: LookupStatus;
  company: CompanyDetails | null;
  /** True when the answer came from cache — surfaced so latency is explicable. */
  cached: boolean;
}

const VIES_BASE = 'https://ec.europa.eu/taxation_customs/vies/rest-api/ms';
const VIES_COUNTRY_CODES = new Set(
  'AT BE BG CY CZ DE DK EE EL ES FI FR HR HU IE IT LT LU LV MT NL PL PT RO SE SI SK'.split(' '),
);

/**
 * Past this the customer has decided the form is broken. Chosen from the measured
 * spread rather than a round number: the slowest observed call was 8.3s, so 10s admits
 * the slow tail while still failing before a person would.
 */
const TIMEOUT_MS = 10_000;

/** A week. The underlying facts change on the order of years. */
const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;

const cacheKey = (countryCode: string, nationalNumber: string) =>
  `company-lookup:${countryCode.toLowerCase()}:${nationalNumber}`;

/**
 * VIES returns `"Edingensesteenweg 196\n1500 Halle"` — street on the first line, then
 * postcode and city. Anything that does not fit that shape is returned as a street with
 * empty postcode/city rather than being force-fitted: a half-parsed address that looks
 * complete is worse than an obviously partial one the customer can correct.
 */
export function parseViesAddress(address: string | null | undefined): {
  street: string | null;
  postalCode: string | null;
  city: string | null;
} {
  const raw = (address ?? '').trim();
  if (!raw || raw === '---') return { street: null, postalCode: null, city: null };

  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  const street = lines[0] ?? null;
  const locality = lines[1] ?? '';
  const m = /^(\d{4})\s+(.+)$/.exec(locality); // Belgian postcodes are four digits
  return m
    ? { street, postalCode: m[1], city: m[2] }
    : { street, postalCode: null, city: locality || null };
}

interface ViesResponse {
  isValid?: boolean;
  name?: string;
  address?: string;
}

/** Either the validated VIES lookup key, or the terminal result to return as-is. */
type VatIdentity =
  | { ok: true; countryCode: string; nationalNumber: string; vatNumber: string }
  | { ok: false; result: LookupResult };

/**
 * Normalises the caller's VAT input into the `(countryCode, nationalNumber)`
 * pair VIES is queried with, or resolves to the terminal
 * `invalid_format`/`unsupported` answer.
 */
function resolveVatIdentity(rawVat: string): VatIdentity {
  const raw = String(rawVat).trim().toUpperCase();
  const prefix = /^([A-Z]{2})/.exec(raw)?.[1];

  if (prefix && prefix !== 'BE') {
    if (!VIES_COUNTRY_CODES.has(prefix)) {
      const compact = raw.replace(/[.\s-]/g, '');
      const plausibleVat = /^[A-Z]{2}[A-Z0-9]*\d[A-Z0-9]*$/.test(compact);
      return {
        ok: false,
        result: {
          status: plausibleVat ? 'unsupported' : 'invalid_format',
          company: null,
          cached: false,
        },
      };
    }

    const normalised = normalizeAccountVat(rawVat);
    if (!normalised.ok || !normalised.value.startsWith(prefix)) {
      return { ok: false, result: { status: 'invalid_format', company: null, cached: false } };
    }
    const nationalNumber = normalised.value.slice(2);
    if (!/^[A-Z0-9]{2,12}$/.test(nationalNumber)) {
      return { ok: false, result: { status: 'invalid_format', company: null, cached: false } };
    }
    return { ok: true, countryCode: prefix, nationalNumber, vatNumber: normalised.value };
  }

  const parsed = parseBelgianVat(rawVat);
  if (!parsed) {
    return { ok: false, result: { status: 'invalid_format', company: null, cached: false } };
  }
  return {
    ok: true,
    countryCode: 'BE',
    nationalNumber: parsed.enterpriseNumber,
    vatNumber: parsed.vatNumber,
  };
}

export async function lookupCompanyByVat(
  rawVat: string,
  deps: { redis?: Redis | null } = {},
): Promise<LookupResult> {
  const identity = resolveVatIdentity(rawVat);
  if (!identity.ok) return identity.result;
  const { countryCode, nationalNumber, vatNumber } = identity;

  const key = cacheKey(countryCode, nationalNumber);

  if (deps.redis) {
    try {
      const hit = await deps.redis.get(key);
      // Negative answers are cached too — a typo'd number would otherwise cost a
      // multi-second round trip on every keystroke-triggered retry.
      if (hit) return { ...(JSON.parse(hit) as Omit<LookupResult, 'cached'>), cached: true };
    } catch (err) {
      logger.warn('[company-lookup] cache read failed, falling through to VIES', {
        error: err instanceof Error ? err.message : 'unknown',
      });
    }
  }

  let body: ViesResponse;
  try {
    const res = await axios.get<ViesResponse>(
      `${VIES_BASE}/${countryCode}/vat/${nationalNumber}`,
      { timeout: TIMEOUT_MS, validateStatus: (s) => s === 200 },
    );
    body = res.data ?? {};
  } catch (err) {
    // Deliberately not rethrown. A register that is slow, rate-limiting or down must
    // never be able to stop someone signing up.
    logger.warn('[company-lookup] VIES unavailable', {
      vatNumber,
      error: err instanceof Error ? err.message : 'unknown',
    });
    return { status: 'unavailable', company: null, cached: false };
  }

  const result: Omit<LookupResult, 'cached'> = body.isValid
    ? (() => {
        if (countryCode !== 'BE') {
          const address = (body.address ?? '').trim();
          return {
            status: 'found' as const,
            company: {
              vatNumber,
              enterpriseNumber: nationalNumber,
              name: (body.name ?? '').trim(),
              legalForm: null,
              street: address && address !== '---' ? address : null,
              postalCode: null,
              city: null,
              countryCode,
            },
          };
        }

        const { name, legalForm } = splitLegalForm(body.name);
        const address = parseViesAddress(body.address);
        return {
          status: 'found' as const,
          company: {
            vatNumber,
            enterpriseNumber: nationalNumber,
            name,
            legalForm,
            ...address,
            countryCode,
          },
        };
      })()
    : { status: 'not_found' as const, company: null };

  if (deps.redis) {
    try {
      await deps.redis.set(key, JSON.stringify(result), 'EX', CACHE_TTL_SECONDS);
    } catch (err) {
      logger.warn('[company-lookup] cache write failed', {
        error: err instanceof Error ? err.message : 'unknown',
      });
    }
  }

  return { ...result, cached: false };
}
