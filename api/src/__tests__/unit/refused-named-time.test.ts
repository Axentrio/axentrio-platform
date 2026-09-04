import { describe, it, expect, beforeEach, vi } from 'vitest';

const store = new Map<string, string>();
vi.mock('../../config/redis', () => ({
  getRedisClient: () => ({
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string) => {
      store.set(k, v);
      return 'OK';
    },
    del: async (k: string) => {
      store.delete(k);
      return 1;
    },
  }),
}));

import {
  rememberRefusedNamedTime,
  peekRefusedNamedTime,
  customerMovedOffRefusedDate,
  refusedNamedTimeStillApplies,
} from '../../agent/refused-named-time';

const REFUSED = { localDate: '2026-11-02', clock: '10:00' };

describe('customerMovedOffRefusedDate', () => {
  it('stays on a bare ja', () => {
    expect(customerMovedOffRefusedDate('ja', REFUSED)).toBe(false);
  });

  it('stays on the refused calendar date', () => {
    expect(customerMovedOffRefusedDate('Is maandag 2 november 2026 om 10:00 vrij?', REFUSED)).toBe(false);
  });

  it('leaves for a different calendar date', () => {
    expect(customerMovedOffRefusedDate('Boek klantenafspraak op maandag 26 oktober om 09:30', REFUSED)).toBe(true);
  });

  it('leaves for a different weekday', () => {
    expect(customerMovedOffRefusedDate('dinsdag dan', REFUSED)).toBe(true);
  });
});

describe('refusedNamedTimeStillApplies', () => {
  beforeEach(() => store.clear());

  it('is true after a horizon refusal until the customer names another day', async () => {
    await rememberRefusedNamedTime('sess-1', '2026-11-02', '10:00');
    expect(await peekRefusedNamedTime('sess-1')).toEqual(REFUSED);
    expect(await refusedNamedTimeStillApplies('sess-1', 'ja')).toBe(true);
    expect(await refusedNamedTimeStillApplies('sess-1', 'dinsdag dan')).toBe(false);
    expect(await peekRefusedNamedTime('sess-1')).toBeNull();
  });
});
