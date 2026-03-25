# Backend Performance Optimization Design Spec

**Date:** 2026-03-25
**Status:** Approved
**Scope:** Fix per-request overhead across the API — query consolidation, encryption caching, Redis caching layer, parallel queries, minor fixes

## Context

The backend is slow across all endpoints despite near-zero data (0 sessions, 0 messages, 1 tenant, 1 agent). The bottleneck is per-request overhead: sequential DB round-trips, repeated key derivation, no caching layer, and unbatched writes.

## Decisions

- **Approach B** — Query patterns + caching layer (not full overhaul)
- **No index changes** — data volume doesn't justify them yet
- **No middleware changes** — dev environment doesn't need middleware optimization
- **No message caching** — encryption makes cache poisoning risky; messages change too frequently

---

## 1. Dashboard Query Consolidation

### Current: 7+ sequential queries

`GET /analytics/dashboard` runs these sequentially:
1. `COUNT(*) FROM chat_sessions` (total)
2. `COUNT(*) FROM chat_sessions WHERE status = 'active'` (active)
3. `COUNT(*) FROM chat_sessions WHERE status = 'waiting'` (waiting)
4. `COUNT(*) FROM chat_sessions WHERE status = 'handoff'` (handoff)
5. `COUNT(*) FROM chat_sessions WHERE status = 'bot'` (bot)
6. `COUNT(*) FROM agents` (total)
7. `COUNT(*) FROM agents WHERE status = 'online'` (online)
8. Loop through all agents in JS to compute avg response time

### Fix: 2 parallel queries with conditional aggregation

**Query 1 — Session stats:**
```sql
SELECT
  COUNT(*) as total,
  COUNT(*) FILTER (WHERE status = 'active') as active,
  COUNT(*) FILTER (WHERE status = 'waiting') as waiting,
  COUNT(*) FILTER (WHERE status = 'handoff') as handoff,
  COUNT(*) FILTER (WHERE status = 'bot') as bot,
  COUNT(*) FILTER (WHERE status = 'closed') as closed,
  COUNT(*) FILTER (WHERE status = 'closed' AND assigned_agent_id IS NOT NULL) as human_resolved,
  AVG(satisfaction_rating) FILTER (WHERE satisfaction_rating IS NOT NULL) as csat_avg,
  COUNT(satisfaction_rating) as csat_count
FROM chat_sessions
WHERE tenant_id = :tenantId
```

Note: The ChatSession entity status enum is `'active' | 'closed' | 'waiting' | 'handoff' | 'bot'`. There is no `'human'` status — `'active'` represents human-handled sessions.

**Query 2 — Agent stats:**
```sql
SELECT
  COUNT(*) as total,
  COUNT(*) FILTER (WHERE status = 'online') as online,
  AVG(avg_response_time_seconds) as avg_response_time
FROM agents
WHERE tenant_id = :tenantId
```

Run both with `Promise.all()`. Result: 7 sequential round-trips → 2 parallel round-trips.

### CSAT and bot resolution

The current code also computes CSAT score and bot resolution rate with additional queries and JS math. Fold CSAT into Query 1 (see above). Bot resolution rate is derived from `closed - human_resolved` counts already in Query 1.

### File affected
- `src/routes/analytics.routes.ts` — rewrite the `/dashboard` handler

---

## 2. Encryption Key Caching

### Current: SHA256 derivation on every call

`encryption.ts` → `getKey()` runs `crypto.createHash('sha256').update(secret).digest()` on every encrypt and decrypt. A chat history load with 50 messages triggers 50 derivations.

### Fix: Memoize at module level

```typescript
let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  cachedKey = crypto.createHash('sha256').update(ENCRYPTION_KEY).digest();
  return cachedKey;
}
```

Safe because the encryption secret is an env var that doesn't change at runtime.

### Message entity decryption cache

The `content` getter on `Message.ts` decrypts on every access. Add an instance-level cache:

```typescript
private _decryptedCache: string | null = null;

get content(): string {
  if (this._decryptedCache !== null) return this._decryptedCache;
  if (this.contentEncrypted && this._content) {
    const decrypted = decrypt(this._content);
    this._decryptedCache = decrypted;
    return decrypted;
  }
  return this._content;
}
```

Clear cache in setter and `editContent()` method.

### Files affected
- `src/utils/encryption.ts` — memoize `getKey()`
- `src/database/entities/Message.ts` — add `_decryptedCache`

---

## 3. Redis Caching Layer

### New utility: `src/utils/cache.ts`

A simple `cached<T>()` wrapper around Redis:

