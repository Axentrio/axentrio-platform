/**
 * Service area — where a business is willing to work, and whether a given customer
 * address falls inside it.
 *
 * Shared by the API (which decides) and the portal (which lets the owner author it), so
 * the places the owner can pick and the places the matcher understands are the same set.
 *
 * IT FAILS OPEN, ALWAYS. Three outcomes, and only one of them blocks anything:
 *   inside  — the address resolved to a place the owner listed
 *   outside — the address resolved, and to none of them
 *   unknown — no area configured, no address, an address we cannot place, or an area
 *             entry we cannot reason about (a free-text "30 km around Aalst")
 * `unknown` behaves exactly as the product did before service areas existed. A parser miss
 * costs nothing; a wrong `outside` turns a paying customer away, so anything short of
 * confidence returns `unknown`.
 */
import {
  municipalityByNis,
  normalizeWords,
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

/**
 * Words that mean "and the area around it" in the languages this platform serves.
 *
 * A manual entry like "30 km rond Aalst" contains a place the parser can find, so without
 * this check it would quietly become the rule "Aalst, exactly" — NARROWER than the owner
 * asked for, and it would refuse the very customers they meant to include. We cannot model
 * a radius, so an entry that asks for one is treated as un-modelable and widens the whole
 * area to "cannot be sure" instead.
 */
const WIDENING_QUALIFIER =
  /(\b\d+\s*(km|kilometer|kilometre|kilometers|kilometres|mijl|mile|miles)\b|\b(rond|rondom|omgeving|omstreken|omtrek|regio|straal|buurt|radius|around|surrounding|surroundings|nearby|within|autour|alentours|environs|region|rayon|umkreis|umgebung)\b)/;

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
 * municipality in it. A manual entry is first run through the same address parser the
 * customer's address goes through — so an owner who typed "Sint-Niklaas" or pasted a full
 * street address still gets a working rule — and only counts as a real constraint if it
 * resolves. If any manual entry does NOT resolve, the configured area is wider than we can
 * model, so a non-match returns `unknown` rather than `outside`.
 */
export function matchServiceArea(
  address: string | null | undefined,
  entries: ServiceAreaEntry[] | null | undefined,
): ServiceAreaMatch {
  if (!entries?.length) return 'unknown';
  if (!address || !address.trim()) return 'unknown';

  const found = placesFromAddress(address);
  if (!found.via || !found.municipalities.length) return 'unknown';

  const provinceIds = new Set<string>();
  const municipalityIds = new Set<string>();
  let hasUnmodelableEntry = false;

  for (const entry of entries) {
    if (entry.kind === 'province') {
      if (provinceByCode(entry.id)) provinceIds.add(entry.id);
      else hasUnmodelableEntry = true;
      continue;
    }
    if (entry.kind === 'municipality') {
      if (municipalityByNis(entry.id)) municipalityIds.add(entry.id);
      else hasUnmodelableEntry = true;
      continue;
    }
    // Manual: readable only to the extent the parser recognises it. An entry asking for a
    // radius is deliberately NOT reduced to the town it names — see WIDENING_QUALIFIER.
    if (WIDENING_QUALIFIER.test(normalizeWords(entry.label).join(' '))) {
      hasUnmodelableEntry = true;
      continue;
    }
    const resolved = placesFromAddress(entry.label);
    if (resolved.via) for (const m of resolved.municipalities) municipalityIds.add(m.nis);
    else hasUnmodelableEntry = true;
  }

  const covers = (m: GeoMunicipality): boolean =>
    municipalityIds.has(m.nis) || provinceIds.has(m.prov);

  if (found.municipalities.some(covers)) return 'inside';

  // A postcode shared by several municipalities (1000, 1040, 1050, 1804) is ambiguous;
  // `some` above already treats any covered candidate as inside, which is the lenient
  // reading. Reaching here means none of the candidates is covered.
  return hasUnmodelableEntry ? 'unknown' : 'outside';
}
