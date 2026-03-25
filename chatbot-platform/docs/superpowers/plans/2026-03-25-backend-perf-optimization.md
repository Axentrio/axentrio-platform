# Backend Performance Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate per-request overhead across the API — consolidate dashboard queries, cache encryption keys, add Redis caching, parallelize independent queries, batch writes.

**Architecture:** Surgical changes to 6 files in the existing Express + TypeORM + PostgreSQL + Redis stack. No new dependencies. One new utility file (`cache.ts`). No test framework exists, so verification is via TypeScript compilation + manual endpoint testing.

**Tech Stack:** Express, TypeORM, PostgreSQL (FILTER syntax), Redis (ioredis), Node.js crypto

**Spec:** `docs/superpowers/specs/2026-03-25-backend-perf-optimization.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/utils/cache.ts` | Create | Redis cache wrapper (`cached()`, `invalidate()`) |
| `src/utils/encryption.ts` | Modify (line 17-21) | Memoize `getKey()` |
| `src/database/entities/Message.ts` | Modify (lines 112-128) | Add `_decryptedCache` to content getter/setter |
| `src/routes/analytics.routes.ts` | Modify (lines 23-129) | Rewrite dashboard handler with 2 consolidated parallel queries + cache |
| `src/routes/chat.routes.ts` | Modify (lines 96-172, 178-222) | Transaction batching for message send, subquery for unread count |
| `src/routes/agents.routes.ts` | Modify (lines 23-73, 126-187, 236-274) | Wrap agent list in cache, invalidate on status change and create |

---

### Task 1: Memoize Encryption Key

**Files:**
- Modify: `src/utils/encryption.ts:17-21`

- [ ] **Step 1: Memoize `getKey()` function**

In `src/utils/encryption.ts`, replace lines 17-21:

```typescript
// Current:
const getKey = (): Buffer => {
  const keyString = config.encryption.key;
  return crypto.createHash('sha256').update(keyString).digest();
};
```

With:

```typescript
let _cachedKey: Buffer | null = null;

const getKey = (): Buffer => {
  if (_cachedKey) return _cachedKey;
  const keyString = config.encryption.key;
  _cachedKey = crypto.createHash('sha256').update(keyString).digest();
  return _cachedKey;
};
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd chatbot-platform/api && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/utils/encryption.ts
git commit -m "perf: memoize encryption key derivation"
```

---

### Task 2: Add Decryption Cache to Message Entity

**Files:**
- Modify: `src/database/entities/Message.ts:112-128`

- [ ] **Step 1: Add `_decryptedCache` field and update getter**

In `src/database/entities/Message.ts`, replace the content getter (lines 112-123):

```typescript
// Current:
  get content(): string {
    if (this.contentEncrypted && this._content) {
      try {
        return decrypt(this._content);
      } catch (error) {
        console.error('Failed to decrypt message content:', error);
        return '[Encrypted Message]';
      }
    }
    return this._content;
  }
```

With:

```typescript
  private _decryptedCache: string | null = null;

  get content(): string {
    if (this.contentEncrypted && this._content) {
      if (this._decryptedCache !== null) return this._decryptedCache;
      try {
        this._decryptedCache = decrypt(this._content);
        return this._decryptedCache;
      } catch (error) {
        console.error('Failed to decrypt message content:', error);
        return '[Encrypted Message]';
      }
    }
    return this._content;
  }
```

- [ ] **Step 2: Update content setter to clear cache**

Replace the content setter (lines 125-128):

```typescript
// Current:
  set content(value: string) {
    this._content = value;
  }
```

With:

```typescript
  set content(value: string) {
    this._content = value;
    this._decryptedCache = null;
  }
```

- [ ] **Step 3: Clear cache in `edit()` method**

In the `edit()` method (line 164), add cache clearing after `this._content = newContent;`:

