/**
 * How often does grouping actually have something to say? (#81's open gate clause.)
 *
 * Two live sweeps answered this with n=23 and n=6 and were over-read: one success in 23 is a 95%
 * Wilson interval of 0.8%–21%, one in six is 3%–56%, and those overlap almost entirely. Neither a
 * prevalence nor a density effect can be read off them. They were also drawn from six hand-picked
 * diary shapes, so the experimental unit was the shape rather than the offer, and every booking
 * sat beyond the 24-hour traffic horizon — the one regime where `insertion-scorer` cannot produce
 * within-gap variation at all.
 *
 * This runs the REAL scorer over randomised stratified diaries instead. No widget, no Google
 * spend, no seeded tenant: hundreds of diaries in seconds, with the diary as the unit of analysis
 * and Wilson intervals on every rate.
 *
 * WHAT IT IS NOT. The travel model here is synthetic — haversine over a set of real Belgian
 * coordinates, with a rush-hour shoulder standing in for traffic. It answers "how often does the
 * GEOMETRY of a working day produce a cheaper alternative", which is the question the gate asks.
 * It cannot answer how often real customers ask on days shaped like these. Only a live tenant can.
 *
 *   npx ts-node --transpile-only scripts/lp4-prevalence-experiment.ts [diariesPerStratum]
 */
import { scoreCandidates, type LegLookup } from '../src/booking/travel/insertion-scorer';
import { resolveDayPeriods } from '../src/booking/travel/half-day';

/** Real places, so the distances between them are real distances. */
const PLACES = {
  antwerp: [
    { lat: 51.2213, lng: 4.3997 }, // Grote Markt
    { lat: 51.2177, lng: 4.4127 }, // Meir
    { lat: 51.2203, lng: 4.4009 }, // Groenplaats
    { lat: 51.2246, lng: 4.4145 }, // Sint-Katelijnevest
  ],
  ghent: [
    { lat: 51.0543, lng: 3.7226 }, // Korenmarkt
    { lat: 51.0479, lng: 3.7250 }, // Veldstraat
  ],
  mechelen: [{ lat: 51.0259, lng: 4.4776 }],
  brussels: [{ lat: 50.8467, lng: 4.3525 }],
};
const REGIONS = Object.keys(PLACES) as Array<keyof typeof PLACES>;

/** Deterministic PRNG, so a reported number can be reproduced from its seed. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const haversineKm = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

/**
 * Minutes for a leg. `trafficAware` is the whole point of the second arm: beyond the 24-hour
 * horizon the real router buckets every departure to one constant, so costs inside a gap cannot
 * separate. Inside it, they can.
 */
function lookupFor(trafficAware: boolean): LegLookup {
  return async (from, to, departAt) => {
    const km = haversineKm(from, to);
    // 28 km/h in town, 75 on the motorway — roughly what the live probes showed.
    const kmh = km < 8 ? 28 : 75;
    const base = (km / kmh) * 60;
    if (!trafficAware) return Math.max(1, Math.round(base));
    const hour = departAt.getUTCHours();
    const rush = hour >= 16 ? 1.5 : hour >= 15 ? 1.25 : hour <= 8 ? 1.3 : 1;
    return Math.max(1, Math.round(base * rush));
  };
}

const DAY = '2026-09-07';
const at = (mins: number) =>
  new Date(Date.UTC(2026, 8, 7, Math.floor(mins / 60), mins % 60));

const periods = resolveDayPeriods({
  localDay: DAY,
  timezone: 'UTC',
  windows: [{ start: '08:00', end: '18:00' }],
  alwaysOpen: false,
})!;

interface Stratum {
  jobs: number;
  dispersion: 'one-cluster' | 'two-clusters' | 'scattered';
  customer: 'in-cluster' | 'other-cluster' | 'far';
  trafficAware: boolean;
  /** Score the raw grid, or only the slots the feasibility gate would actually have offered. */
  afterGate: boolean;
}

