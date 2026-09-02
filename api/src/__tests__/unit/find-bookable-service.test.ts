import { describe, it, expect, beforeEach, vi } from 'vitest';

const findOne = vi.fn();
const find = vi.fn();

vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: vi.fn(() => ({ findOne, find })),
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { findBookableService } from '../../booking/booking-providers/find-bookable-service';

const BOT = 'bot-1';
const UUID = '550e8400-e29b-41d4-a716-446655440000';
const NEEDS_EMAIL = {
  id: UUID,
  botId: BOT,
  isActive: true,
  onlineBookable: true,
  customerEmailRequired: true,
  name: 'klantenafspraak',
};

describe('findBookableService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws SERVICE_NOT_FOUND for an unknown UUID', async () => {
    findOne.mockResolvedValue(null);
    await expect(findBookableService(BOT, UUID)).rejects.toMatchObject({ code: 'SERVICE_NOT_FOUND' });
    expect(findOne).toHaveBeenCalledWith({
      where: { id: UUID, botId: BOT, isActive: true, onlineBookable: true },
    });
  });

  it('throws SERVICE_NOT_FOUND for a non-UUID serviceId without querying', async () => {
    await expect(findBookableService(BOT, 'klantenafspraak')).rejects.toMatchObject({ code: 'SERVICE_NOT_FOUND' });
    expect(findOne).not.toHaveBeenCalled();
  });

  it('returns the sole online-bookable service when serviceId is omitted', async () => {
    find.mockResolvedValue([NEEDS_EMAIL]);
    await expect(findBookableService(BOT)).resolves.toBe(NEEDS_EMAIL);
  });

  it('throws SERVICE_REQUIRED when more than one service is bookable and none is named', async () => {
    find.mockResolvedValue([NEEDS_EMAIL, { ...NEEDS_EMAIL, id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }]);
    await expect(findBookableService(BOT)).rejects.toMatchObject({ code: 'SERVICE_REQUIRED' });
  });
});