```typescript
import { getRedisClient } from '../config/redis';

export async function cached<T>(
  key: string,
  ttlSeconds: number,
  fn: () => Promise<T>
): Promise<T> {
  const redis = getRedisClient();

  if (redis) {
    try {
      const hit = await redis.get(key);
      if (hit) return JSON.parse(hit);
    } catch {
      // Redis down — fall through to fn()
    }
  }

  const result = await fn();

  if (redis) {
    try {
      await redis.setex(key, ttlSeconds, JSON.stringify(result));
    } catch {
      // Redis down — result still returned, just not cached
    }
  }

  return result;
}

export async function invalidate(...keys: string[]): Promise<void> {
  const redis = getRedisClient();
  if (!redis || keys.length === 0) return;

  try {
    await redis.del(...keys);
  } catch {
    // Redis down — skip invalidation
  }
}
```

Note: `getRedisClient()` returns `Redis | null`. The `invalidate()` function takes exact keys (not patterns) to avoid the `KEYS` command which is O(N) on the entire keyspace.

### What gets cached

| Data | Cache key pattern | TTL | Invalidation trigger |
|------|------------------|-----|---------------------|
| Dashboard metrics | `dashboard:{tenantId}` | 30s | Time-based only |
| Agent list | `agents:{tenantId}` | 60s | Agent status change, agent create/delete |
| Tenant config | `tenant:{tenantId}` | 5min | Tenant update |

### What does NOT get cached
- Messages — change frequently, encrypted content makes stale cache risky
- Chat sessions — status changes in real-time via WebSocket
- Unread counts — must be fresh for UX

### Cache invalidation placement

- `agents.routes.ts` — `PATCH /agents/:id/status`: call `invalidate('agents:{tenantId}')` after save
- `agents.routes.ts` — `POST /agents`: call `invalidate('agents:{tenantId}')` after create
- Dashboard cache (`dashboard:{tenantId}`) relies on 30s TTL only — session mutations (close, transfer) will show stale data for up to 30s, which is acceptable for a monitoring dashboard
- Tenant config invalidation is deferred — no tenant update routes exist yet

### Files affected
- `src/utils/cache.ts` — new file
- `src/routes/analytics.routes.ts` — wrap dashboard query in `cached()`
- `src/routes/agents.routes.ts` — wrap agent list in `cached()`, invalidate on status change and create

---

## 4. Parallel Queries

### Where sequential queries can run in parallel

**Dashboard endpoint** (after consolidation):
```typescript
const [sessionStats, agentStats] = await Promise.all([
  getSessionStats(tenantId),
  getAgentStats(tenantId),
]);
```

**Chat status endpoint** — combine session fetch + unread count into a single query using a subquery:
```typescript
const session = await sessionRepository
  .createQueryBuilder('s')
  .addSelect(
    (qb) => qb.select('COUNT(*)').from(Message, 'm')
      .where('m.sessionId = s.id')
      .andWhere('m.status = :status', { status: 'sent' }),
    'unreadCount'
  )
  .leftJoinAndSelect('s.assignedAgent', 'agent')
  .where('s.id = :id', { id: sessionId })
  .getRawAndEntities();
```

### Files affected
- `src/routes/analytics.routes.ts` — `Promise.all()` on dashboard
- `src/routes/chat.routes.ts` — subquery for unread count in status endpoint

---

## 5. Minor Fixes

### Chat history ordering

**Current** (`chat.routes.ts`): Fetches messages `ORDER BY createdAt DESC`, then reverses in JS with `.reverse()`.

**Keep as-is.** The DESC + reverse pattern is intentional: it fetches the N most recent messages (via `take: limit`), then reverses them into chronological order for display. Changing to ASC would return the N oldest messages instead, breaking pagination semantics.

### Batch message + session save

**Current:** Two separate `repository.save()` calls when sending a message — one for the message, one for session's `lastActivityAt`.

**Fix:** Wrap in a transaction. WebSocket emit and n8n forwarding must happen AFTER the transaction commits (not inside it), so a rollback doesn't leave phantom events:
```typescript
const savedMessage = await AppDataSource.transaction(async (manager) => {
  const msg = await manager.save(Message, message);
  session.lastActivityAt = new Date();
  await manager.save(ChatSession, session);
  return msg;
});
// Only emit/forward after commit succeeds
io.to(...).emit('message:receive', savedMessage);
forwardToN8n(savedMessage);
```

### Files affected
- `src/routes/chat.routes.ts` — transaction batching

---

## Files Summary

| File | Changes |
|------|---------|
| `src/routes/analytics.routes.ts` | Rewrite dashboard handler: 2 consolidated queries, `Promise.all()`, Redis cache |
| `src/utils/encryption.ts` | Memoize `getKey()` |
| `src/database/entities/Message.ts` | Add `_decryptedCache` to content getter |
| `src/utils/cache.ts` | New file — `cached()` and `invalidate()` utilities |
| `src/routes/chat.routes.ts` | Transaction batching, subquery for unread count |
| `src/routes/agents.routes.ts` | Wrap agent list in `cached()`, invalidate on status change |

## Out of Scope

- Database indexes (data volume doesn't justify yet)
- Middleware optimization (dev environment)
- Message caching (encryption + staleness risk)
- Analytics timeseries optimization (already uses GROUP BY efficiently)
- Pagination fixes for agent list (only 1 agent currently)