/** One diary + one customer, scored. Returns what the gate would record. */
async function runDiary(stratum: Stratum, seed: number) {
  const rnd = rng(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];

  const regionFor = (i: number): keyof typeof PLACES => {
    if (stratum.dispersion === 'one-cluster') return 'antwerp';
    if (stratum.dispersion === 'two-clusters') return i % 2 === 0 ? 'antwerp' : 'ghent';
    return REGIONS[i % REGIONS.length];
  };

  // Jobs on a 08:00–18:00 day, 45 minutes each, spread with random gaps so candidate slots survive.
  const anchors = [];
  let cursor = 8 * 60 + Math.floor(rnd() * 30);
  for (let i = 0; i < stratum.jobs; i++) {
    const start = cursor;
    if (start + 45 > 18 * 60) break;
    anchors.push({
      blockedStart: at(start),
      blockedEnd: at(start + 45),
      point: pick(PLACES[regionFor(i)]),
    });
    cursor = start + 45 + 30 + Math.floor(rnd() * 90);
  }

  const customerRegion: keyof typeof PLACES =
    stratum.customer === 'in-cluster'
      ? 'antwerp'
      : stratum.customer === 'other-cluster'
        ? 'ghent'
        : 'brussels';
  const customer = pick(PLACES[customerRegion]);

  // Every free 30-minute start on the grid that does not collide with a job.
  const all = [];
  for (let m = 8 * 60; m + 45 <= 18 * 60; m += 30) {
    const s = at(m);
    const e = at(m + 45);
    const clash = anchors.some((a) => a.blockedStart < e && a.blockedEnd > s);
    if (!clash) all.push({ blockedStart: s, blockedEnd: e, point: customer });
  }
  if (!all.length) return null;

  // THE FEASIBILITY GATE, applied the way production applies it. A slot survives only if the van
  // can reach it from the previous job and get to the next one, with the owner's slack on top.
  //
  // This is the confound that reconciles a simulation with a live measurement. Scoring the raw
  // grid answers "does the geometry of a day yield a cheaper alternative". Scoring the survivors
  // answers "does one SURVIVE to be offered" — and the gate removes expensive insertions first,
  // which mechanically strips out the very variation grouping feeds on. Only the second number is
  // what a customer could ever experience, so both are reported.
  const SLACK_MIN = 10;
  const drive = lookupFor(stratum.trafficAware);
  const feasible = [];
  for (const c of all) {
    const prev = [...anchors].filter((a) => a.blockedEnd <= c.blockedStart).pop();
    const next = anchors.find((a) => a.blockedStart >= c.blockedEnd);
    let ok = true;
    if (prev) {
      const gap = (c.blockedStart.getTime() - prev.blockedEnd.getTime()) / 60_000;
      ok = ok && (await drive(prev.point, c.point, prev.blockedEnd, 'adjacent'))! + SLACK_MIN <= gap;
    }
    if (ok && next) {
      const gap = (next.blockedStart.getTime() - c.blockedEnd.getTime()) / 60_000;
      ok = ok && (await drive(c.point, next.point, c.blockedEnd, 'adjacent'))! + SLACK_MIN <= gap;
    }
    if (ok) feasible.push(c);
  }

  const candidates = stratum.afterGate ? feasible : all;
  if (!candidates.length) return null;

  const scored = await scoreCandidates({
    candidates,
    anchors,
    periods,
    base: null,
    maxDetourMin: null,
    lookup: lookupFor(stratum.trafficAware),
    legBudget: 10_000,
    deadline: Date.now() + 60_000,
  });

  const priced = scored.filter((s) => s.costMinutes !== null).map((s) => s.costMinutes as number);
  const distinct = new Set(priced).size;
  return {
    slots: scored.length,
    priced: priced.length,
    // "Steerable-eligible": at least two priced slots, so there is something to choose BETWEEN.
    // Reporting successes over every offer conflates prevalence with coverage — the denominator
    // mistake the live sweeps made.
    eligible: priced.length >= 2,
    varied: distinct > 1,
    // The live gate's own threshold: a saving worth telling a customer about.
    cheaper: priced.length >= 2 && Math.max(...priced) - Math.min(...priced) >= 10,
  };
}

