import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MeteringService } from '../../agent/metering.service';

// Mock Redis
const mockHincrby = vi.fn().mockResolvedValue(1);
const mockHgetall = vi.fn().mockResolvedValue({ prompt: '100', completion: '50', total: '150', calls: '2' });
const mockExpireat = vi.fn().mockResolvedValue(1);

const mockRedis = {
  hincrby: mockHincrby,
  hgetall: mockHgetall,
  expireat: mockExpireat,
};

describe('MeteringService', () => {
  let metering: MeteringService;

  beforeEach(() => {
    metering = new MeteringService(mockRedis as any);
    vi.clearAllMocks();
  });

  it('records token usage to Redis', async () => {
    await metering.record('tenant-1', { promptTokens: 50, completionTokens: 20 });
    expect(mockHincrby).toHaveBeenCalledTimes(4); // prompt, completion, total, calls
  });

  it('generates correct Redis key with date', async () => {
    await metering.record('tenant-1', { promptTokens: 10, completionTokens: 5 });
    const today = new Date().toISOString().split('T')[0];
    expect(mockHincrby.mock.calls[0][0]).toBe(`tokens:tenant-1:${today}`);
  });
});
