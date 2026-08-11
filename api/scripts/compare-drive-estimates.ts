/**
 * How wrong is the free estimate, compared with what Google actually says?
 *
 * `haversine-lookup.ts` can produce a drive time from geometry alone - no API, no cost, no
 * dependency. The question this answers is whether it is good enough to be TRUSTED for anything,
 * and that is not one question but two:
 *
 *   - Is it accurate enough to RANK slots? Being roughly right is enough to prefer the nearer of
 *     two jobs, so a consistent bias matters less than a wide spread.
 *   - Is it accurate enough to REFUSE one? Almost certainly not, and the point of measuring is to
 *     be able to say so with a number rather than an instinct.
 *
 * The constants in `haversine-lookup.ts` were REASONED from earlier measurements rather than
 * fitted to them. Until this has been run they are a hypothesis. It also reports the fit that
 * WOULD have been best, so tuning them is a decision rather than a guess.
 *
 *   GOOGLE_MAPS_API_KEY=... npx ts-node --transpile-only scripts/compare-drive-estimates.ts
 *
 * Costs one billable Routes element per pair below, and nothing else. It calls Google directly
 * rather than going through the travel gate, so no tenant is metered and no eligibility is needed.
 */
import axios from 'axios';
import { haversineKm, type GeoPoint } from '../src/contracts/travel';
import {
  estimateDriveMinutes,
  DETOUR_FACTOR,
  FIXED_OVERHEAD_MIN,
  ESTIMATED_KMH,
} from '../src/booking/travel/haversine-lookup';

/**
 * Real places, chosen to span the shape of the problem rather than to flatter the model.
 *
 * Deliberately includes the pathological pair from `contracts/travel.ts` - 550 metres apart with
 * the Scheldt in between - because a model that only sees easy journeys will look far better than
 * it is. The whole risk here lives in the awkward cases.
 */
const PLACES: Record<string, GeoPoint> = {
  'Antwerp Grote Markt': { lat: 51.2213, lng: 4.3997 },
  'Antwerp Meir': { lat: 51.2177, lng: 4.4127 },
  'Antwerp Sint-Jansvliet': { lat: 51.2187, lng: 4.3958 },
  'Antwerp Linkeroever': { lat: 51.2226, lng: 4.3906 },
  'Antwerp Berchem': { lat: 51.1966, lng: 4.4318 },
  'Ghent Korenmarkt': { lat: 51.0543, lng: 3.7226 },
  'Ghent Veldstraat': { lat: 51.0479, lng: 3.725 },
  'Brussels Grand Place': { lat: 50.8467, lng: 4.3525 },
  'Brussels Schuman': { lat: 50.8434, lng: 4.3807 },
  'Mechelen Grote Markt': { lat: 51.0259, lng: 4.4776 },
  'Leuven Grote Markt': { lat: 50.8789, lng: 4.7009 },
  'Bruges Markt': { lat: 51.2085, lng: 3.2247 },
};

const PAIRS: Array<[string, string]> = [
  // Short urban hops - where fixed costs dominate and a straight line means least.
  ['Antwerp Grote Markt', 'Antwerp Meir'],
  ['Antwerp Sint-Jansvliet', 'Antwerp Linkeroever'], // the Scheldt case
  ['Ghent Korenmarkt', 'Ghent Veldstraat'],
  ['Brussels Grand Place', 'Brussels Schuman'],
  ['Antwerp Grote Markt', 'Antwerp Berchem'],
  // Intercity - where the rate term should dominate and the model should do best.
  ['Antwerp Grote Markt', 'Ghent Korenmarkt'],
  ['Antwerp Grote Markt', 'Mechelen Grote Markt'],
  ['Antwerp Grote Markt', 'Brussels Grand Place'],
  ['Ghent Korenmarkt', 'Brussels Grand Place'],
  ['Mechelen Grote Markt', 'Leuven Grote Markt'],
  ['Brussels Grand Place', 'Leuven Grote Markt'],
  ['Ghent Korenmarkt', 'Bruges Markt'],
  ['Antwerp Grote Markt', 'Bruges Markt'],
  ['Brussels Grand Place', 'Bruges Markt'],
];

const ROUTES_URL = 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix';

