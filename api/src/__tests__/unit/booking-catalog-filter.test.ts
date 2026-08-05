/**
 * The catalog the model reads must be the catalog it can actually book.
 *
 * `resolveService` has always required `isActive AND onlineBookable`. The prompt block that
 * lists services to the model filtered on `isActive` alone — the only consumer that omitted
 * it. So a service an owner had deliberately hidden from online booking was still described
 * to the bot, offered to a customer, chosen by them, and only then thrown out as
 * SERVICE_NOT_FOUND at book time. The customer experiences that as the assistant advertising
 * something and then failing to sell it.
 *
 * Nothing pinned the filter, which is why the two drifted apart in the first place.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const serviceFind = vi.fn(async (_opts?: any): Promise<any[]> => []);
const ruleFindOne = vi.fn(async () => null);
const settingsFindOne = vi.fn(async () => null);

vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: (entity: any) => {
      const name = entity?.name ?? entity;
      if (name === 'ServiceType') return { find: serviceFind };
      if (name === 'AvailabilityRule') return { findOne: ruleFindOne };
      if (name === 'BookingSettings') return { findOne: settingsFindOne };
      return { find: vi.fn(async () => []), findOne: vi.fn(async () => null) };
    },
  },
}));
vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { bookingModule } from '../../modules/booking.module';

const CTX = { tenantId: 'ten-1', botId: 'bot-1', config: {} };

describe('booking prompt catalog — service filter', () => {
  beforeEach(() => vi.clearAllMocks());

  it('asks for onlineBookable services, not merely active ones', async () => {
    await bookingModule.buildPromptSection!(CTX);
    expect(serviceFind).toHaveBeenCalledOnce();
    expect(serviceFind.mock.calls[0]![0]).toMatchObject({
      where: { botId: 'bot-1', isActive: true, onlineBookable: true },
    });
  });

  it('matches the filter resolveService enforces at book time', async () => {
    // If these two ever disagree again, the prompt advertises something that 404s.
    await bookingModule.buildPromptSection!(CTX);
    const where = (serviceFind.mock.calls[0]![0] as any).where;
    expect(where.isActive).toBe(true);
    expect(where.onlineBookable).toBe(true);
  });

  it('still scopes to the bot', async () => {
    await bookingModule.buildPromptSection!(CTX);
    expect((serviceFind.mock.calls[0]![0] as any).where.botId).toBe('bot-1');
  });
});
