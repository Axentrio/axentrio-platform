// Redis-backed LoopStateStore for bot-loop detection counters.
//
// The gate runs at ingress (scheduleTurn / forwardMessageToN8n), OUTSIDE any
// agent lock, so concurrent burst messages on one session could race a
// get→modify→set. `advance` is therefore an ATOMIC Lua read-modify-write that
// mirrors `advanceLoopState` in loop-detector.ts (keep the two in lockstep).
// Counters are ephemeral (1h TTL); losing them at worst re-arms a loop
// (fail-open). The durable record of a fired loop is SpamScamLog.

import { getRedisClient } from '../config/redis';
import { LoopSignal, LoopState, LoopStateStore, EMPTY_LOOP_STATE } from './loop-detector';

const key = (sessionId: string): string => `gr:loop:${sessionId}`;
const TTL_MS = 60 * 60 * 1000; // 1 hour

// Atomic counter advance — mirrors advanceLoopState(): identical message ⇒
// repeated++ (else reset to 1); repeat OR non-meaningful ⇒ botLike++ (else 0);
// suspicious link ⇒ susp++. Returns [repeated, botLike, susp].
const ADVANCE_LUA = `
local k = KEYS[1]
local hash = ARGV[1]
local meaningful = ARGV[2] == '1'
local hasLink = ARGV[3] == '1'
local ttl = tonumber(ARGV[4])
local lastHash = redis.call('HGET', k, 'lastHash')
local repeated = tonumber(redis.call('HGET', k, 'repeated') or '0')
local botLike = tonumber(redis.call('HGET', k, 'botLike') or '0')
local susp = tonumber(redis.call('HGET', k, 'susp') or '0')
local isRepeat = (lastHash == hash)
if isRepeat then repeated = repeated + 1 else repeated = 1 end
if isRepeat or (not meaningful) then botLike = botLike + 1 else botLike = 0 end
if hasLink then susp = susp + 1 end
redis.call('HSET', k, 'lastHash', hash, 'repeated', repeated, 'botLike', botLike, 'susp', susp)
redis.call('PEXPIRE', k, ttl)
return {repeated, botLike, susp}
`;

export const redisLoopStore: LoopStateStore = {
  async advance(sessionId: string, signal: LoopSignal): Promise<LoopState> {
    const redis = getRedisClient();
    if (!redis) return EMPTY_LOOP_STATE; // fail open — no loop detection without Redis
    try {
      const res = (await redis.eval(
        ADVANCE_LUA,
        1,
        key(sessionId),
        signal.hash || '',
        signal.meaningful ? '1' : '0',
        signal.hasSuspiciousLink ? '1' : '0',
        String(TTL_MS),
      )) as [number, number, number];
      return {
        lastHash: signal.hash,
        repeated: Number(res[0]),
        botLike: Number(res[1]),
        suspiciousLinkTurns: Number(res[2]),
      };
    } catch {
      return EMPTY_LOOP_STATE; // fail open
    }
  },
  async clear(sessionId: string): Promise<void> {
    const redis = getRedisClient();
    if (!redis) return;
    try {
      await redis.del(key(sessionId));
    } catch {
      // ignore
    }
  },
};
