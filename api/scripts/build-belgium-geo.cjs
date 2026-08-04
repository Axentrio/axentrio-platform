#!/usr/bin/env node
/**
 * Regenerates `api/src/contracts/belgium-geo.data.json` — the postcode → municipality →
 * province table behind service areas.
 *
 * WHY A DERIVED FILE AND NOT A RUNTIME FETCH. The table is what decides whether a customer
 * is inside a business's service area, so it has to answer in microseconds on every booking
 * and it has to answer the same way in a test, in CI and in prod. A weekly-refreshed remote
 * dataset is neither. It is also small enough (~80 KB) that shipping it beats operating it.
 *
 * WHY NOT BeST. The BOSA "BeSt Full" address register (best-full-latest.zip) is 306 MB of
 * weekly XML covering every house number in Belgium. Service areas are expressed in
 * provinces and municipalities, so all of that resolution buys nothing — and a street-level
 * entry the owner really wants is accepted as free text instead.
 *
 * Source: georef-belgium-postal-codes (bpost/BOSA via Opendatasoft), CC-BY 4.0.
 * Run: node api/scripts/build-belgium-geo.cjs
 */
const fs = require('fs');
const path = require('path');

const SOURCE =
  'https://public.opendatasoft.com/api/explore/v2.1/catalog/datasets/' +
  'georef-belgium-postal-codes/exports/json?lang=en&timezone=UTC';

const OUT = path.join(__dirname, '..', 'src', 'contracts', 'belgium-geo.data.json');

/** Brussels-Capital has no province, but an owner still needs to select it as an area. */
const BRUSSELS = {
  code: 'BRU',
  reg: 'BRU',
  nl: 'Brussels Hoofdstedelijk Gewest',
  fr: 'Région de Bruxelles-Capitale',
  de: 'Region Brüssel-Hauptstadt',
};

/** Flemish/Walloon/Brussels, from the source's region name — decides display language. */
const regionOf = (regNameNl) =>
  regNameNl === 'Vlaams Gewest' ? 'VLG' : regNameNl === 'Waals Gewest' ? 'WAL' : 'BRU';

/** "Provincie Oost-Vlaanderen" / "Province de Flandre orientale" → the bare name. */
function stripProvincePrefix(name) {
  if (!name) return null;
  return name
    .replace(/^Provincie\s+/i, '')
    .replace(/^Province\s+(de\s+la\s+|de\s+l['’]|du\s+|des\s+|de\s+|d['’])?/i, '')
    .replace(/^Provinz\s+/i, '')
    .trim();
}

async function main() {
  process.stdout.write('fetching source…\n');
  const res = await fetch(SOURCE);
  if (!res.ok) throw new Error(`source returned ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows) || !rows.length) throw new Error('source returned no rows');
  process.stdout.write(`  ${rows.length} rows\n`);

  const provinces = new Map();
  const municipalities = new Map();

  for (const r of rows) {
    if (!r.postcode || !r.mun_code) continue;

    // Brussels rows carry no province; they get the region as their selectable area.
    const provCode = r.prov_code || BRUSSELS.code;
    if (!provinces.has(provCode)) {
      provinces.set(
        provCode,
        provCode === BRUSSELS.code
          ? { ...BRUSSELS }
          : {
              code: provCode,
              reg: regionOf(r.reg_name_nl),
              nl: stripProvincePrefix(r.prov_name_nl),
              fr: stripProvincePrefix(r.prov_name_fr),
              de: stripProvincePrefix(r.prov_name_de),
            },
      );
    }

    let m = municipalities.get(r.mun_code);
    if (!m) {
      m = {
        nis: r.mun_code,
        prov: provCode,
        reg: regionOf(r.reg_name_nl),
        nl: r.mun_name_nl || null,
        fr: r.mun_name_fr || null,
        de: r.mun_name_de || null,
        pc: [],
        alias: [],
      };
      municipalities.set(r.mun_code, m);
    }
    if (!m.pc.includes(r.postcode)) m.pc.push(r.postcode);

    // Sub-municipality names (deelgemeenten) are matching-only aliases: "Angleur" should
    // resolve to Liège. Coverage is partial in this source — one sub-municipality per
    // postcode row — so they improve name matching without being relied upon.
    for (const a of [r.smun_name_nl, r.smun_name_fr, r.smun_name_de]) {
      if (!a) continue;
      if (a === m.nl || a === m.fr || a === m.de) continue;
      if (!m.alias.includes(a)) m.alias.push(a);
    }
  }

  for (const m of municipalities.values()) {
    m.pc.sort();
    m.alias.sort();
  }

  const out = {
    // Provenance, so a stale table is diagnosable without re-running this script.
    source: 'georef-belgium-postal-codes (bpost/BOSA via Opendatasoft), CC-BY 4.0',
    generatedAt: new Date().toISOString().slice(0, 10),
    provinces: [...provinces.values()].sort((a, b) => a.code.localeCompare(b.code)),
    municipalities: [...municipalities.values()].sort((a, b) => a.nis.localeCompare(b.nis)),
  };

  const postcodes = new Set(out.municipalities.flatMap((m) => m.pc));
  if (out.provinces.length !== 11) throw new Error(`expected 11 areas, got ${out.provinces.length}`);
  if (out.municipalities.length < 550) throw new Error(`only ${out.municipalities.length} municipalities`);
  if (postcodes.size < 1100) throw new Error(`only ${postcodes.size} postcodes`);

  fs.writeFileSync(OUT, JSON.stringify(out) + '\n');
  process.stdout.write(
    `wrote ${path.relative(process.cwd(), OUT)} — ` +
      `${out.provinces.length} areas, ${out.municipalities.length} municipalities, ` +
      `${postcodes.size} postcodes, ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`FAILED: ${err.message}\n`);
  process.exit(1);
});
