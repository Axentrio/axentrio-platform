/**
 * Explicit confirmation is a whole-message yes, not any later utterance.
 * Digits mean they named a time. A details dump is never a yes.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const store = new Map<string, string>();
const redis = {
  get: vi.fn(async (k: string) => store.get(k) ?? null),
  set: vi.fn(async (k: string, v: string) => {
    store.set(k, v);
    return 'OK';
  }),
  del: vi.fn(async (k: string) => {
    store.delete(k);
    return 1;
  }),
};
vi.mock('../../config/redis', () => ({ getRedisClient: () => redis }));
vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  isAffirmativeReply,
  isConfirmingChip,
  summaryWasAsked,
  refuseUnlessConfirmed,
  refuseUnlessRescheduleConfirmed,
  refuseUnlessCancelConfirmed,
  putPendingBooking,
  CONFIRMATION_REQUIRED,
} from '../../agent/pending-booking-confirmation';
import type { ToolContext } from '../../agent/tool-adapter';

describe('isAffirmativeReply', () => {
  it.each([
    'ja',
    'Ja, dat klopt',
    'Ja hoor',
    'Klopt helemaal',
    "Yes, that's correct.",
    'oké',
    'boek het',
    'oui',
    "d'accord",
  ])('accepts %s', (text) => {
    expect(isAffirmativeReply(text)).toBe(true);
  });

  it('rejects a first-message details dump', () => {
    expect(
      isAffirmativeReply(
        'Ik wil maandag 26 oktober 2026 om 10:00 de Korting booking test boeken. Tom Test, 0470 00 00 12, achraftamranim@gmail.com.',
      ),
    ).toBe(false);
  });

  it('rejects a later change of time', () => {
    expect(isAffirmativeReply('Change it to 11:00')).toBe(false);
  });

  it('rejects a later question', () => {
    expect(isAffirmativeReply('What is the address?')).toBe(false);
  });

  it('rejects a yes that also names a time', () => {
    expect(isAffirmativeReply('ja 11:00')).toBe(false);
  });

  it('rejects a no after ja', () => {
    expect(isAffirmativeReply('ja liever niet')).toBe(false);
  });
});

describe('isConfirmingChip', () => {
  const start = '2026-10-26T10:00:00';

  it('accepts a short chip for the pending hour', () => {
    expect(isConfirmingChip('Mon 10:00 AM', start)).toBe(true);
    expect(isConfirmingChip('Mon 10:00', start)).toBe(true);
  });

  it('rejects a chip for a different hour', () => {
    expect(isConfirmingChip('Mon 11:00 AM', start)).toBe(false);
  });

  it('rejects a time question even when it is under 80 characters', () => {
    expect(isConfirmingChip('Kan ik maandag 5 oktober 2026 om 10:00 langskomen?', start)).toBe(false);
    expect(isConfirmingChip('Kan ik om 10:00 langskomen?', start)).toBe(false);
  });

  it('rejects the details dump even though it names 10:00', () => {
    expect(
      isConfirmingChip(
        'Ik wil maandag 26 oktober 2026 om 10:00 de Korting booking test boeken. Tom Test, 0470 00 00 12, achraftamranim@gmail.com.',
        start,
      ),
    ).toBe(false);
  });
});

describe('summaryWasAsked', () => {
  const start = '2026-10-26T10:00:00';

  it('accepts a prior booking question that names the hour', () => {
    expect(
      summaryWasAsked(
        [
          { role: 'user', content: 'dump' },
          { role: 'assistant', content: 'Zal ik boeken om 10:00?' },
          { role: 'user', content: 'Ja, dat klopt' },
        ],
        start,
      ),
    ).toBe(true);
  });

  it('rejects an availability question that does not name the hour', () => {
    expect(
      summaryWasAsked(
        [{ role: 'assistant', content: 'Zal ik de beschikbaarheid checken?' }],
        start,
      ),
    ).toBe(false);
  });

  it('rejects a booking question for a different hour', () => {
    expect(
      summaryWasAsked(
        [{ role: 'assistant', content: 'Zal ik boeken om 11:00?' }],
        start,
      ),
    ).toBe(false);
  });

  it('ignores a same-turn booking question after the yes', () => {
    expect(
      summaryWasAsked(
        [
          { role: 'user', content: 'dump' },
          { role: 'assistant', content: 'Zal ik de beschikbaarheid checken?' },
          { role: 'user', content: 'Ja, dat klopt' },
          { role: 'assistant', content: 'Zal ik boeken om 10:00?' },
        ],
        start,
      ),
    ).toBe(false);
  });
});


function toolCtx(history: ToolContext['conversationHistory'], sessionId = 'sess-confirm'): ToolContext {
  return {
    tenantId: 'ten-1',
    sessionId,
    runId: 'run-1',
    channel: 'widget',
    toolsCalledThisTurn: [],
    dataSource: {} as ToolContext['dataSource'],
    conversationHistory: history,
  };
}

describe('confirmation keys do not cross kinds', () => {
  beforeEach(() => {
    store.clear();
    redis.get.mockClear();
    redis.set.mockClear();
    redis.del.mockClear();
  });

  it('fails open when the customer has not said anything yet', async () => {
    const refused = await refuseUnlessRescheduleConfirmed(
      { bookingId: 'bk-1', newStartTime: '2026-06-10T10:00:00' },
      toolCtx([]),
    );
    expect(refused).toBeNull();
  });

  it('a pending create does not satisfy a reschedule yes', async () => {
    await putPendingBooking('sess-confirm', {
      startTime: '2026-06-10T10:00',
      attendeeName: 'Ada',
      serviceId: 'svc-1',
      runId: 'run-1',
      kind: 'create',
    });
    const history = [
      { role: 'assistant' as const, content: 'Zal ik de afspraak verzetten naar 10:00?' },
      { role: 'user' as const, content: 'Ja, dat klopt' },
    ];
    const refused = await refuseUnlessRescheduleConfirmed(
      { bookingId: 'bk-1', newStartTime: '2026-06-10T10:00:00' },
      toolCtx(history),
    );
    expect(refused?.error).toMatch(CONFIRMATION_REQUIRED);
    expect(store.has('booking:confirm:sess-confirm')).toBe(true);
    expect(store.has('booking:confirm-reschedule:sess-confirm')).toBe(true);
  });

  it('a pending reschedule does not satisfy a create yes', async () => {
    const first = await refuseUnlessRescheduleConfirmed(
      { bookingId: 'bk-1', newStartTime: '2026-06-10T10:00:00' },
      toolCtx([{ role: 'user', content: 'verzetten naar 10:00' }]),
    );
    expect(first?.error).toMatch(CONFIRMATION_REQUIRED);

    const history = [
      { role: 'assistant' as const, content: 'Zal ik boeken om 10:00?' },
      { role: 'user' as const, content: 'Ja, dat klopt' },
    ];
    const refused = await refuseUnlessConfirmed(
      { startTime: '2026-06-10T10:00:00', attendeeName: 'Ada', serviceId: 'svc-1' },
      toolCtx(history),
    );
    expect(refused?.error).toMatch(CONFIRMATION_REQUIRED);
    expect(store.has('booking:confirm-reschedule:sess-confirm')).toBe(true);
    expect(store.has('booking:confirm:sess-confirm')).toBe(true);
  });

  it('a pending create does not satisfy a cancel yes', async () => {
    await putPendingBooking('sess-confirm', {
      startTime: '2026-06-10T10:00',
      attendeeName: 'Ada',
      serviceId: 'svc-1',
      runId: 'run-1',
    });
    const refused = await refuseUnlessCancelConfirmed(
      { bookingId: 'bk-1' },
      toolCtx([{ role: 'user', content: 'Ja, dat klopt' }]),
    );
    expect(refused?.error).toMatch(CONFIRMATION_REQUIRED);
  });
});
