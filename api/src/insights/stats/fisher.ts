/**
 * Fisher's exact test for a 2×2 contingency table (P3 / ADR-0014, D2).
 *
 * Chosen over chi-square because at SMB volume (20–200 sessions/week) cells
 * are small or zero, where chi-square's expected-cell≥5 assumption fails.
 * Pure functions — no I/O, fully unit-tested against known reference values.
 *
 * Table layout:
 *        outcome   ¬outcome
 *   A       a          b
 *   ¬A      c          d
 */

/** log Γ(x) via the Lanczos approximation — stable for the n≤~1000 we see. */
function lgamma(x: number): number {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    // Reflection formula.
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  }
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** log of the binomial coefficient C(n, k). */
function logChoose(n: number, k: number): number {
  if (k < 0 || k > n) return -Infinity;
  return lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1);
}

/**
 * Hypergeometric pmf of observing `a` in the top-left cell given fixed
 * margins: row1 total r1 (=a+b), col1 total k (=a+c), grand total n.
 * P(a) = C(r1, a) · C(n−r1, k−a) / C(n, k)
 */
function hyperLogProb(a: number, r1: number, k: number, n: number): number {
  return logChoose(r1, a) + logChoose(n - r1, k - a) - logChoose(n, k);
}

/**
 * Two-sided Fisher's exact p-value: the sum of probabilities of all tables
 * (with the same margins) that are no more probable than the observed one.
 */
export function fisherExactTwoSided(a: number, b: number, c: number, d: number): number {
  const r1 = a + b;
  const r2 = c + d;
  const k = a + c;
  const n = r1 + r2;
  if (n === 0) return 1;

  const logPObs = hyperLogProb(a, r1, k, n);
  // `a` ranges over the support given fixed margins.
  const aMin = Math.max(0, k - r2);
  const aMax = Math.min(r1, k);

  // Sum probabilities ≤ P(observed) in linear space; a small relative epsilon
  // guards float wobble at the boundary tables.
  const eps = 1e-7;
  let p = 0;
  for (let ai = aMin; ai <= aMax; ai++) {
    const lp = hyperLogProb(ai, r1, k, n);
    if (lp <= logPObs + eps) p += Math.exp(lp);
  }
  return Math.min(1, p);
}

/**
 * Relative risk of the outcome between the two rows:
 *   RR = [a/(a+b)] / [c/(c+d)]
 * Returns null when a denominator is zero (effect size undefined).
 */
export function relativeRisk(a: number, b: number, c: number, d: number): number | null {
  const rA = a + b === 0 ? null : a / (a + b);
  const rNotA = c + d === 0 ? null : c / (c + d);
  if (rA === null || rNotA === null || rNotA === 0) return null;
  return rA / rNotA;
}
