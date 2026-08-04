/**
 * Service area — where a business is willing to work, and whether a given customer
 * address falls inside it.
 *
 * Shared by the API (which decides) and the portal (which lets the owner author it), so
 * the places the owner can pick and the places the matcher understands are the same set.
 *
 * THREE OUTCOMES:
 *   inside  — the address resolved to a place the owner picked from the list
 *   outside — the address resolved, and to none of them
 *   unknown — no listed place to compare against, or an address we cannot place
 *
 * ONLY PICKED PLACES ARE RULES. A `manual` entry is whatever the owner typed, and it is
 * shown to the assistant but never used to judge anyone. Reading them was worse than
 * useless in both directions: "30 km rond Aalst" contains a town, so resolving it produced
 * the rule "Aalst, exactly" — NARROWER than asked, refusing the neighbours the owner
 * explicitly said yes to — while an entry nobody could parse switched enforcement off for
 * every other chip beside it. A regex over free text cannot arbitrate that, so it does not
 * try. Per-entry and predictable beats clever.
 *
 * WHICH WAY IT FAILS. `unknown` never blocks here — it means "this function has nothing to
 * say". Deciding what to do with that belongs to the caller, and the caller is NOT
 * symmetric about it: for a service that requires an address (so travel is implied) with an
 * area configured, the booking provider captures a request rather than auto-confirming. A
 * false `outside` costs the owner one glance at a request they can accept; a false `inside`
 * costs them a confirmed calendar event, an invite the customer is holding, and a drive.
 */
import {
  municipalityByNis,
  placesFromAddress,
  provinceByCode,
  type GeoMunicipality,
} from './belgium-geo';

/**
 * One place a business serves. `province` and `municipality` carry the id the matcher
 * reasons about; `manual` is whatever the owner typed and is matched only as far as its
 * text can be resolved.
 *
 * `label` is stored alongside the id — denormalised on purpose, so refreshing the geo
 * table can never blank a chip the owner already saved, and so the prompt needs no lookup.
 */
export type ServiceAreaEntry =
  | { kind: 'province'; id: string; label: string }
  | { kind: 'municipality'; id: string; label: string }
  | { kind: 'manual'; label: string };

/** Enough for "a few provinces and their neighbouring towns" without unbounded jsonb. */
export const MAX_SERVICE_AREA_ENTRIES = 40;

/** True when the owner picked this place from the list, i.e. it is a rule the matcher can apply. */
export const isEnforceableEntry = (e: ServiceAreaEntry): boolean => e.kind !== 'manual';

export type ServiceAreaMatch = 'inside' | 'outside' | 'unknown';

/** The area as a human list, for the prompt and for owner-facing copy. Empty → ''. */
export function describeServiceArea(entries: ServiceAreaEntry[]): string {
  return entries
    .map((e) => e.label.trim())
    .filter(Boolean)
    .join(', ');
}

/**
 * Does `address` fall inside `entries`?
 *
 * A municipality entry matches that municipality; a province entry matches every
 * municipality in it. `manual` entries are ignored entirely — see the file header.
 *
 * With no enforceable entry there is nothing to compare against, so the answer is `unknown`
 * however much free text the owner typed. An id the geo table no longer knows is skipped
 * rather than treated as a boundary.
 */
export function matchServiceArea(
  address: string | null | undefined,
  entries: ServiceAreaEntry[] | null | undefined,
): ServiceAreaMatch {
  if (!entries?.length) return 'unknown';

  const provinceIds = new Set<string>();
  const municipalityIds = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === 'province' && provinceByCode(entry.id)) provinceIds.add(entry.id);
    else if (entry.kind === 'municipality' && municipalityByNis(entry.id)) municipalityIds.add(entry.id);
  }
  if (!provinceIds.size && !municipalityIds.size) return 'unknown';

  if (!address || !address.trim()) return 'unknown';
  const found = placesFromAddress(address);
  if (!found.via || !found.municipalities.length) return 'unknown';

  const covers = (m: GeoMunicipality): boolean =>
    municipalityIds.has(m.nis) || provinceIds.has(m.prov);

  // A postcode shared by several municipalities (1000, 1040, 1050, 1348) stays ambiguous
  // even after the cross-check, so ANY covered candidate counts as inside — the lenient
  // reading, consistent with preferring a false `inside` over turning someone away.
  return found.municipalities.some(covers) ? 'inside' : 'outside';
}