```typescript
  edit(newContent: string): void {
    this._content = newContent;
    this._decryptedCache = null;
    this.contentEncrypted = false;
    this.metadata = {
      ...this.metadata,
      edited: true,
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd chatbot-platform/api && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/database/entities/Message.ts
git commit -m "perf: cache decrypted message content per entity instance"
```

---

### Task 3: Create Redis Cache Utility

**Files:**
- Create: `src/utils/cache.ts`

- [ ] **Step 1: Create `src/utils/cache.ts`**

```typescript
/**
 * Redis Cache Utility
 * Simple cache-aside pattern with graceful Redis degradation
 */
import { getRedisClient } from '../config/redis';

/**
 * Cache-aside wrapper: check Redis first, fall back to fn(), store result.
 * Degrades gracefully if Redis is unavailable.
 */
export async function cached<T>(
  key: string,
  ttlSeconds: number,
  fn: () => Promise<T>
): Promise<T> {
  const redis = getRedisClient();

  if (redis) {
    try {
      const hit = await redis.get(key);
      if (hit) return JSON.parse(hit) as T;
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

/**
 * Delete specific cache keys. Takes exact keys (not patterns)
 * to avoid the O(N) KEYS command.
 */
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

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd chatbot-platform/api && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/utils/cache.ts
git commit -m "feat: add Redis cache utility with graceful degradation"
```

---

### Task 4: Consolidate Dashboard Queries + Add Cache

**Files:**
- Modify: `src/routes/analytics.routes.ts:23-129`

This is the highest-impact change: 7+ sequential queries → 2 parallel queries, wrapped in a 30s Redis cache.

- [ ] **Step 1: Add imports at top of `analytics.routes.ts`**

After the existing imports (line 10), add:

```typescript
import { cached } from '../utils/cache';
```

- [ ] **Step 2: Rewrite the dashboard handler**

Replace the entire handler body (lines 25-128) with:

```typescript
  async (req: Request, res: Response): Promise<void> => {
    try {
      const authReq = req as ProvisionedRequest;
      const tenantId = authReq.user?.tenantId;

      const dashboard = await cached(
        `dashboard:${tenantId}`,
        30,
        async () => {
          // Two consolidated queries run in parallel
          const [sessionStats, agentStats] = await Promise.all([
            // Query 1: All session counts + CSAT in one pass
            sessionRepository
              .createQueryBuilder('s')
              .select('COUNT(*)', 'total')
              .addSelect("COUNT(*) FILTER (WHERE s.status = 'active')", 'active')
              .addSelect("COUNT(*) FILTER (WHERE s.status = 'waiting')", 'waiting')
              .addSelect("COUNT(*) FILTER (WHERE s.status = 'handoff')", 'handoff')
              .addSelect("COUNT(*) FILTER (WHERE s.status = 'bot')", 'bot')
              .addSelect("COUNT(*) FILTER (WHERE s.status = 'closed')", 'closed')
              .addSelect("COUNT(*) FILTER (WHERE s.status = 'closed' AND s.assigned_agent_id IS NOT NULL)", 'humanResolved')
              .addSelect('AVG(s.satisfaction_rating) FILTER (WHERE s.satisfaction_rating IS NOT NULL)', 'csatAvg')
              .addSelect('COUNT(s.satisfaction_rating)', 'csatCount')
              .where('s.tenant_id = :tenantId', { tenantId })
              .getRawOne(),

            // Query 2: Agent counts + avg response time in one pass
            agentRepository
              .createQueryBuilder('a')
              .select('COUNT(*)', 'total')
              .addSelect("COUNT(*) FILTER (WHERE a.status = 'online')", 'online')
              .addSelect('AVG(a.avg_response_time_seconds)', 'avgResponseTime')
              .where('a.tenant_id = :tenantId', { tenantId })
              .getRawOne(),
          ]);

          const closed = parseInt(sessionStats?.closed || '0');
          const humanResolved = parseInt(sessionStats?.humanResolved || '0');
          const botResolved = closed - humanResolved;
          const csatAvg = sessionStats?.csatAvg ? parseFloat(parseFloat(sessionStats.csatAvg).toFixed(1)) : null;
          const botResolutionRate = closed > 0 ? Math.round((botResolved / closed) * 100) : null;

          return {
            sessions: {
              total: parseInt(sessionStats?.total || '0'),
              active: parseInt(sessionStats?.active || '0'),
              waiting: parseInt(sessionStats?.waiting || '0'),
              handoff: parseInt(sessionStats?.handoff || '0'),
              bot: parseInt(sessionStats?.bot || '0'),
            },
            agents: {
              total: parseInt(agentStats?.total || '0'),
              online: parseInt(agentStats?.online || '0'),
            },
            avgResponseTimeSeconds: Math.round(parseFloat(agentStats?.avgResponseTime || '0')),
            csatScore: csatAvg,
            botResolutionRate,
          };
        }
      );

      res.json({ success: true, dashboard });
    } catch (error) {
      logger.error('Error fetching dashboard metrics:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd chatbot-platform/api && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Verify endpoint works**

Start the dev server and hit:
```bash
curl http://localhost:4081/api/v1/analytics/dashboard -H "Authorization: Bearer <token>"
```
Expected: Same JSON structure as before with `success: true` and `dashboard` object.

- [ ] **Step 5: Commit**

```bash
git add src/routes/analytics.routes.ts
git commit -m "perf: consolidate dashboard to 2 parallel queries with 30s Redis cache"
```

---

### Task 5: Transaction Batching for Message Send

**Files:**
- Modify: `src/routes/chat.routes.ts:128-159`

- [ ] **Step 1: Add AppDataSource import if not present**

Check the top of `chat.routes.ts` for `AppDataSource` import. It should already be imported. If not, add:

```typescript
import { AppDataSource } from '../database/data-source';
```

- [ ] **Step 2: Wrap message save + session update in transaction**

In the `POST /:sessionId/message` handler, replace lines 128-159 (from `// Save message` through the n8n forwarding):

```typescript
      // Save message + update session in a single transaction
      const message = messageRepository.create({
        sessionId,
        tenantId: tenantId!,
        participantId: user?.id || 'anonymous',
        type,
        content: content.trim(),
        metadata: metadata || undefined,
      } as any);

      const savedMessage = await AppDataSource.transaction(async (manager) => {
        const msg = await manager.save(message) as unknown as Message;
        session.updateActivity();
        await manager.save(session);
        return msg;
      });

      // Emit and forward AFTER transaction commits
      const messageData = {
        id: savedMessage.id,
        type: savedMessage.type,
        content: savedMessage.content,
        status: savedMessage.status,
        createdAt: savedMessage.createdAt,
        timestamp: new Date().toISOString(),
      };

      emitToSession(tenantId!, sessionId, 'message:receive', messageData);

      forwardMessageToN8n(session, savedMessage).catch((err) => {
        logger.error('Error in n8n message forwarding:', err);
      });
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd chatbot-platform/api && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/routes/chat.routes.ts
git commit -m "perf: batch message save + session update in transaction"
```

---

### Task 6: Combine Session Status + Unread Count Query

**Files:**
- Modify: `src/routes/chat.routes.ts:178-222`

- [ ] **Step 1: Add Message import if not present**

Check the top of `chat.routes.ts` for `Message` entity import. If missing, add:

```typescript
import { Message } from '../database/entities/Message';
```

- [ ] **Step 2: Replace the status handler with subquery approach**

Replace the handler body (lines 182-221) with:

