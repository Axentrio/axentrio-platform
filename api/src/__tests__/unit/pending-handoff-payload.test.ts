import { describe, it, expect } from 'vitest';
import { pendingHandoffSocketPayload } from '../../realtime/pending-handoff-payload';

describe('pendingHandoffSocketPayload', () => {
  it('carries the Inbox queue fields the Handoff tab filters on', () => {
    const payload = pendingHandoffSocketPayload({
      sessionId: 'sess-1',
      visitorId: 'abcdefghij',
      reason: 'bot_escalation_keyword',
      handoffId: 'ho-1',
      requestedAt: new Date('2026-08-19T02:00:00.000Z'),
    });

    expect(payload).toMatchObject({
      id: 'sess-1',
      chatId: 'sess-1',
      sessionId: 'sess-1',
      status: 'pending',
      reason: 'bot_escalation_keyword',
      priority: 'medium',
      waitTime: 0,
      requestedAt: '2026-08-19T02:00:00.000Z',
      userName: 'Visitor abcdefgh',
      handoffId: 'ho-1',
    });
  });

  it('uses session metadata displayName when present', () => {
    const payload = pendingHandoffSocketPayload({
      sessionId: 'sess-1',
      visitorId: 'abcdefghij',
      metadata: { customData: { displayName: 'Ada Lovelace' } },
    });
    expect(payload.userName).toBe('Ada Lovelace');
  });
});
