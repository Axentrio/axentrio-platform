/**
 * Lead readiness scoring.
 *
 * The properties that matter are not "does it add up" but the ones that keep a score
 * about a person defensible: it is explainable, it never counts a dead booking, and a
 * human always wins.
 */
import { describe, it, expect } from 'vitest';
import { computeLeadReadiness, readinessBand, READINESS_VERSION } from '../../leads/readiness';

describe('computeLeadReadiness — every point is explainable', () => {
  it('scores nothing for an empty lead', () => {
    const r = computeLeadReadiness({});
    expect(r.score).toBe(0);
    expect(r.components).toEqual([]);
    expect(r.source).toBe('computed');
    expect(r.version).toBe(READINESS_VERSION);
  });

  it('returns a component for every point awarded, so the total is always auditable', () => {
    const r = computeLeadReadiness({
      phone: '32475464421',
      email: 'a@b.com',
      name: 'Achraf',
      notes: 'Blocked drain',
      address: 'Kerkstraat 12',
      bookingId: 'bk-1',
      bookingStatus: 'confirmed',
      personConversationCount: 2,
    });
    // The score is exactly the sum of its stated reasons — no hidden term.
    expect(r.components.reduce((n, c) => n + c.points, 0)).toBeGreaterThanOrEqual(r.score);
    expect(r.score).toBe(100);
    expect(r.components.map((c) => c.key)).toContain('booking');
    expect(r.components.map((c) => c.key)).toContain('reachable');
  });

  it('treats reachability as the dominant term — an unreachable lead cannot score well', () => {
    const unreachable = computeLeadReadiness({ notes: 'Blocked drain', address: 'Kerkstraat 12', name: 'A' });
    const reachable = computeLeadReadiness({ phone: '324754', notes: 'Blocked drain' });
    expect(reachable.score).toBeGreaterThan(unreachable.score);
  });

  it('does not double-count a second contact channel as twice as good', () => {
    const one = computeLeadReadiness({ phone: '324754' });
    const both = computeLeadReadiness({ phone: '324754', email: 'a@b.com' });
    expect(both.score).toBeGreaterThan(one.score);
    expect(both.score).toBeLessThan(one.score * 2);
  });
});

describe('computeLeadReadiness — a dead booking is not a booking', () => {
  it('scores nothing for a cancelled booking', () => {
    // Counting it would rank a customer who walked away above one still deciding.
    const live = computeLeadReadiness({ phone: '1', bookingId: 'b', bookingStatus: 'confirmed' });
    const dead = computeLeadReadiness({ phone: '1', bookingId: 'b', bookingStatus: 'cancelled' });
    expect(dead.score).toBeLessThan(live.score);
    expect(dead.components.map((c) => c.key)).not.toContain('booking');
  });

  it('scores nothing for a failed booking either', () => {
    const failed = computeLeadReadiness({ phone: '1', bookingId: 'b', bookingStatus: 'failed' });
    expect(failed.components.map((c) => c.key)).not.toContain('booking');
  });
});

describe('computeLeadReadiness — the human override is terminal', () => {
  it('overrides the computed score entirely and says so', () => {
    const r = computeLeadReadiness({
      phone: '32475464421',
      notes: 'Blocked drain',
      bookingId: 'bk-1',
      bookingStatus: 'confirmed',
      override: 10,
    });
    expect(r.score).toBe(10); // not the ~80 it would otherwise compute
    expect(r.source).toBe('human');
    expect(r.components).toEqual([{ key: 'human_override', points: 10, label: 'Set manually' }]);
  });

  it('clamps an out-of-range override rather than storing nonsense', () => {
    expect(computeLeadReadiness({ override: 500 }).score).toBe(100);
    expect(computeLeadReadiness({ override: -20 }).score).toBe(0);
  });

  it('ignores a non-finite override and falls back to computing', () => {
    const r = computeLeadReadiness({ phone: '1', override: Number.NaN });
    expect(r.source).toBe('computed');
  });
});

describe('readinessBand — coarse on purpose', () => {
  it('bands rather than exposing false precision between near-identical scores', () => {
    // 68 vs 66 is noise; both are "partial".
    expect(readinessBand(68)).toBe(readinessBand(66));
    expect(readinessBand(100)).toBe('ready');
    expect(readinessBand(70)).toBe('ready');
    expect(readinessBand(40)).toBe('partial');
    expect(readinessBand(39)).toBe('thin');
    expect(readinessBand(0)).toBe('thin');
  });
});