```typescript
  async (req: TenantRequest, res: Response): Promise<void> => {
    try {
      const { sessionId } = req.params;
      const tenantId = req.tenant?.id;

      // Single query: session + unread count via subquery
      const result = await sessionRepository
        .createQueryBuilder('s')
        .leftJoinAndSelect('s.assignedAgent', 'agent')
        .addSelect((qb) =>
          qb.select('COUNT(*)')
            .from(Message, 'm')
            .where('m.session_id = s.id')
            .andWhere("m.status = 'sent'"),
          'unreadCount'
        )
        .where('s.id = :sessionId', { sessionId })
        .andWhere('s.tenant_id = :tenantId', { tenantId })
        .getRawAndEntities();

      const session = result.entities[0];
      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      const unreadCount = parseInt(result.raw[0]?.unreadCount || '0');

      res.json({
        success: true,
        session: {
          id: session.id,
          status: session.status,
          assignedAgent: session.assignedAgent
            ? { id: session.assignedAgent.id }
            : null,
          lastActivityAt: session.lastActivityAt,
          createdAt: session.createdAt,
        },
        unreadCount,
      });
    } catch (error) {
      logger.error('Error fetching session status:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd chatbot-platform/api && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/routes/chat.routes.ts
git commit -m "perf: combine session status + unread count into single query"
```

---

### Task 7: Add Redis Caching to Agent List + Invalidation

**Files:**
- Modify: `src/routes/agents.routes.ts:23-73, 167-169, 258-259`

- [ ] **Step 1: Add cache imports**

At the top of `agents.routes.ts`, add:

```typescript
import { cached, invalidate } from '../utils/cache';
```

- [ ] **Step 2: Wrap agent list query in cache**

In the `GET /` handler (lines 38-44), wrap the `findAndCount` in `cached()`. Note: only cache when no status filter is applied (filtered results are less cacheable):

Replace lines 38-66 (from `const [agents, total]` through the response):

```typescript
      // Only cache the default (unfiltered, first page) request
      const isDefaultRequest = !status && offset === 0 && limit === 20;
      const cacheKey = isDefaultRequest ? `agents:${tenantId}` : null;

      const getData = async () => {
        const [agents, total] = await agentRepository.findAndCount({
          where,
          relations: ['user'],
          order: { createdAt: 'DESC' },
          take: limit,
          skip: offset,
        });

        return {
          agents: agents.map((a) => ({
            id: a.id,
            name: a.user?.name,
            email: a.user?.email,
            role: a.user?.role,
            status: a.status,
            maxConcurrentChats: a.maxConcurrentChats,
            currentChatCount: a.currentChatCount,
            skills: a.skills,
            languages: a.languages,
            lastActiveAt: a.lastActiveAt,
            createdAt: a.createdAt,
          })),
          pagination: {
            total,
            limit,
            offset,
            hasMore: offset + limit < total,
          },
        };
      };

      const result = cacheKey
        ? await cached(cacheKey, 60, getData)
        : await getData();

      res.json({ success: true, ...result });
```

- [ ] **Step 3: Invalidate cache on agent create**

In the `POST /` handler, after `const saved = await agentRepository.save(agent);` (line 167), add:

```typescript
      await invalidate(`agents:${tenantId}`);
```

- [ ] **Step 4: Invalidate cache on agent status change**

In the `PATCH /:id/status` handler, after `await agentRepository.save(agent);` (line 259), add:

```typescript
      await invalidate(`agents:${authReq.user?.tenantId}`);
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `cd chatbot-platform/api && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/routes/agents.routes.ts
git commit -m "perf: add 60s Redis cache to agent list with invalidation"
```

---

## Verification

After all tasks are complete:

- [ ] **Full TypeScript compilation**: `cd chatbot-platform/api && npx tsc --noEmit` — expect 0 errors
- [ ] **Dev server starts**: `npm run dev` — expect no crash
- [ ] **Dashboard endpoint responds**: `curl localhost:4081/api/v1/analytics/dashboard` — expect `{ success: true, dashboard: { ... } }`
- [ ] **Second dashboard call is faster** (served from Redis cache for 30s)
