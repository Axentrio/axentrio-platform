import { describe, it, expect } from 'vitest';
import {
  computeDueAt,
  isContactFragment,
  QUIET_LONE_MS,
  QUIET_BURST_MS,
  QUIET_CAPTURE_MS,
  MAX_WAIT_MS,
  TurnState,
} from '../../services/turn-timing';

const T0 = 1_700_000_000_000; // fixed base ms

function state(overrides: Partial<TurnState> = {}): TurnState {
  return {
    firstPendingAt: T0,
    lastPendingAt: T0,
    count: 1,
    captureMode: false,
    ...overrides,
  };
}

describe('computeDueAt', () => {
  it('lone message → short window from last message', () => {
    expect(computeDueAt(state())).toBe(T0 + QUIET_LONE_MS);
  });

  it('burst (count >= 2) → medium window from the LAST message', () => {
    // first at T0, last 1s later, two messages
    const last = T0 + 1000;
    expect(computeDueAt(state({ count: 2, lastPendingAt: last }))).toBe(last + QUIET_BURST_MS);
  });

  it('capture mode → long window even for a lone message', () => {
    expect(computeDueAt(state({ captureMode: true }))).toBe(T0 + QUIET_CAPTURE_MS);
  });

  it('capture mode overrides the burst tier', () => {
    const last = T0 + 500;
    expect(computeDueAt(state({ count: 3, captureMode: true, lastPendingAt: last }))).toBe(
      last + QUIET_CAPTURE_MS,
    );
  });

  it('the MAX_WAIT ceiling caps a long-running burst', () => {
    // many messages, the last one is well past firstPendingAt + MAX_WAIT
    const last = T0 + MAX_WAIT_MS + 5000;
    expect(computeDueAt(state({ count: 9, lastPendingAt: last }))).toBe(T0 + MAX_WAIT_MS);
  });

  it('ceiling and quiet window agree at the boundary', () => {
    // last message exactly MAX_WAIT - QUIET_BURST after first → both equal
    const last = T0 + (MAX_WAIT_MS - QUIET_BURST_MS);
    expect(computeDueAt(state({ count: 2, lastPendingAt: last }))).toBe(T0 + MAX_WAIT_MS);
  });
});

describe('isContactFragment', () => {
  it('matches a lone email', () => {
    expect(isContactFragment('achraf@gmail.com')).toBe(true);
  });

  it('matches phone numbers in common formats', () => {
    expect(isContactFragment('0475464421')).toBe(true);
    expect(isContactFragment('+32 475 46 44 21')).toBe(true);
    expect(isContactFragment('(0475) 46-44-21')).toBe(true);
  });

  it('does not match ordinary prose', () => {
    expect(isContactFragment('I would like to book an appointment please')).toBe(false);
    expect(isContactFragment('yes')).toBe(false);
    expect(isContactFragment('')).toBe(false);
  });

  it('ignores long blobs that merely contain contact-like text', () => {
    const long = 'here is my email achraf@gmail.com and a lot more text '.repeat(3);
    expect(isContactFragment(long)).toBe(false);
  });
});
