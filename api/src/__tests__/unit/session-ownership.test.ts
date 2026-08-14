import { describe, expect, it } from 'vitest';
import {
  deriveStatusFromOwnership,
  ownershipFromStatus,
} from '../../services/session-ownership';
import type { SessionOwnership } from '../../services/session-ownership';

type SessionStatus = 'active' | 'closed' | 'waiting' | 'handoff' | 'bot';

describe('ownershipFromStatus', () => {
  const cases: Array<[SessionStatus, boolean, SessionOwnership]> = [
    ['active', false, 'bot_owned'],
    ['active', true, 'human_owned'], // an assigned agent on a live session = human owns it

    ['closed', false, 'closed'],
    ['closed', true, 'closed'],
    ['waiting', false, 'bot_owned'],
    ['waiting', true, 'bot_owned'],
    ['handoff', false, 'handoff_requested'],
    ['handoff', true, 'human_owned'],
    ['bot', false, 'bot_owned'],
    ['bot', true, 'bot_owned'],
  ];

  it.each(cases)('maps %s with assigned-agent=%s to %s', (status, hasAssignedAgent, expected) => {
    expect(ownershipFromStatus(status, hasAssignedAgent)).toBe(expected);
  });
});

describe('deriveStatusFromOwnership', () => {
  const cases: Array<[SessionOwnership, SessionStatus, SessionStatus]> = [
    ['human_owned', 'active', 'handoff'],
    ['handoff_requested', 'waiting', 'handoff'],
    ['closed', 'handoff', 'closed'],
    ['bot_owned', 'active', 'active'],
    ['bot_owned', 'waiting', 'waiting'],
    ['bot_owned', 'bot', 'bot'],
    ['bot_owned', 'handoff', 'bot'],
    ['bot_owned', 'closed', 'bot'],
  ];

  it.each(cases)('maps %s from previous status %s to %s', (ownership, prevStatus, expected) => {
    expect(deriveStatusFromOwnership(ownership, prevStatus)).toBe(expected);
  });
});