async function googleMinutes(from: GeoPoint, to: GeoPoint, apiKey: string): Promise<number | null> {
  const waypoint = (p: GeoPoint) => ({ waypoint: { location: { latLng: { latitude: p.lat, longitude: p.lng } } } });
  try {
    const { data } = await axios.post<Array<{ duration?: string; condition?: string }>>(
      ROUTES_URL,
      { origins: [waypoint(from)], destinations: [waypoint(to)], travelMode: 'DRIVE' },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': 'originIndex,destinationIndex,duration,condition',
        },
        timeout: 15_000,
      }
    );
    const el = Array.isArray(data) ? data[0] : null;
    const raw = typeof el?.duration === 'string' ? el.duration.trim() : '';
    if (!/^\d+(\.\d+)?s$/.test(raw)) return null;
    return Math.ceil(Number(raw.slice(0, -1)) / 60);
  } catch {
    return null;
  }
}

const pct = (n: number) => `${n >= 0 ? '+' : ''}${(n * 100).toFixed(0)}%`;

(async () => {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    console.error('GOOGLE_MAPS_API_KEY is required. This script calls Google directly.');
    process.exit(1);
  }

  const rows: Array<{ pair: string; km: number; google: number; est: number; err: number }> = [];

  for (const [a, b] of PAIRS) {
    const from = PLACES[a];
    const to = PLACES[b];
    const google = await googleMinutes(from, to, apiKey);
    if (google === null || google === 0) {
      console.log(`  (skipped ${a} -> ${b}: no usable answer)`);
      continue;
    }
    const est = estimateDriveMinutes(from, to);
    rows.push({
      pair: `${a} -> ${b}`,
      km: Math.round(haversineKm(from, to) * 10) / 10,
      google,
      est,
      err: (est - google) / google,
    });
  }

  if (!rows.length) {
    console.error('No pairs answered. Check the key and its API restrictions.');
    process.exit(1);
  }

  console.log(`\nModel: ${FIXED_OVERHEAD_MIN} min + (km x ${DETOUR_FACTOR}) / ${ESTIMATED_KMH} km/h\n`);
  console.log('  km   google   est    error   pair');
  for (const r of rows.sort((x, y) => x.km - y.km)) {
    console.log(
      `${String(r.km).padStart(6)}${String(r.google).padStart(8)}${String(r.est).padStart(7)}` +
        `${pct(r.err).padStart(9)}   ${r.pair}`
    );
  }

  const errs = rows.map((r) => r.err).sort((a, b) => a - b);
  const mean = errs.reduce((s, e) => s + e, 0) / errs.length;
  const median = errs[Math.floor(errs.length / 2)];
  const absMean = rows.reduce((s, r) => s + Math.abs(r.err), 0) / rows.length;
  const worstUnder = rows.reduce((w, r) => (r.err < w.err ? r : w));
  const worstOver = rows.reduce((w, r) => (r.err > w.err ? r : w));

  console.log(`\n  pairs                 ${rows.length}`);
  console.log(`  mean error            ${pct(mean)}`);
  console.log(`  median error          ${pct(median)}`);
  console.log(`  mean ABSOLUTE error   ${pct(absMean)}   <- the number that matters for ranking`);
  console.log(`  worst under-estimate  ${pct(worstUnder.err)}  ${worstUnder.pair}`);
  console.log(`  worst over-estimate   ${pct(worstOver.err)}  ${worstOver.pair}`);

  // UNDER-estimating is the dangerous direction: it says a drive fits when it does not, which is
  // what authorises a booking the owner cannot make. Over-estimating only costs an offered slot.
  const dangerous = rows.filter((r) => r.err < -0.15);
  console.log(
    `\n  legs under-estimated by more than 15%: ${dangerous.length} of ${rows.length}` +
      `\n  (this is the direction that would authorise an impossible booking)`
  );
  for (const d of dangerous) console.log(`    ${pct(d.err).padStart(6)}  ${d.pair}`);

  // What the constants SHOULD have been, so tuning is arithmetic rather than taste. Least-squares
  // fit of google_minutes = overhead + km_detoured / kmh * 60 over the sample.
  const n = rows.length;
  const xs = rows.map((r) => r.km * DETOUR_FACTOR);
  const ys = rows.map((r) => r.google);
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  const slope =
    xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  const intercept = my - slope * mx;
  console.log(
    `\n  BEST FIT on this sample: ${intercept.toFixed(1)} min + km x ${DETOUR_FACTOR} / ` +
      `${(60 / slope).toFixed(1)} km/h` +
      `\n  (current: ${FIXED_OVERHEAD_MIN} min and ${ESTIMATED_KMH} km/h)`
  );
  console.log(
    '\n  Fourteen pairs in two regions is a sample, not a study. Read the spread, not the mean.\n'
  );
})();