/** 95% Wilson interval — the reason "1 of 23" cannot be reported as a rate. */
function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [0, 0];
  const z = 1.96;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - s) / d), Math.min(1, (c + s) / d)];
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

(async () => {
  const perStratum = Number(process.argv[2] ?? 40);
  const strata: Stratum[] = [];
  for (const jobs of [1, 2, 3, 4, 5, 6])
    for (const dispersion of ['one-cluster', 'two-clusters', 'scattered'] as const)
      for (const customer of ['in-cluster', 'other-cluster', 'far'] as const)
        for (const trafficAware of [false, true])
          for (const afterGate of [false, true])
            strata.push({ jobs, dispersion, customer, trafficAware, afterGate });

  const blank = () => ({ diaries: 0, eligible: 0, varied: 0, cheaper: 0 });
  const byArm: Record<string, ReturnType<typeof blank>> = {
    'raw grid, no traffic': blank(),
    'raw grid, traffic': blank(),
    'AFTER gate, no traffic': blank(),
    'AFTER gate, traffic': blank(),
  };
  const byJobs: Record<number, { eligible: number; cheaper: number }> = {};

  let seed = 1;
  for (const stratum of strata) {
    for (let i = 0; i < perStratum; i++) {
      const r = await runDiary(stratum, seed++);
      if (!r) continue;
      const arm = `${stratum.afterGate ? 'AFTER gate' : 'raw grid'}, ${stratum.trafficAware ? 'traffic' : 'no traffic'}`;
      byArm[arm].diaries++;
      if (!r.eligible) continue;
      byArm[arm].eligible++;
      if (r.varied) byArm[arm].varied++;
      if (r.cheaper) byArm[arm].cheaper++;
      if (stratum.afterGate) {
        byJobs[stratum.jobs] ??= { eligible: 0, cheaper: 0 };
        byJobs[stratum.jobs].eligible++;
        if (r.cheaper) byJobs[stratum.jobs].cheaper++;
      }
    }
  }

  console.log(`\nstrata=${strata.length}  diaries/stratum=${perStratum}\n`);
  console.log('arm                       diaries  eligible   varied            cheaper (>=10min)');
  for (const [arm, a] of Object.entries(byArm)) {
    const [lo, hi] = wilson(a.cheaper, a.eligible);
    console.log(
      `${arm.padEnd(25)} ${String(a.diaries).padStart(7)}  ${String(a.eligible).padStart(8)}   ` +
        `${pct(a.varied / (a.eligible || 1)).padStart(6)}   ` +
        `${pct(a.cheaper / (a.eligible || 1)).padStart(6)}  [${pct(lo)}–${pct(hi)}]`
    );
  }

  console.log('\nAFTER the feasibility gate — the only numbers a customer could experience:');
  console.log('jobs/day   eligible   cheaper');
  for (const jobs of Object.keys(byJobs).map(Number).sort((a, b) => a - b)) {
    const b = byJobs[jobs];
    const [lo, hi] = wilson(b.cheaper, b.eligible);
    console.log(
      `${String(jobs).padStart(8)}   ${String(b.eligible).padStart(8)}   ` +
        `${pct(b.cheaper / (b.eligible || 1)).padStart(6)}  [${pct(lo)}–${pct(hi)}]`
    );
  }
  console.log(
    '\nRates are over STEERABLE-ELIGIBLE diaries (>=2 priced slots), not all offers.\n' +
      'Synthetic travel model — answers how often a working day\'s GEOMETRY yields a cheaper\n' +
      'alternative, not how often real customers ask on such days.\n'
  );
})();
