/**
 * Belgian places — the shared table behind service areas.
 *
 * Imported by the API (to decide whether a customer address falls inside a business's
 * service area) and by the portal (to suggest places as the owner types). One table, so
 * a place the owner can pick is by construction a place the matcher can recognise.
 *
 * Regenerate with `node api/scripts/build-belgium-geo.cjs` — that script documents where
 * the data comes from and why it is committed rather than fetched.
 *
 * MATCHING IS WHOLE-WORD, NOT SUBSTRING. Addresses are free text, so "Sint-Niklaas" is
 * found by walking the address's word sequence rather than by `includes()` — otherwise
 * every street containing a town's name would register as that town. Names shorter than
 * four characters (As, Ham, Mol, Lot) are excluded from name matching for the same reason;
 * their postcodes still match, and a miss degrades to "unknown", never to a wrong answer.
 */
import data from './belgium-geo.data.json';

export interface GeoProvince {
  /** NIS province code, or 'BRU' for the Brussels-Capital Region (which has no province). */
  code: string;
  reg: 'VLG' | 'WAL' | 'BRU';
  nl: string | null;
  fr: string | null;
  de: string | null;
}

export interface GeoMunicipality {
  /** NIS municipality code. */
  nis: string;
  /** Province code, or 'BRU'. */
  prov: string;
  reg: 'VLG' | 'WAL' | 'BRU';
  nl: string | null;
  fr: string | null;
  de: string | null;
  /** Postal codes covered by this municipality. */
  pc: string[];
  /** Sub-municipality names — matching aliases only, never displayed. */
  alias: string[];
}

export const PROVINCES: GeoProvince[] = data.provinces as GeoProvince[];
export const MUNICIPALITIES: GeoMunicipality[] = data.municipalities as GeoMunicipality[];
export const GEO_SOURCE: string = data.source;

