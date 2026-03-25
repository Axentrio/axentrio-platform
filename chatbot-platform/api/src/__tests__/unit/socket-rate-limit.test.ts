import { describe, it, expect } from 'vitest';
import { checkEventRateLimit } from '../../websocket/socket-rate-limit';

describe('checkEventRateLimit', () => {
  it('should allow requests under the limit', async () => {
    const result = await checkEventRateLimit('socket-1', 'tenant-1', 'message:send');
    expect(result.allowed).toBe(true);
  });

  it('should block after exceeding limit', async () => {
    // message:send allows 30 requests per 60s window
    for (let i = 0; i < 30; i++) {
      await checkEventRateLimit('socket-flood', 'tenant-1', 'message:send');
    }
    const result = await checkEventRateLimit('socket-flood', 'tenant-1', 'message:send');
    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBeGreaterThan(0);
  });

  it('should use separate limits per event type', async () => {
    for (let i = 0; i < 30; i++) {
      await checkEventRateLimit('socket-multi', 'tenant-1', 'message:send');
    }
    const result = await checkEventRateLimit('socket-multi', 'tenant-1', 'typing:indicator');
    expect(result.allowed).toBe(true);
  });

  it('should use separate limits per socket id', async () => {
    for (let i = 0; i < 30; i++) {
      await checkEventRateLimit('socket-a', 'tenant-1', 'message:send');
    }
    const result = await checkEventRateLimit('socket-b', 'tenant-1', 'message:send');
    expect(result.allowed).toBe(true);
  });

  it('should use separate limits per tenant', async () => {
    for (let i = 0; i < 30; i++) {
      await checkEventRateLimit('socket-t', 'tenant-x', 'message:send');
    }
    const result = await checkEventRateLimit('socket-t', 'tenant-y', 'message:send');
    expect(result.allowed).toBe(true);
  });

  it('should apply default limit for unknown event types', async () => {
    const result = await checkEventRateLimit('socket-unk', 'tenant-1', 'unknown:event');
    expect(result.allowed).toBe(true);
  });
});
