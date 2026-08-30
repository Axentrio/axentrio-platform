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
import { slotChipQuickReply } from '../../config/bot-language';
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

  it('accepts the exact NL and FR chips the bot issues', () => {
    // 07:00Z is 09:00 Europe/Amsterdam on 7 April 2026 (CEST). The pending
    // hour is the local wall clock the chip names, same as booking.tool.
    const startIso = '2026-04-07T07:00:00.000Z';
    const tz = 'Europe/Amsterdam';
    const pendingLocal = '2026-04-07T09:00:00';
    const nl = slotChipQuickReply(startIso, tz, 'nl', 'Lekdetectie');
    const fr = slotChipQuickReply(startIso, tz, 'fr');
    expect(nl.value).toBe('Boek Lekdetectie op dinsdag 7 april om 09:00');
    expect(fr.title).toBe('mar. 09:00');
    expect(isConfirmingChip(nl.value, pendingLocal)).toBe(true);
    expect(isConfirmingChip(nl.title, pendingLocal)).toBe(true);
    expect(isConfirmingChip(fr.value, pendingLocal)).toBe(true);
    expect(isConfirmingChip(fr.title, pendingLocal)).toBe(true);
  });

  it('rejects those NL and FR chips when they name a different hour', () => {
    const startIso = '2026-04-07T07:00:00.000Z';
    const tz = 'Europe/Amsterdam';
    const otherHour = '2026-04-07T10:00:00';
    const nl = slotChipQuickReply(startIso, tz, 'nl', 'Lekdetectie');
    const fr = slotChipQuickReply(startIso, tz, 'fr');
    expect(isConfirmingChip(nl.value, otherHour)).toBe(false);
    expect(isConfirmingChip(fr.title, otherHour)).toBe(false);
  });

  it('accepts ASCII Reservez, uppercase Boek, and a 12-hour chip', () => {
    const pendingLocal = '2026-04-07T09:00:00';
    expect(isConfirmingChip('Reservez le mardi 7 avril à 09:00', pendingLocal)).toBe(true);
    expect(
      isConfirmingChip('BOEK Lekdetectie op dinsdag 7 april om 09:00', pendingLocal),
    ).toBe(true);
    const ny = slotChipQuickReply('2026-04-07T13:00:00.000Z', 'America/New_York', 'en', 'Haircut');
    expect(ny.title).toBe('Tue 9:00 AM');
    expect(isConfirmingChip(ny.title, pendingLocal)).toBe(true);
    expect(isConfirmingChip(ny.value, pendingLocal)).toBe(true);
  });

  it('rejects empty, questions, over-long payloads, and a booking-prefix false friend', () => {
    const start = '2026-10-26T10:00:00';
    expect(isConfirmingChip('', start)).toBe(false);
    expect(isConfirmingChip('   ', start)).toBe(false);
    expect(isConfirmingChip('Book Tuesday at 10:00?', start)).toBe(false);
    expect(isConfirmingChip('Boek dit om 10:00?', start)).toBe(false);
    expect(isConfirmingChip('booking 10:00', start)).toBe(false);
    const long = `Book ${'x'.repeat(70)} at 10:00`;
    expect(long.length).toBeGreaterThan(80);
    expect(isConfirmingChip(long, start)).toBe(false);
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

describe('tapping a localized slot chip confirms the pending booking', () => {
  beforeEach(() => {
    store.clear();
    redis.get.mockClear();
    redis.set.mockClear();
    redis.del.mockClear();
  });

  const startIso = '2026-04-07T07:00:00.000Z';
  const tz = 'Europe/Amsterdam';
  const pendingLocal = '2026-04-07T09:00';
  const args = {
    startTime: '2026-04-07T09:00:00',
    attendeeName: 'Ada',
    serviceId: 'svc-1',
  };

  async function seed(sessionId: string) {
    await putPendingBooking(sessionId, {
      startTime: pendingLocal,
      attendeeName: 'Ada',
      serviceId: 'svc-1',
      runId: 'run-1',
    });
  }

  it('proceeds when the widget sends the Dutch chip value', async () => {
    const sessionId = 'sess-chip-nl';
    await seed(sessionId);
    const nl = slotChipQuickReply(startIso, tz, 'nl', 'Lekdetectie');
    expect(nl.value).toBe('Boek Lekdetectie op dinsdag 7 april om 09:00');
    const refused = await refuseUnlessConfirmed(
      args,
      toolCtx([{ role: 'user', content: nl.value }], sessionId),
    );
    expect(refused).toBeNull();
    expect(store.has(`booking:confirm:${sessionId}`)).toBe(false);
  });

  it('proceeds when the widget sends the French chip value', async () => {
    const sessionId = 'sess-chip-fr';
    await seed(sessionId);
    const fr = slotChipQuickReply(startIso, tz, 'fr');
    expect(fr.value).toBe('Réservez le mardi 7 avril à 09:00');
    const refused = await refuseUnlessConfirmed(
      args,
      toolCtx([{ role: 'user', content: fr.value }], sessionId),
    );
    expect(refused).toBeNull();
  });

  it('still refuses when the tapped chip names a different hour than the pending slot', async () => {
    const sessionId = 'sess-chip-wrong-hour';
    await seed(sessionId);
    const ten = slotChipQuickReply('2026-04-07T08:00:00.000Z', tz, 'nl', 'Lekdetectie');
    expect(ten.value).toContain('10:00');
    const refused = await refuseUnlessConfirmed(
      args,
      toolCtx([{ role: 'user', content: ten.value }], sessionId),
    );
    expect(refused?.error).toMatch(CONFIRMATION_REQUIRED);
  });
});