/** Lowercase, strip diacritics, reduce to words. "Liège" → ["liege"]. */
export function normalizeWords(value: string): string[] {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const norm = (value: string): string => normalizeWords(value).join(' ');

/**
 * Display name for a municipality. Flanders reads Dutch, Wallonia French; Brussels is
 * officially bilingual, so both are shown when they differ (Sint-Gillis / Saint-Gilles).
 */
export function municipalityLabel(m: GeoMunicipality): string {
  if (m.reg === 'BRU') {
    if (m.nl && m.fr && m.nl !== m.fr) return `${m.nl} / ${m.fr}`;
    return m.nl || m.fr || m.de || m.nis;
  }
  if (m.reg === 'WAL') return m.fr || m.nl || m.de || m.nis;
  return m.nl || m.fr || m.de || m.nis;
}

export function provinceLabel(p: GeoProvince): string {
  if (p.reg === 'BRU') return p.nl && p.fr ? `${p.nl} / ${p.fr}` : p.nl || p.fr || p.code;
  if (p.reg === 'WAL') return p.fr || p.nl || p.de || p.code;
  return p.nl || p.fr || p.de || p.code;
}

const provinceByCodeIndex = new Map(PROVINCES.map((p) => [p.code, p]));
const municipalityByNisIndex = new Map(MUNICIPALITIES.map((m) => [m.nis, m]));

/** postcode → municipalities. Four span more than one: 1000 (three — Brussel, Elsene,
 *  Sint-Joost-ten-Node), 1040, 1050 and 1348. */
const byPostcode = new Map<string, GeoMunicipality[]>();
for (const m of MUNICIPALITIES) {
  for (const pc of m.pc) {
    const list = byPostcode.get(pc);
    if (list) list.push(m);
    else byPostcode.set(pc, [m]);
  }
}

/** normalized name (and alias) → municipalities, for whole-word address matching. */
const byName = new Map<string, GeoMunicipality[]>();
/** Longest name in words, so the matcher knows how wide an n-gram to consider. */
let maxNameWords = 1;
for (const m of MUNICIPALITIES) {
  for (const raw of [m.nl, m.fr, m.de, ...m.alias]) {
    if (!raw) continue;
    const key = norm(raw);
    // Sub-four-character names are too collision-prone to match by name; postcode still works.
    if (key.replace(/ /g, '').length < 4) continue;
    maxNameWords = Math.max(maxNameWords, key.split(' ').length);
    const list = byName.get(key);
    if (list) {
      if (!list.includes(m)) list.push(m);
    } else byName.set(key, [m]);
  }
}

export const provinceByCode = (code: string): GeoProvince | undefined => provinceByCodeIndex.get(code);
export const municipalityByNis = (nis: string): GeoMunicipality | undefined => municipalityByNisIndex.get(nis);
export const municipalitiesByPostcode = (pc: string): GeoMunicipality[] => byPostcode.get(pc) ?? [];

/** Every municipality in a province (or the Brussels region). */
export function municipalitiesInProvince(code: string): GeoMunicipality[] {
  return MUNICIPALITIES.filter((m) => m.prov === code);
}

// ── Typeahead ────────────────────────────────────────────────────────────────

export interface PlaceSuggestion {
  kind: 'province' | 'municipality';
  /** Province code or municipality NIS — what a selected entry stores. */
  id: string;
  label: string;
  /** The line under the label: the province for a municipality, the country for a province. */
  context: string;
}

/**
 * Suggestions for the owner's service-area field, best match first. Matches any language
 * variant, any sub-municipality alias, and postal codes. Provinces outrank municipalities
 * at equal relevance because they are the broader, more commonly intended choice.
 */
export function searchPlaces(query: string, limit = 8): PlaceSuggestion[] {
  const q = norm(query);
  if (!q) return [];

  const scored: Array<{ s: PlaceSuggestion; rank: number }> = [];

  for (const p of PROVINCES) {
    const names = [p.nl, p.fr, p.de].filter(Boolean) as string[];
    const rank = bestRank(names.map(norm), q);
    if (rank !== null) {
      scored.push({ s: { kind: 'province', id: p.code, label: provinceLabel(p), context: 'België' }, rank });
    }
  }

  for (const m of MUNICIPALITIES) {
    const names = [m.nl, m.fr, m.de, ...m.alias].filter(Boolean) as string[];
    let rank = bestRank(names.map(norm), q);
    // A bare postcode should find its municipality: "9310" → Aalst.
    if (rank === null && /^\d{1,4}$/.test(q) && m.pc.some((pc) => pc.startsWith(q))) rank = 1;
    if (rank !== null) {
      const prov = provinceByCodeIndex.get(m.prov);
      scored.push({
        s: {
          kind: 'municipality',
          id: m.nis,
          label: municipalityLabel(m),
          context: prov ? `${provinceLabel(prov)}, België` : 'België',
        },
        // +0.5 keeps a province ahead of a municipality that matched equally well.
        rank: rank + 0.5,
      });
    }
  }

  return scored
    .sort((a, b) => a.rank - b.rank || a.s.label.localeCompare(b.s.label))
    .slice(0, limit)
    .map((x) => x.s);
}

/** 0 = exact, 1 = starts with, 2 = contains a word starting with the query, null = no match. */
function bestRank(names: string[], q: string): number | null {
  let best: number | null = null;
  for (const n of names) {
    let r: number | null = null;
    if (n === q) r = 0;
    else if (n.startsWith(q)) r = 1;
    else if (n.split(' ').some((w) => w.startsWith(q))) r = 2;
    if (r !== null && (best === null || r < best)) best = r;
  }
  return best;
}

// ── Address → place ──────────────────────────────────────────────────────────

export interface AddressPlaces {
  /** Municipalities the address resolves to, most confident first. */
  municipalities: GeoMunicipality[];
  /** How the match was made — postcodes are far more reliable than names. */
  via: 'postcode' | 'name' | null;
}

/**
 * Countries whose addresses must never be read as Belgian ones.
 *
 * The Netherlands, France and Germany all use four-digit or four-digit-prefixed postcodes in
 * the same 1000–9999 band, so "1012 Amsterdam" reads as Brussels and "Lille, France" as the
 * Antwerp-province municipality of Lille. Cross-border customers are exactly who a service
 * area exists to exclude, so naming a foreign country makes the address unplaceable rather
 * than confidently wrong. Belgium's own names are listed so they are never mistaken for one.
 */
const BELGIUM_NAMES = new Set(['belgie', 'belgium', 'belgique', 'belgien']);
const FOREIGN_COUNTRY = new Set([
  'nederland', 'netherlands', 'holland', 'nl',
  'france', 'frankrijk', 'frankreich', 'fr',
  'deutschland', 'germany', 'duitsland', 'allemagne',
  'luxembourg', 'luxemburg', 'letzebuerg',
  'uk', 'england', 'scotland', 'wales', 'ireland', 'ierland',
  'spain', 'spanje', 'espagne', 'italy', 'italie', 'italia',
  'portugal', 'poland', 'polen', 'pologne', 'switzerland', 'zwitserland', 'suisse',
  'austria', 'oostenrijk', 'autriche', 'denmark', 'denemarken',
]);

/**
 * Resolve a free-text address to Belgian municipalities.
 *
 * Both signals are read and then CROSS-CHECKED, because neither is trustworthy alone:
 *
 *  - A four-digit token is usually the postcode, but "Chaussée de Waterloo 1200" is a house
 *    number that happens to be a valid postcode (Woluwe) — trusting it blind produced a
 *    confident, WRONG answer for an Uccle address.
 *  - A town name can appear inside a street name: "Chaussée de Bruxelles, Waterloo" names
 *    two municipalities and only one of them is where the customer lives.
 *
 * So: when the two signals disagree, or when the name signal alone points at more than one
 * municipality, the address is AMBIGUOUS and resolves to `via: null`. Callers must treat
 * that as "unknown" — never as "outside". Saying nothing beats saying the wrong thing.
 */
export function placesFromAddress(address: string): AddressPlaces {
  const words = normalizeWords(address);
  if (words.some((w) => FOREIGN_COUNTRY.has(w) && !BELGIUM_NAMES.has(w))) {
    return { municipalities: [], via: null };
  }

  const byPc: GeoMunicipality[] = [];
  for (const w of words) {
    // Belgian postal codes run 1000–9992; a bare 4-digit token is the strongest signal.
    if (!/^\d{4}$/.test(w)) continue;
    for (const m of municipalitiesByPostcode(w)) if (!byPc.includes(m)) byPc.push(m);
  }

  const byNameHits: GeoMunicipality[] = [];
  for (let size = Math.min(maxNameWords, words.length); size >= 1; size--) {
    for (let i = 0; i + size <= words.length; i++) {
      const hits = byName.get(words.slice(i, i + size).join(' '));
      if (!hits) continue;
      for (const m of hits) if (!byNameHits.includes(m)) byNameHits.push(m);
    }
    // Longest match wins: once "sint niklaas" matched, don't also read a stray "niklaas".
    if (byNameHits.length) break;
  }

  if (byPc.length && byNameHits.length) {
    // Agreement narrows the answer (a shared postcode like 1000 is resolved by the town
    // name); disagreement means one of the two is a house number or a street name.
    const agreed = byPc.filter((m) => byNameHits.includes(m));
    return agreed.length ? { municipalities: agreed, via: 'postcode' } : { municipalities: [], via: null };
  }
  if (byPc.length) return { municipalities: byPc, via: 'postcode' };
  // A lone name signal pointing at several different municipalities is a street name
  // colliding with a town, not a location.
  if (byNameHits.length === 1) return { municipalities: byNameHits, via: 'name' };

  return { municipalities: [], via: null };
}
