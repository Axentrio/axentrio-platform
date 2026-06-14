import { describe, it, expect } from 'vitest';
import { fisherExactTwoSided, relativeRisk } from '../../insights/stats/fisher';

describe('insights · Fisher exact (P3 D2)', () => {
  it('matches R fisher.test on the classic 3/1/1/3 table (p ≈ 0.4857)', () => {
    expect(fisherExactTwoSided(3, 1, 1, 3)).toBeCloseTo(0.4857, 3);
  });

  it('matches R on a perfectly-separated 10/0/0/10 table (p ≈ 1.08e-5)', () => {
    expect(fisherExactTwoSided(10, 0, 0, 10)).toBeCloseTo(1.0823e-5, 7);
  });

  it('returns ~1 for an independent table', () => {
    // 5/5/5/5 — identical rates, maximally non-significant.
    expect(fisherExactTwoSided(5, 5, 5, 5)).toBeGreaterThan(0.99);
  });

  it('is symmetric to row/column relabeling', () => {
    expect(fisherExactTwoSided(8, 2, 3, 7)).toBeCloseTo(fisherExactTwoSided(2, 8, 7, 3), 10);
  });

  it('handles a zero total gracefully', () => {
    expect(fisherExactTwoSided(0, 0, 0, 0)).toBe(1);
  });

  it('relativeRisk computes the rate ratio and nulls on zero denominators', () => {
    // top rate 30/100 = .3, bottom 18/100 = .18 → RR ≈ 1.667
    expect(relativeRisk(30, 70, 18, 82)).toBeCloseTo(0.3 / 0.18, 5);
    expect(relativeRisk(0, 0, 5, 5)).toBeNull(); // empty top row
    expect(relativeRisk(5, 5, 0, 10)).toBeNull(); // zero bottom rate
  });
});
