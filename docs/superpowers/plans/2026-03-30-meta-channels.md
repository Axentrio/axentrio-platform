# Meta Channels (Messenger + Instagram) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Facebook Messenger and Instagram DM channels via a single Meta App with OAuth, building on the existing channel abstraction layer.

**Architecture:** Dedicated Meta webhook route (raw body, HMAC verification) mounted before express.json(). Shared event normalizer for both channels. Separate outbound transports with different capabilities and API endpoints. OAuth flow for tenant onboarding. Portal settings page for channel management.

**Tech Stack:** Express (raw body), axios (Meta Graph API), jsonwebtoken (OAuth state), existing TypeORM entities, React + TanStack Query (portal).

**Spec:** `docs/superpowers/specs/2026-03-30-meta-channels-design.md`

---

### Task 1: Environment Config + Database Migration

**Files:**
- Modify: `api/src/config/environment.ts`
- Create: `api/src/database/migrations/1775600000000-AddMetaChannelSupport.ts`
- Modify: `api/src/database/entities/ConversationBinding.ts`

- [ ] **Step 1: Add Meta environment variables**

In `api/src/config/environment.ts`, add to the Zod schema (in `envSchema` object):

```typescript
META_APP_ID: z.string().optional(),
META_APP_SECRET: z.string().optional(),
META_VERIFY_TOKEN: z.string().optional(),
META_OAUTH_REDIRECT_URI: z.string().optional(),
META_OAUTH_JWT_SECRET: z.string().optional(),
```

And in the exported `config` object, add a `meta` section:

```typescript
meta: {
  appId: env.META_APP_ID || '',
  appSecret: env.META_APP_SECRET || '',
  verifyToken: env.META_VERIFY_TOKEN || '',
  oauthRedirectUri: env.META_OAUTH_REDIRECT_URI || '',
  oauthJwtSecret: env.META_OAUTH_JWT_SECRET || '',
},
```

- [ ] **Step 2: Add lastInboundAt to ConversationBinding entity**

In `api/src/database/entities/ConversationBinding.ts`, add before `@CreateDateColumn()`:

```typescript
  @Column({ type: 'timestamp', nullable: true })
  lastInboundAt!: Date | null;
```

- [ ] **Step 3: Create migration**

Create `api/src/database/migrations/1775600000000-AddMetaChannelSupport.ts`:

```typescript
import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMetaChannelSupport1775600000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Partial unique index for Meta channels only
    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_channel_conn_platform_channel_meta"
      ON "channel_connections" ("platformAccountId", "channel")
      WHERE "channel" IN ('messenger', 'instagram')
    `);

    // Add lastInboundAt to conversation_bindings
    await queryRunner.query(`
      ALTER TABLE "conversation_bindings"
      ADD COLUMN "lastInboundAt" timestamp
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "conversation_bindings" DROP COLUMN IF EXISTS "lastInboundAt"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_channel_conn_platform_channel_meta"`);
  }
}
```

- [ ] **Step 4: Verify compilation**

```bash
cd chatbot-platform/api && npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 5: Commit**

```bash
git add api/src/config/environment.ts api/src/database/entities/ConversationBinding.ts \
  api/src/database/migrations/1775600000000-AddMetaChannelSupport.ts
git commit -m "feat: add Meta env config and migration for channel support"
```

---

### Task 2: Meta Credential Helpers + Connection Resolver

**Files:**
- Modify: `api/src/channels/credential-utils.ts`
- Create: `api/src/channels/meta/connection-resolver.ts`

- [ ] **Step 1: Add Meta credential helpers**

In `api/src/channels/credential-utils.ts`, add:

```typescript
/**
 * Get the page access token from a Meta (Messenger/Instagram) connection, decrypting it.
 */
export function getMetaPageAccessToken(credentials: Record<string, unknown>): string | null {
  const token = credentials.pageAccessToken as string | undefined;
  if (!token) return null;
  return decryptCredential(token, true);
}
```

- [ ] **Step 2: Create Meta connection resolver**

Create `api/src/channels/meta/connection-resolver.ts`:

```typescript
import { AppDataSource } from '../../database/data-source';
import { ChannelConnection, ChannelType } from '../../database/entities/ChannelConnection';
import { logger } from '../../utils/logger';

/**
 * Resolve a ChannelConnection by platform account ID and channel type.
 * For Messenger: platformAccountId = Page ID
 * For Instagram: platformAccountId = IG Business Account ID
 */
export async function resolveMetaConnection(
  recipientId: string,
  channel: 'messenger' | 'instagram',
): Promise<ChannelConnection | null> {
  const repo = AppDataSource.getRepository(ChannelConnection);
  const connection = await repo.findOne({
    where: {
      platformAccountId: recipientId,
      channel: channel as ChannelType,
      status: 'active',
    },
  });

  if (!connection) {
    logger.warn(`[meta] No active ${channel} connection for recipient ${recipientId}`);
  }

  return connection;
}
```

- [ ] **Step 3: Verify and commit**

```bash
cd chatbot-platform/api && npx tsc --noEmit 2>&1 | head -20
git add api/src/channels/credential-utils.ts api/src/channels/meta/connection-resolver.ts
git commit -m "feat: add Meta credential helpers and connection resolver"
```

---

### Task 3: Meta Event Normalizer

**Files:**
- Create: `api/src/channels/meta/event-normalizer.ts`

- [ ] **Step 1: Create the normalizer**

Create `api/src/channels/meta/event-normalizer.ts`:

```typescript
import { NormalizedEvent } from '../types';
import crypto from 'crypto';

// --- Meta webhook types ---

interface MetaWebhookPayload {
  object: 'page' | 'instagram';
  entry: MetaEntry[];
}

interface MetaEntry {
  id: string;
  time: number;
  messaging?: MetaMessagingEvent[];
}

interface MetaMessagingEvent {
  sender: { id: string };
  recipient: { id: string };
  timestamp: number;
  message?: MetaMessage;
  postback?: MetaPostback;
  delivery?: MetaDelivery;
  read?: MetaRead;
  referral?: MetaReferral;
  reaction?: MetaReaction;
}

interface MetaMessage {
  mid: string;
  text?: string;
  attachments?: MetaAttachment[];
  quick_reply?: { payload: string };
  is_echo?: boolean;
  reply_to?: { mid: string };
}

interface MetaAttachment {
  type: 'image' | 'video' | 'audio' | 'file' | 'fallback' | 'template';
  payload?: {
    url?: string;
    sticker_id?: number;
  };
}

interface MetaPostback {
  title: string;
  payload: string;
  mid?: string;
}

interface MetaDelivery {
  mids?: string[];
  watermark: number;
}

interface MetaRead {
  watermark: number;
}

interface MetaReferral {
  ref?: string;
  source?: string;
  type?: string;
}

interface MetaReaction {
  reaction: string;
  emoji?: string;
  action: 'react' | 'unreact';
  mid: string;
}

/**
 * Normalize a Meta webhook payload into NormalizedEvent[].
 * Handles both Messenger ("page") and Instagram ("instagram") payloads.
 */
export function normalizeMetaPayload(payload: MetaWebhookPayload): Array<{
  event: NormalizedEvent;
  recipientId: string;
  channel: 'messenger' | 'instagram';
}> {
  const results: Array<{
    event: NormalizedEvent;
    recipientId: string;
    channel: 'messenger' | 'instagram';
  }> = [];

  const channel: 'messenger' | 'instagram' =
    payload.object === 'instagram' ? 'instagram' : 'messenger';

  for (const entry of payload.entry) {
    if (!entry.messaging) continue;

    for (const messaging of entry.messaging) {
      // Skip echo events (our own messages sent back)
      if (messaging.message?.is_echo) continue;

      const normalized = normalizeMessagingEvent(messaging, entry, channel);
      if (normalized) {
        results.push({
          event: normalized,
          recipientId: messaging.recipient.id,
          channel,
        });
      }
    }
  }

  return results;
}

function normalizeMessagingEvent(
  messaging: MetaMessagingEvent,
  entry: MetaEntry,
  channel: 'messenger' | 'instagram',
): NormalizedEvent | null {
  const sender = {
    externalUserId: messaging.sender.id,
    externalThreadId: messaging.sender.id, // 1:1 messaging, thread = sender
    platformData: { channel },
  };

  // Quick reply (treat as postback)
  if (messaging.message?.quick_reply) {
    return {
      type: 'postback',
      postback: {
        payload: messaging.message.quick_reply.payload,
        title: messaging.message.text,
      },
      sender,
      dedupeKey: `meta:${channel}:${entry.id}:${messaging.sender.id}:qr:${messaging.message.mid}`,
      timestamp: new Date(messaging.timestamp),
      rawEventType: 'quick_reply',
    };
  }

  // Text or attachment message
  if (messaging.message) {
    const msg = messaging.message;

    if (msg.text && !msg.attachments?.length) {
      // Pure text message
      return {
        type: 'message',
        message: {
          type: 'text',
          content: msg.text,
          replyToExternalId: msg.reply_to?.mid,
        },
        sender,
        dedupeKey: `meta:${channel}:${entry.id}:${messaging.sender.id}:${msg.mid}`,
        timestamp: new Date(messaging.timestamp),
        rawEventType: 'message.text',
      };
    }

    if (msg.attachments && msg.attachments.length > 0) {
      // Use first attachment (most common case)
      const att = msg.attachments[0];
      const type = att.type === 'image' ? 'image'
        : att.type === 'video' ? 'video'
        : att.type === 'audio' ? 'audio'
        : att.type === 'file' ? 'file'
        : 'file'; // fallback/template → file

      return {
        type: 'message',
        message: {
          type,
          content: msg.text || '',
          mediaUrl: att.payload?.url,
          mediaMetadata: {
            attachmentType: att.type,
            stickerId: att.payload?.sticker_id,
          },
          replyToExternalId: msg.reply_to?.mid,
        },
        sender,
        dedupeKey: `meta:${channel}:${entry.id}:${messaging.sender.id}:${msg.mid}`,
        timestamp: new Date(messaging.timestamp),
        rawEventType: `message.${att.type}`,
      };
    }

    // Message with no text or attachments — skip
    return null;
  }

  // Postback
  if (messaging.postback) {
    const payloadHash = crypto
      .createHash('sha256')
      .update(messaging.postback.payload)
      .digest('hex')
      .slice(0, 16);

    return {
      type: 'postback',
      postback: {
        payload: messaging.postback.payload,
        title: messaging.postback.title,
      },
      sender,
      dedupeKey: `meta:${channel}:${entry.id}:${messaging.sender.id}:postback:${messaging.timestamp}:${payloadHash}`,
      timestamp: new Date(messaging.timestamp),
      rawEventType: 'postback',
    };
  }

  // Delivery receipt
  if (messaging.delivery?.mids) {
    return {
      type: 'delivery',
      receipt: {
        messageIds: messaging.delivery.mids,
        status: 'delivered',
      },
      sender,
      dedupeKey: `meta:${channel}:${entry.id}:delivery:${messaging.delivery.watermark}`,
      timestamp: new Date(messaging.timestamp),
      rawEventType: 'delivery',
    };
  }

  // Read receipt (log only — watermark doesn't map to specific IDs)
  if (messaging.read) {
    return {
      type: 'read',
      receipt: {
        messageIds: [],
        status: 'read',
      },
      sender,
      dedupeKey: `meta:${channel}:${entry.id}:read:${messaging.read.watermark}`,
      timestamp: new Date(messaging.timestamp),
      rawEventType: 'read',
    };
  }

  // Referral
  if (messaging.referral) {
    return {
      type: 'referral',
      sender,
      dedupeKey: `meta:${channel}:${entry.id}:referral:${messaging.timestamp}`,
      timestamp: new Date(messaging.timestamp),
      rawEventType: 'referral',
    };
  }

  // Reaction
  if (messaging.reaction) {
    return {
      type: 'status',
      sender,
      dedupeKey: `meta:${channel}:${entry.id}:reaction:${messaging.reaction.mid}:${messaging.reaction.action}`,
      timestamp: new Date(messaging.timestamp),
      rawEventType: 'reaction',
    };
  }

  return null;
}
```

- [ ] **Step 2: Verify and commit**

```bash
cd chatbot-platform/api && npx tsc --noEmit 2>&1 | head -20
git add api/src/channels/meta/event-normalizer.ts
git commit -m "feat: add Meta event normalizer for Messenger and Instagram"
```

---

### Task 4: Meta Webhook Route (HMAC + Challenge + Dispatcher)

**Files:**
- Create: `api/src/channels/meta/webhook.routes.ts`
- Modify: `api/src/server.ts`

- [ ] **Step 1: Create Meta webhook route**

Create `api/src/channels/meta/webhook.routes.ts`:

```typescript
import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { config } from '../../config/environment';
import { logger } from '../../utils/logger';
import { resolveMetaConnection } from './connection-resolver';
import { normalizeMetaPayload } from './event-normalizer';
import { processInboundEvent } from '../inbound-pipeline';
import { AppDataSource } from '../../database/data-source';
import { WebhookEventLog } from '../../database/entities/WebhookEventLog';
import { getChannelInboundQueue } from '../inbound-queue.processor';

const router = Router();

/**
 * GET /api/v1/channels/meta/webhook
 * Meta webhook verification challenge.
 */
router.get('/', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'] as string | undefined;
  const token = req.query['hub.verify_token'] as string | undefined;
  const challenge = req.query['hub.challenge'] as string | undefined;

  if (mode === 'subscribe' && token === config.meta.verifyToken) {
    logger.info('[meta-webhook] Verification challenge accepted');
    return res.status(200).send(challenge);
  }

  logger.warn('[meta-webhook] Verification challenge failed', { mode, token });
  return res.status(403).send('Forbidden');
});

/**
 * POST /api/v1/channels/meta/webhook
 * Meta webhook ingress — raw body for HMAC verification.
 */
router.post('/', async (req: Request, res: Response) => {
  const rawBody = req.body as Buffer;

  // 1. Verify HMAC signature
  const signature = req.headers['x-hub-signature-256'] as string | undefined;
  if (!signature || !config.meta.appSecret) {
    logger.warn('[meta-webhook] Missing signature or app secret');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const expectedSignature = 'sha256=' + crypto
    .createHmac('sha256', config.meta.appSecret)
    .update(rawBody)
    .digest('hex');

  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
    logger.warn('[meta-webhook] Invalid HMAC signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // 2. Parse JSON from raw body
  let payload: any;
  try {
    payload = JSON.parse(rawBody.toString('utf-8'));
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  // 3. Normalize and dispatch events
  const normalizedEvents = normalizeMetaPayload(payload);

  const eventLogRepo = AppDataSource.getRepository(WebhookEventLog);
  const queue = getChannelInboundQueue();

  for (const { event, recipientId, channel } of normalizedEvents) {
    try {
      // Resolve connection by recipient ID + channel
      const connection = await resolveMetaConnection(recipientId, channel);
      if (!connection) continue;

      // Persist event for idempotency
      const logEntry = eventLogRepo.create({
        channelConnectionId: connection.id,
        channel: connection.channel,
        dedupeKey: event.dedupeKey,
        eventType: event.rawEventType,
        rawPayload: payload,
        status: 'received',
      });
      await eventLogRepo.save(logEntry);

      // Queue or process inline
      if (queue) {
        await queue.add('channel-inbound', {
          eventDedupeKey: event.dedupeKey,
          connectionId: connection.id,
          event,
        }, {
          jobId: event.dedupeKey,
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: 100,
          removeOnFail: 500,
        });
      } else {
        await processInboundEvent(event, connection);
      }
    } catch (error: any) {
      if (error?.code === '23505') continue; // Duplicate dedupe key
      logger.error(`[meta-webhook] Error processing ${channel} event:`, error);
    }
  }

  // 4. Return 200 fast
  return res.status(200).json({ ok: true });
});

export default router;
```

- [ ] **Step 2: Mount Meta webhook route in server.ts**

In `api/src/server.ts`, add import at top:

```typescript
import metaWebhookRoutes from './channels/meta/webhook.routes';
```

Mount BEFORE `express.json()`, right after the Clerk webhook mount (around line 75):

```typescript
// Meta webhook — must use raw body parser for HMAC verification
app.use('/api/v1/channels/meta/webhook', express.raw({ type: 'application/json' }), metaWebhookRoutes);
```

- [ ] **Step 3: Verify and commit**

```bash
cd chatbot-platform/api && npx tsc --noEmit 2>&1 | head -20
git add api/src/channels/meta/webhook.routes.ts api/src/server.ts
git commit -m "feat: add Meta webhook route with HMAC verification and challenge handling"
```

---

### Task 5: Messenger Outbound Transport

**Files:**
- Create: `api/src/channels/meta/messenger-transport.ts`

- [ ] **Step 1: Create Messenger outbound transport**

Create `api/src/channels/meta/messenger-transport.ts`:

```typescript
import axios from 'axios';
import { ChannelConnection } from '../../database/entities/ChannelConnection';
import { OutboundTransport, OutboundChannelMessage, DeliveryResult, ChannelCapabilities } from '../types';
import { getMetaPageAccessToken } from '../credential-utils';
import { logger } from '../../utils/logger';

const GRAPH_API = 'https://graph.facebook.com/v21.0';

export class MessengerOutboundTransport implements OutboundTransport {
  getCapabilities(): ChannelCapabilities {
    return {
      maxTextLength: 2000,
      supportsQuickReplies: true,
      maxQuickReplies: 13,
      supportsButtons: true,
      maxButtons: 3,
      supportsCarousel: true,
      maxCarouselCards: 10,
      supportsImages: true,
      supportsVideo: true,
      supportsAudio: true,
      supportsFiles: true,
      supportsTypingIndicator: true,
      supportsReadReceipts: false,
      supportsMessageEdit: false,
      supportsMessageDelete: false,
      supportsStickers: false,
      hasMessagingWindow: true,
      messagingWindowHours: 24,
      requiresTemplatesOutsideWindow: true,
    };
  }

  async send(
    message: OutboundChannelMessage,
    externalThreadId: string,
    connection: ChannelConnection,
  ): Promise<DeliveryResult> {
    const accessToken = getMetaPageAccessToken(connection.credentials);
    if (!accessToken) {
      return { success: false, error: 'No page access token', retryable: false };
    }

    const pageId = connection.platformAccountId;
    if (!pageId) {
      return { success: false, error: 'No page ID', retryable: false };
    }

    try {
      const body = this.buildSendBody(message, externalThreadId);
      const response = await axios.post(
        `${GRAPH_API}/${pageId}/messages`,
        body,
        {
          params: { access_token: accessToken },
          timeout: 10000,
        },
      );

      return {
        success: true,
        platformMessageId: response.data?.message_id,
      };
    } catch (error) {
      const errMsg = axios.isAxiosError(error)
        ? error.response?.data?.error?.message || error.message
        : error instanceof Error ? error.message : 'Unknown error';
      const retryable = axios.isAxiosError(error)
        ? (error.response?.status || 0) >= 500 || error.response?.status === 429
        : true;

      logger.error(`[messenger] Send failed to ${externalThreadId}:`, errMsg);
      return { success: false, error: errMsg, retryable };
    }
  }

  async sendTypingIndicator(externalThreadId: string, connection: ChannelConnection): Promise<void> {
    const accessToken = getMetaPageAccessToken(connection.credentials);
    const pageId = connection.platformAccountId;
    if (!accessToken || !pageId) return;

    try {
      await axios.post(
        `${GRAPH_API}/${pageId}/messages`,
        {
          recipient: { id: externalThreadId },
          sender_action: 'typing_on',
          messaging_type: 'RESPONSE',
        },
        { params: { access_token: accessToken }, timeout: 5000 },
      );
    } catch {
      // Typing indicators are best-effort
    }
  }

  private buildSendBody(
    message: OutboundChannelMessage,
    recipientId: string,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      recipient: { id: recipientId },
      messaging_type: 'RESPONSE',
    };

    switch (message.type) {
      case 'text':
      case 'quick_reply': {
        body.message = { text: message.content || '' };

        if (message.quickReplies && message.quickReplies.length > 0) {
          (body.message as any).quick_replies = message.quickReplies
            .slice(0, 13)
            .map((qr) => ({
              content_type: 'text',
              title: qr.title.slice(0, 20),
              payload: qr.payload.slice(0, 1000),
            }));
        }

        if (message.buttons && message.buttons.length > 0) {
          body.message = {
            attachment: {
              type: 'template',
              payload: {
                template_type: 'button',
                text: message.content || 'Choose an option',
                buttons: message.buttons.slice(0, 3).map((btn) =>
                  btn.type === 'url'
                    ? { type: 'web_url', title: btn.title, url: btn.value }
                    : { type: 'postback', title: btn.title, payload: btn.value },
                ),
              },
            },
          };
        }
        break;
      }
      case 'image':
      case 'video':
      case 'audio':
      case 'file': {
        body.message = {
          attachment: {
            type: message.type === 'file' ? 'file' : message.type,
            payload: { url: message.mediaUrl || message.content, is_reusable: true },
          },
        };
        break;
      }
      case 'carousel': {
        if (message.cards && message.cards.length > 0) {
          body.message = {
            attachment: {
              type: 'template',
              payload: {
                template_type: 'generic',
                elements: message.cards.slice(0, 10).map((card) => ({
                  title: card.title,
                  subtitle: card.subtitle,
                  image_url: card.imageUrl,
                  buttons: card.buttons?.slice(0, 3).map((btn) =>
                    btn.type === 'url'
                      ? { type: 'web_url', title: btn.title, url: btn.value }
                      : { type: 'postback', title: btn.title, payload: btn.value },
                  ),
                })),
              },
            },
          };
        }
        break;
      }
      default: {
        body.message = { text: message.content || '' };
      }
    }

    return body;
  }
}
```

- [ ] **Step 2: Verify and commit**

```bash
cd chatbot-platform/api && npx tsc --noEmit 2>&1 | head -20
git add api/src/channels/meta/messenger-transport.ts
git commit -m "feat: add Messenger outbound transport with Send API support"
```

---

### Task 6: Instagram Outbound Transport

**Files:**
- Create: `api/src/channels/meta/instagram-transport.ts`

- [ ] **Step 1: Create Instagram outbound transport**

Create `api/src/channels/meta/instagram-transport.ts`:

```typescript
import axios from 'axios';
import { ChannelConnection } from '../../database/entities/ChannelConnection';
import { OutboundTransport, OutboundChannelMessage, DeliveryResult, ChannelCapabilities } from '../types';
import { getMetaPageAccessToken } from '../credential-utils';
import { logger } from '../../utils/logger';

const IG_GRAPH_API = 'https://graph.instagram.com/v21.0';

export class InstagramOutboundTransport implements OutboundTransport {
  getCapabilities(): ChannelCapabilities {
    return {
      maxTextLength: 1000,
      supportsQuickReplies: true,
      maxQuickReplies: 13,
      supportsButtons: true,
      maxButtons: 3,
      supportsCarousel: true,
      maxCarouselCards: 10,
      supportsImages: true,
      supportsVideo: true,
      supportsAudio: true,
      supportsFiles: false,
      supportsTypingIndicator: false,
      supportsReadReceipts: false,
      supportsMessageEdit: false,
      supportsMessageDelete: false,
      supportsStickers: false,
      hasMessagingWindow: true,
      messagingWindowHours: 24,
      requiresTemplatesOutsideWindow: false,
    };
  }

  async send(
    message: OutboundChannelMessage,
    externalThreadId: string,
    connection: ChannelConnection,
  ): Promise<DeliveryResult> {
    const accessToken = getMetaPageAccessToken(connection.credentials);
    const igBusinessId = (connection.credentials as any).igBusinessId || connection.platformAccountId;

    if (!accessToken) {
      return { success: false, error: 'No page access token', retryable: false };
    }

    try {
      const body = this.buildSendBody(message, externalThreadId);
      const response = await axios.post(
        `${IG_GRAPH_API}/${igBusinessId}/messages`,
        body,
        {
          params: { access_token: accessToken },
          timeout: 10000,
        },
      );

      return {
        success: true,
        platformMessageId: response.data?.message_id,
      };
    } catch (error) {
      const errMsg = axios.isAxiosError(error)
        ? error.response?.data?.error?.message || error.message
        : error instanceof Error ? error.message : 'Unknown error';
      const retryable = axios.isAxiosError(error)
        ? (error.response?.status || 0) >= 500 || error.response?.status === 429
        : true;

      logger.error(`[instagram] Send failed to ${externalThreadId}:`, errMsg);
      return { success: false, error: errMsg, retryable };
    }
  }

  async sendTypingIndicator(_externalThreadId: string, _connection: ChannelConnection): Promise<void> {
    // Instagram does not support typing indicators
  }

  private buildSendBody(
    message: OutboundChannelMessage,
    recipientId: string,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      recipient: { id: recipientId },
      messaging_type: 'RESPONSE',
    };

    switch (message.type) {
      case 'text':
      case 'quick_reply': {
        body.message = { text: message.content || '' };

        if (message.quickReplies && message.quickReplies.length > 0) {
          (body.message as any).quick_replies = message.quickReplies
            .slice(0, 13)
            .map((qr) => ({
              content_type: 'text',
              title: qr.title.slice(0, 20),
              payload: qr.payload.slice(0, 1000),
            }));
        }
        break;
      }
      case 'image': {
        body.message = {
          attachment: {
            type: 'image',
            payload: { url: message.mediaUrl || message.content },
          },
        };
        break;
      }
      case 'video': {
        body.message = {
          attachment: {
            type: 'video',
            payload: { url: message.mediaUrl || message.content },
          },
        };
        break;
      }
      case 'audio': {
        body.message = {
          attachment: {
            type: 'audio',
            payload: { url: message.mediaUrl || message.content },
          },
        };
        break;
      }
      default: {
        body.message = { text: message.content || '' };
      }
    }

    return body;
  }
}
```

- [ ] **Step 2: Verify and commit**

```bash
cd chatbot-platform/api && npx tsc --noEmit 2>&1 | head -20
git add api/src/channels/meta/instagram-transport.ts
git commit -m "feat: add Instagram outbound transport with IG Send API support"
```

---

### Task 7: Meta OAuth Service + Routes

**Files:**
- Create: `api/src/channels/meta/oauth.service.ts`
- Create: `api/src/channels/meta/oauth.routes.ts`
- Modify: `api/src/server.ts`

- [ ] **Step 1: Create OAuth service**

Create `api/src/channels/meta/oauth.service.ts`:

```typescript
import axios from 'axios';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { config } from '../../config/environment';
import { logger } from '../../utils/logger';

const GRAPH_API = 'https://graph.facebook.com/v21.0';

const OAUTH_SCOPES = [
  'pages_messaging',
  'pages_read_engagement',
  'pages_manage_metadata',
  'pages_show_list',
  'instagram_basic',
  'instagram_business_manage_messages',
].join(',');

interface MetaPage {
  id: string;
  name: string;
  accessToken: string;
  picture?: string;
  tasks: string[];
  instagramAccount?: {
    id: string;
    username?: string;
    profilePicUrl?: string;
  };
}

/**
 * Build the Facebook Login OAuth URL for a tenant.
 */
export function buildOAuthUrl(tenantId: string): string {
  const state = jwt.sign(
    { tenantId, nonce: crypto.randomBytes(16).toString('hex') },
    config.meta.oauthJwtSecret,
    { expiresIn: '5m' },
  );

  const params = new URLSearchParams({
    client_id: config.meta.appId,
    redirect_uri: config.meta.oauthRedirectUri,
    scope: OAUTH_SCOPES,
    state,
    response_type: 'code',
  });

  return `https://www.facebook.com/v21.0/dialog/oauth?${params.toString()}`;
}

/**
 * Validate the OAuth state JWT and extract tenantId.
 */
export function validateOAuthState(state: string): { tenantId: string } {
  const decoded = jwt.verify(state, config.meta.oauthJwtSecret) as { tenantId: string };
  return { tenantId: decoded.tenantId };
}

/**
 * Exchange authorization code for access tokens, then list available Pages.
 */
export async function handleOAuthCallback(code: string): Promise<{
  pages: MetaPage[];
  sessionToken: string;
}> {
  // 1. Exchange code for short-lived user token
  const tokenResponse = await axios.get(`${GRAPH_API}/oauth/access_token`, {
    params: {
      client_id: config.meta.appId,
      client_secret: config.meta.appSecret,
      redirect_uri: config.meta.oauthRedirectUri,
      code,
    },
    timeout: 10000,
  });
  const shortLivedToken = tokenResponse.data.access_token;

  // 2. Exchange for long-lived user token
  const longLivedResponse = await axios.get(`${GRAPH_API}/oauth/access_token`, {
    params: {
      grant_type: 'fb_exchange_token',
      client_id: config.meta.appId,
      client_secret: config.meta.appSecret,
      fb_exchange_token: shortLivedToken,
    },
    timeout: 10000,
  });
  const longLivedUserToken = longLivedResponse.data.access_token;

  // 3. Get pages the user manages
  const pagesResponse = await axios.get(`${GRAPH_API}/me/accounts`, {
    params: {
      access_token: longLivedUserToken,
      fields: 'id,name,access_token,picture,tasks,instagram_business_account{id,username,profile_picture_url}',
      limit: 100,
    },
    timeout: 10000,
  });

  const pages: MetaPage[] = [];

  for (const page of pagesResponse.data.data || []) {
    // Filter pages that have MESSAGING task
    if (!page.tasks?.includes('MESSAGING')) continue;

    const metaPage: MetaPage = {
      id: page.id,
      name: page.name,
      accessToken: page.access_token, // Long-lived page token (does not expire)
      picture: page.picture?.data?.url,
      tasks: page.tasks,
    };

    // Check for linked Instagram Business account
    if (page.instagram_business_account) {
      metaPage.instagramAccount = {
        id: page.instagram_business_account.id,
        username: page.instagram_business_account.username,
        profilePicUrl: page.instagram_business_account.profile_picture_url,
      };
    }

    pages.push(metaPage);
  }

  // 4. Create a signed session token containing page data (15-min expiry)
  const sessionToken = jwt.sign(
    { pages: pages.map((p) => ({ ...p, accessToken: undefined })) }, // Don't put tokens in session JWT
    config.meta.oauthJwtSecret,
    { expiresIn: '15m' },
  );

  // Store page tokens temporarily in memory (keyed by page ID)
  // In production, use Redis. For now, module-level Map with TTL.
  for (const page of pages) {
    pageTokenCache.set(page.id, {
      accessToken: page.accessToken,
      expiresAt: Date.now() + 15 * 60 * 1000,
    });
  }

  return { pages, sessionToken };
}

// Temporary in-memory cache for page tokens during OAuth flow
const pageTokenCache = new Map<string, { accessToken: string; expiresAt: number }>();

export function getCachedPageToken(pageId: string): string | null {
  const cached = pageTokenCache.get(pageId);
  if (!cached || cached.expiresAt < Date.now()) {
    pageTokenCache.delete(pageId);
    return null;
  }
  return cached.accessToken;
}

/**
 * Get the pages available from a session token.
 */
export function getSessionPages(sessionToken: string): MetaPage[] {
  const decoded = jwt.verify(sessionToken, config.meta.oauthJwtSecret) as { pages: MetaPage[] };
  return decoded.pages;
}
```

- [ ] **Step 2: Create OAuth routes**

Create `api/src/channels/meta/oauth.routes.ts`:

```typescript
import { Router, Request, Response } from 'express';
import { requireClerkAuth, autoProvision } from '../../middleware/clerk.middleware';
import { logger } from '../../utils/logger';
import { config } from '../../config/environment';
import {
  buildOAuthUrl,
  validateOAuthState,
  handleOAuthCallback,
  getSessionPages,
  getCachedPageToken,
} from './oauth.service';
import { setupMetaConnections } from './setup.service';

const router = Router();

/**
 * GET /api/v1/channels/meta/oauth/url
 * Returns the Facebook Login URL for the authenticated tenant.
 */
router.get('/url', requireClerkAuth, autoProvision, async (req: Request, res: Response) => {
  const tenantId = (req as any).user?.tenantId;
  if (!tenantId) {
    return res.status(400).json({ error: 'Tenant context required' });
  }

  if (!config.meta.appId || !config.meta.oauthRedirectUri) {
    return res.status(503).json({ error: 'Meta integration not configured' });
  }

  const url = buildOAuthUrl(tenantId);
  return res.json({ url });
});

/**
 * GET /api/v1/channels/meta/oauth/callback
 * Facebook redirects here after user grants permissions.
 */
router.get('/callback', async (req: Request, res: Response) => {
  const { code, state, error: oauthError } = req.query;

  if (oauthError) {
    logger.warn('[meta-oauth] User denied permissions', { error: oauthError });
    return res.redirect(`${getPortalUrl()}/settings/channels?error=denied`);
  }

  if (!code || !state) {
    return res.redirect(`${getPortalUrl()}/settings/channels?error=missing_params`);
  }

  try {
    // Validate state JWT
    const { tenantId } = validateOAuthState(state as string);

    // Exchange code for tokens + list pages
    const { sessionToken } = await handleOAuthCallback(code as string);

    // Redirect to portal with session token
    return res.redirect(
      `${getPortalUrl()}/settings/channels?meta_setup=${sessionToken}&tenant=${tenantId}`,
    );
  } catch (error) {
    logger.error('[meta-oauth] Callback error:', error);
    return res.redirect(`${getPortalUrl()}/settings/channels?error=auth_failed`);
  }
});

/**
 * GET /api/v1/channels/meta/oauth/pages
 * Returns available Pages from the OAuth session.
 */
router.get('/pages', requireClerkAuth, autoProvision, async (req: Request, res: Response) => {
  const sessionToken = req.query.session as string;
  if (!sessionToken) {
    return res.status(400).json({ error: 'session token required' });
  }

  try {
    const pages = getSessionPages(sessionToken);
    return res.json({ pages });
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
});

/**
 * POST /api/v1/channels/meta/connect
 * Connect selected Pages/IG accounts for the tenant.
 */
router.post('/connect', requireClerkAuth, autoProvision, async (req: Request, res: Response) => {
  const tenantId = (req as any).user?.tenantId;
  if (!tenantId) {
    return res.status(400).json({ error: 'Tenant context required' });
  }

  const { pageIds, sessionToken } = req.body as { pageIds: string[]; sessionToken: string };

  if (!pageIds || !Array.isArray(pageIds) || pageIds.length === 0) {
    return res.status(400).json({ error: 'pageIds required' });
  }

  try {
    // Validate session and get page data
    const pages = getSessionPages(sessionToken);

    // Filter to selected pages and get their tokens from cache
    const selectedPages = pages
      .filter((p) => pageIds.includes(p.id))
      .map((p) => ({
        ...p,
        accessToken: getCachedPageToken(p.id) || '',
      }))
      .filter((p) => p.accessToken);

    if (selectedPages.length === 0) {
      return res.status(400).json({ error: 'No valid pages found. OAuth session may have expired.' });
    }

    // Create connections
    const connections = await setupMetaConnections(tenantId, selectedPages);

    return res.status(201).json({ connections });
  } catch (error) {
    logger.error('[meta-oauth] Connect error:', error);
    const message = error instanceof Error ? error.message : 'Failed to connect';
    return res.status(400).json({ error: message });
  }
});

function getPortalUrl(): string {
  // Derive portal URL from config
  const corsOrigins = Array.isArray(config.cors.origin) ? config.cors.origin : [config.cors.origin];
  return corsOrigins[0] || 'http://localhost:5173';
}

export default router;
```

- [ ] **Step 3: Mount OAuth routes in server.ts**

In `api/src/server.ts`, add import:

```typescript
import metaOAuthRoutes from './channels/meta/oauth.routes';
```

Inside `startServer()`, after channel adapter registration:

```typescript
apiRouter.use('/channels/meta/oauth', metaOAuthRoutes);
```

- [ ] **Step 4: Verify and commit**

```bash
cd chatbot-platform/api && npx tsc --noEmit 2>&1 | head -20
git add api/src/channels/meta/oauth.service.ts api/src/channels/meta/oauth.routes.ts api/src/server.ts
git commit -m "feat: add Meta OAuth flow (login URL, callback, page selection, connect)"
```

---

### Task 8: Meta Setup + Disconnect Services

**Files:**
- Create: `api/src/channels/meta/setup.service.ts`
- Create: `api/src/channels/meta/disconnect.service.ts`
- Modify: `api/src/channels/channel-management.routes.ts`

- [ ] **Step 1: Create setup service**

Create `api/src/channels/meta/setup.service.ts`:

```typescript
import axios from 'axios';
import { AppDataSource } from '../../database/data-source';
import { ChannelConnection } from '../../database/entities/ChannelConnection';
import { encryptCredential } from '../credential-utils';
import { logger } from '../../utils/logger';

const GRAPH_API = 'https://graph.facebook.com/v21.0';

interface PageToConnect {
  id: string;
  name: string;
  accessToken: string;
  picture?: string;
  instagramAccount?: {
    id: string;
    username?: string;
    profilePicUrl?: string;
  };
}

/**
 * Set up Messenger (and optionally Instagram) connections for selected Pages.
 */
export async function setupMetaConnections(
  tenantId: string,
  pages: PageToConnect[],
): Promise<ChannelConnection[]> {
  const repo = AppDataSource.getRepository(ChannelConnection);
  const connections: ChannelConnection[] = [];

  for (const page of pages) {
    // 1. Subscribe page to webhooks
    try {
      await axios.post(
        `${GRAPH_API}/${page.id}/subscribed_apps`,
        null,
        {
          params: {
            access_token: page.accessToken,
            subscribed_fields: 'messages,messaging_postbacks,messaging_optins,message_deliveries,message_reads,messaging_referrals',
          },
          timeout: 10000,
        },
      );
    } catch (error) {
      logger.error(`[meta-setup] Failed to subscribe page ${page.id}:`, error);
      throw new Error(`Failed to subscribe Page "${page.name}" to webhooks`);
    }

    // 2. Create Messenger connection
    const messengerConn = repo.create({
      tenantId,
      channel: 'messenger',
      status: 'active',
      label: page.name,
      platformAccountId: page.id,
      credentials: {
        pageAccessToken: encryptCredential(page.accessToken),
        pageId: page.id,
      },
      config: {
        pageName: page.name,
        pageImageUrl: page.picture,
      },
    });
    const savedMessenger = await repo.save(messengerConn);
    connections.push(savedMessenger);

    // 3. If IG account linked, subscribe and create IG connection
    if (page.instagramAccount) {
      try {
        await axios.post(
          `${GRAPH_API}/${page.instagramAccount.id}/subscribed_apps`,
          null,
          {
            params: {
              access_token: page.accessToken,
              subscribed_fields: 'messages,messaging_postbacks,message_reactions',
            },
            timeout: 10000,
          },
        );

        const igConn = repo.create({
          tenantId,
          channel: 'instagram',
          status: 'active',
          label: page.instagramAccount.username
            ? `@${page.instagramAccount.username}`
            : `${page.name} (Instagram)`,
          platformAccountId: page.instagramAccount.id,
          credentials: {
            pageAccessToken: encryptCredential(page.accessToken),
            pageId: page.id,
            igBusinessId: page.instagramAccount.id,
          },
          config: {
            igUsername: page.instagramAccount.username,
            igProfilePicUrl: page.instagramAccount.profilePicUrl,
            linkedPageId: page.id,
          },
        });
        const savedIg = await repo.save(igConn);
        connections.push(savedIg);
      } catch (error) {
        logger.warn(`[meta-setup] Failed to subscribe IG account ${page.instagramAccount.id}:`, error);
        // Don't fail the whole operation — Messenger is still connected
      }
    }
  }

  return connections;
}
```

- [ ] **Step 2: Create disconnect service**

Create `api/src/channels/meta/disconnect.service.ts`:

```typescript
import axios from 'axios';
import { AppDataSource } from '../../database/data-source';
import { ChannelConnection } from '../../database/entities/ChannelConnection';
import { getMetaPageAccessToken } from '../credential-utils';
import { logger } from '../../utils/logger';

const GRAPH_API = 'https://graph.facebook.com/v21.0';

/**
 * Disconnect a Meta (Messenger or Instagram) connection.
 * Unsubscribes from webhooks and clears credentials.
 */
export async function disconnectMetaConnection(connectionId: string): Promise<void> {
  const repo = AppDataSource.getRepository(ChannelConnection);
  const connection = await repo.findOne({ where: { id: connectionId } });

  if (!connection) throw new Error('Connection not found');

  const accessToken = getMetaPageAccessToken(connection.credentials);
  const accountId = connection.platformAccountId;

  // Unsubscribe from webhooks (best-effort)
  if (accessToken && accountId) {
    try {
      await axios.delete(`${GRAPH_API}/${accountId}/subscribed_apps`, {
        params: { access_token: accessToken },
        timeout: 10000,
      });
    } catch (error) {
      logger.warn(`[meta-disconnect] Failed to unsubscribe ${accountId}:`, error);
    }
  }

  // Clear credentials and mark as disconnected
  connection.credentials = {};
  connection.status = 'disconnected';
  await repo.save(connection);

  // If disconnecting a Messenger Page, also disconnect linked IG
  if (connection.channel === 'messenger') {
    const linkedIg = await repo.findOne({
      where: {
        tenantId: connection.tenantId,
        channel: 'instagram' as any,
        status: 'active' as any,
      },
    });

    if (linkedIg) {
      const linkedPageId = (linkedIg.config as any)?.linkedPageId;
      if (linkedPageId === connection.platformAccountId) {
        linkedIg.credentials = {};
        linkedIg.status = 'disconnected';
        await repo.save(linkedIg);
        logger.info(`[meta-disconnect] Also disconnected linked IG ${linkedIg.id}`);
      }
    }
  }
}
```

- [ ] **Step 3: Update channel-management.routes.ts for Meta disconnect**

Read `api/src/channels/channel-management.routes.ts` and in the DELETE disconnect handler, add Meta handling. After the Telegram check:

```typescript
import { disconnectMetaConnection } from './meta/disconnect.service';

// In the disconnect handler, add:
} else if (existing.channel === 'messenger' || existing.channel === 'instagram') {
  await disconnectMetaConnection(connectionId);
}
```

- [ ] **Step 4: Verify and commit**

```bash
cd chatbot-platform/api && npx tsc --noEmit 2>&1 | head -20
git add api/src/channels/meta/setup.service.ts api/src/channels/meta/disconnect.service.ts \
  api/src/channels/channel-management.routes.ts
git commit -m "feat: add Meta setup and disconnect services with webhook subscription"
```

---

### Task 9: Meta Profile Service + Adapter Registration

**Files:**
- Create: `api/src/channels/meta/profile.service.ts`
- Create: `api/src/channels/meta/index.ts`
- Modify: `api/src/server.ts`

- [ ] **Step 1: Create profile service**

Create `api/src/channels/meta/profile.service.ts`:

```typescript
import axios from 'axios';
import { logger } from '../../utils/logger';

const GRAPH_API = 'https://graph.facebook.com/v21.0';

// Simple in-memory cache with TTL
const profileCache = new Map<string, { displayName: string; avatarUrl?: string; expiresAt: number }>();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Fetch profile info for a Meta user (Messenger PSID or Instagram IGSID).
 */
export async function fetchMetaProfile(
  userId: string,
  accessToken: string,
  channel: 'messenger' | 'instagram',
): Promise<{ displayName: string; avatarUrl?: string }> {
  // Check cache
  const cacheKey = `${channel}:${userId}`;
  const cached = profileCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { displayName: cached.displayName, avatarUrl: cached.avatarUrl };
  }

  try {
    const fields = channel === 'messenger'
      ? 'first_name,last_name,profile_pic'
      : 'name,profile_pic';

    const response = await axios.get(`${GRAPH_API}/${userId}`, {
      params: { fields, access_token: accessToken },
      timeout: 5000,
    });

    const data = response.data;
    const displayName = channel === 'messenger'
      ? [data.first_name, data.last_name].filter(Boolean).join(' ')
      : data.name || 'Instagram User';
    const avatarUrl = data.profile_pic;

    // Cache result
    profileCache.set(cacheKey, {
      displayName,
      avatarUrl,
      expiresAt: Date.now() + CACHE_TTL,
    });

    return { displayName, avatarUrl };
  } catch (error) {
    logger.debug(`[meta-profile] Failed to fetch profile for ${userId}:`, error);
    const fallback = channel === 'messenger' ? 'Facebook User' : 'Instagram User';
    return { displayName: fallback };
  }
}
```

- [ ] **Step 2: Create Meta adapter index**

Create `api/src/channels/meta/index.ts`:

```typescript
import { ChannelAdapter, ConnectionResolver, WebhookVerifier, EventNormalizer } from '../types';
import { MessengerOutboundTransport } from './messenger-transport';
import { InstagramOutboundTransport } from './instagram-transport';

// Meta uses a dedicated webhook route, not the generic adapter pipeline.
// However, we still register adapters so the outbound router can look them up
// by channel type ('messenger' or 'instagram') for sending responses.

// Stub resolver/verifier — Meta webhook handling is in webhook.routes.ts
const stubResolver: ConnectionResolver = {
  async resolve() { return null; },
};
const stubVerifier: WebhookVerifier = {
  handleVerificationChallenge() { return null; },
  verifySignature() { return false; },
};
const stubNormalizer: EventNormalizer = {
  normalize() { return []; },
};

export const messengerAdapter: ChannelAdapter = {
  channel: 'messenger',
  connectionResolver: stubResolver,
  webhookVerifier: stubVerifier,
  eventNormalizer: stubNormalizer,
  outboundTransport: new MessengerOutboundTransport(),
};

export const instagramAdapter: ChannelAdapter = {
  channel: 'instagram',
  connectionResolver: stubResolver,
  webhookVerifier: stubVerifier,
  eventNormalizer: stubNormalizer,
  outboundTransport: new InstagramOutboundTransport(),
};
```

- [ ] **Step 3: Register adapters in server.ts**

In `api/src/server.ts`, update the channel registration section:

```typescript
import { messengerAdapter, instagramAdapter } from './channels/meta';

// After telegramAdapter registration:
registerChannelAdapter(messengerAdapter);
registerChannelAdapter(instagramAdapter);
logger.info('Channel adapters registered: telegram, messenger, instagram');
```

- [ ] **Step 4: Verify and commit**

```bash
cd chatbot-platform/api && npx tsc --noEmit 2>&1 | head -20
git add api/src/channels/meta/profile.service.ts api/src/channels/meta/index.ts api/src/server.ts
git commit -m "feat: register Messenger and Instagram adapters with profile service"
```

---

### Task 10: Portal — /settings/channels Page

**Files:**
- Create: `portal/src/pages/settings/ChannelsSettings.tsx`
- Create: `portal/src/queries/useChannelQueries.ts`
- Modify: `portal/src/pages/settings/SettingsLayout.tsx`
- Modify: `portal/src/App.tsx`

- [ ] **Step 1: Create channel query hooks**

Create `portal/src/queries/useChannelQueries.ts`:

```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/apiClient';
import { toast } from 'sonner';

interface ChannelConnection {
  id: string;
  tenantId: string;
  channel: 'widget' | 'telegram' | 'messenger' | 'instagram' | 'whatsapp';
  status: 'active' | 'disconnected' | 'error' | 'pending_setup';
  label: string | null;
  platformAccountId: string | null;
  config: Record<string, any>;
  lastHealthCheckAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export function useChannelConnections() {
  return useQuery({
    queryKey: ['channels', 'connections'],
    queryFn: async () => {
      const res = await api.get('/channels/connections');
      return res.data?.connections as ChannelConnection[];
    },
  });
}

export function useConnectTelegram() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: { botToken: string; label?: string }) => {
      const res = await api.post('/channels/telegram/connect', data);
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['channels'] });
      toast.success('Telegram bot connected');
    },
    onError: (error: any) => {
      toast.error(error?.response?.data?.error || 'Failed to connect Telegram bot');
    },
  });
}

export function useMetaOAuthUrl() {
  return useMutation({
    mutationFn: async () => {
      const res = await api.get('/channels/meta/oauth/url');
      return res.data?.url as string;
    },
  });
}

export function useMetaOAuthPages(sessionToken: string | null) {
  return useQuery({
    queryKey: ['channels', 'meta', 'pages', sessionToken],
    queryFn: async () => {
      const res = await api.get(`/channels/meta/oauth/pages?session=${sessionToken}`);
      return res.data?.pages;
    },
    enabled: !!sessionToken,
  });
}

export function useConnectMeta() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: { pageIds: string[]; sessionToken: string }) => {
      const res = await api.post('/channels/meta/connect', data);
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['channels'] });
      toast.success('Facebook pages connected');
    },
    onError: (error: any) => {
      toast.error(error?.response?.data?.error || 'Failed to connect');
    },
  });
}

export function useDisconnectChannel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (connectionId: string) => {
      await api.delete(`/channels/${connectionId}/disconnect`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['channels'] });
      toast.success('Channel disconnected');
    },
    onError: (error: any) => {
      toast.error(error?.response?.data?.error || 'Failed to disconnect');
    },
  });
}
```

- [ ] **Step 2: Create ChannelsSettings page**

Read `portal/src/pages/settings/WidgetBrandSettings.tsx` for the exact UI patterns (Card, CardHeader, CardContent, Button imports). Then create `portal/src/pages/settings/ChannelsSettings.tsx`:

```typescript
import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { MessageSquare, Bot, Facebook, Instagram, Plus, Trash2, AlertCircle, RefreshCw } from 'lucide-react';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog';
import {
  useChannelConnections,
  useConnectTelegram,
  useMetaOAuthUrl,
  useMetaOAuthPages,
  useConnectMeta,
  useDisconnectChannel,
} from '../../queries/useChannelQueries';

const CHANNEL_ICONS: Record<string, React.ElementType> = {
  telegram: Bot,
  messenger: Facebook,
  instagram: Instagram,
};

const CHANNEL_LABELS: Record<string, string> = {
  telegram: 'Telegram',
  messenger: 'Messenger',
  instagram: 'Instagram',
};

const STATUS_COLORS: Record<string, string> = {
  active: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  error: 'bg-red-500/10 text-red-400 border-red-500/20',
  disconnected: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20',
  pending_setup: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
};

export default function ChannelsSettings() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: connections, isLoading } = useChannelConnections();
  const disconnectMutation = useDisconnectChannel();
  const metaOAuthUrl = useMetaOAuthUrl();
  const connectMeta = useConnectMeta();

  // Telegram connect state
  const [showTelegramModal, setShowTelegramModal] = useState(false);
  const [botToken, setBotToken] = useState('');
  const connectTelegram = useConnectTelegram();

  // Meta OAuth page selection state
  const metaSetupToken = searchParams.get('meta_setup');
  const { data: metaPages } = useMetaOAuthPages(metaSetupToken);
  const [selectedPageIds, setSelectedPageIds] = useState<string[]>([]);

  // Disconnect confirmation
  const [disconnectTarget, setDisconnectTarget] = useState<string | null>(null);

  // Handle Meta page selection
  useEffect(() => {
    if (metaPages && metaPages.length > 0) {
      setSelectedPageIds(metaPages.map((p: any) => p.id));
    }
  }, [metaPages]);

  const handleConnectFacebook = async () => {
    const url = await metaOAuthUrl.mutateAsync();
    if (url) window.location.href = url;
  };

  const handleConnectMetaPages = async () => {
    if (!metaSetupToken || selectedPageIds.length === 0) return;
    await connectMeta.mutateAsync({ pageIds: selectedPageIds, sessionToken: metaSetupToken });
    setSearchParams({});
  };

  const handleConnectTelegram = async () => {
    if (!botToken.trim()) return;
    await connectTelegram.mutateAsync({ botToken: botToken.trim() });
    setBotToken('');
    setShowTelegramModal(false);
  };

  if (isLoading) {
    return <div className="p-6 text-zinc-400">Loading channels...</div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-white">Channels</h2>
        <p className="text-sm text-zinc-400">
          Connect messaging platforms to receive and respond to customer messages.
        </p>
      </div>

      {/* Meta OAuth page selection (shown after OAuth redirect) */}
      {metaPages && metaPages.length > 0 && (
        <Card variant="glass">
          <CardHeader>
            <h3 className="text-sm font-medium text-white">Select Pages to Connect</h3>
            <p className="text-xs text-zinc-400">Choose which Facebook Pages to connect for messaging.</p>
          </CardHeader>
          <CardContent className="space-y-3">
            {metaPages.map((page: any) => (
              <label key={page.id} className="flex items-center gap-3 p-2 rounded hover:bg-white/5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={selectedPageIds.includes(page.id)}
                  onChange={(e) => {
                    setSelectedPageIds((prev) =>
                      e.target.checked ? [...prev, page.id] : prev.filter((id) => id !== page.id),
                    );
                  }}
                  className="rounded border-zinc-600"
                />
                <span className="text-sm text-white">{page.name}</span>
                {page.instagramAccount && (
                  <Badge variant="outline" className="text-xs">
                    <Instagram className="h-3 w-3 mr-1" />
                    @{page.instagramAccount.username}
                  </Badge>
                )}
              </label>
            ))}
            <div className="flex gap-2 pt-2">
              <Button onClick={handleConnectMetaPages} disabled={selectedPageIds.length === 0 || connectMeta.isPending}>
                {connectMeta.isPending ? 'Connecting...' : 'Connect Selected'}
              </Button>
              <Button variant="ghost" onClick={() => setSearchParams({})}>Cancel</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Connected channels list */}
      <Card variant="glass">
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <h3 className="text-sm font-medium text-white">Connected Channels</h3>
            <p className="text-xs text-zinc-400">
              {connections?.length || 0} channel{connections?.length !== 1 ? 's' : ''} connected
            </p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setShowTelegramModal(true)}>
              <Bot className="h-4 w-4 mr-1" /> Telegram
            </Button>
            <Button size="sm" variant="outline" onClick={handleConnectFacebook} disabled={metaOAuthUrl.isPending}>
              <Facebook className="h-4 w-4 mr-1" /> Facebook
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {!connections || connections.length === 0 ? (
            <div className="text-center py-8 text-zinc-500">
              <MessageSquare className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p className="text-sm">No channels connected yet.</p>
              <p className="text-xs mt-1">Connect a Telegram bot or Facebook Page to get started.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {connections.map((conn) => {
                const Icon = CHANNEL_ICONS[conn.channel] || MessageSquare;
                return (
                  <div
                    key={conn.id}
                    className="flex items-center justify-between p-3 rounded-lg bg-white/5 hover:bg-white/[0.07] transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <Icon className="h-5 w-5 text-zinc-400" />
                      <div>
                        <p className="text-sm font-medium text-white">
                          {conn.label || conn.platformAccountId}
                        </p>
                        <p className="text-xs text-zinc-500">
                          {CHANNEL_LABELS[conn.channel] || conn.channel}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {conn.lastError && (
                        <span className="text-xs text-red-400 max-w-[200px] truncate" title={conn.lastError}>
                          <AlertCircle className="h-3 w-3 inline mr-1" />
                          {conn.lastError}
                        </span>
                      )}
                      <Badge variant="outline" className={STATUS_COLORS[conn.status] || ''}>
                        {conn.status}
                      </Badge>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-red-400 hover:text-red-300"
                        onClick={() => setDisconnectTarget(conn.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Telegram connect modal */}
      <AlertDialog open={showTelegramModal} onOpenChange={setShowTelegramModal}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Connect Telegram Bot</AlertDialogTitle>
            <AlertDialogDescription>
              Enter your bot token from @BotFather to connect a Telegram bot.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="py-4">
            <Label htmlFor="botToken">Bot Token</Label>
            <Input
              id="botToken"
              type="password"
              placeholder="123456:ABC-DEF..."
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConnectTelegram} disabled={!botToken.trim() || connectTelegram.isPending}>
              {connectTelegram.isPending ? 'Connecting...' : 'Connect'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Disconnect confirmation */}
      <AlertDialog open={!!disconnectTarget} onOpenChange={() => setDisconnectTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect Channel</AlertDialogTitle>
            <AlertDialogDescription>
              This will stop receiving messages from this channel. You can reconnect it later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              onClick={() => {
                if (disconnectTarget) {
                  disconnectMutation.mutate(disconnectTarget);
                  setDisconnectTarget(null);
                }
              }}
            >
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
```

- [ ] **Step 3: Add Channels to settings nav**

In `portal/src/pages/settings/SettingsLayout.tsx`, add import and nav item. Read the file first to find the exact location. Add `MessageSquare` to the lucide import, then add to the `settingsNav` array:

```typescript
{ path: '/settings/channels', label: 'Channels', icon: MessageSquare, group: 'Workspace' },
```

- [ ] **Step 4: Add route in App.tsx**

In `portal/src/App.tsx`, add import and route. Read the file first. Add:

```typescript
import ChannelsSettings from './pages/settings/ChannelsSettings';
```

And inside the settings Route group:

```typescript
<Route path="channels" element={<ChannelsSettings />} />
```

- [ ] **Step 5: Verify compilation**

```bash
cd chatbot-platform/portal && npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 6: Commit**

```bash
git add portal/src/pages/settings/ChannelsSettings.tsx portal/src/queries/useChannelQueries.ts \
  portal/src/pages/settings/SettingsLayout.tsx portal/src/App.tsx
git commit -m "feat: add /settings/channels page with Telegram and Meta connection UI"
```

---

### Task 11: Unit Tests

**Files:**
- Create: `api/src/__tests__/unit/meta-normalizer.test.ts`

- [ ] **Step 1: Create Meta normalizer tests**

Create `api/src/__tests__/unit/meta-normalizer.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { normalizeMetaPayload } from '../../channels/meta/event-normalizer';

describe('Meta Event Normalizer', () => {
  describe('Messenger text messages', () => {
    it('should normalize a text message', () => {
      const payload = {
        object: 'page' as const,
        entry: [{
          id: 'PAGE_123',
          time: 1711756800,
          messaging: [{
            sender: { id: 'USER_456' },
            recipient: { id: 'PAGE_123' },
            timestamp: 1711756800000,
            message: { mid: 'm_abc123', text: 'Hello from Messenger!' },
          }],
        }],
      };

      const results = normalizeMetaPayload(payload);
      expect(results).toHaveLength(1);
      expect(results[0].channel).toBe('messenger');
      expect(results[0].recipientId).toBe('PAGE_123');
      expect(results[0].event.type).toBe('message');
      expect(results[0].event.message?.type).toBe('text');
      expect(results[0].event.message?.content).toBe('Hello from Messenger!');
      expect(results[0].event.sender.externalUserId).toBe('USER_456');
    });

    it('should skip echo messages', () => {
      const payload = {
        object: 'page' as const,
        entry: [{
          id: 'PAGE_123',
          time: 1711756800,
          messaging: [{
            sender: { id: 'PAGE_123' },
            recipient: { id: 'USER_456' },
            timestamp: 1711756800000,
            message: { mid: 'm_echo', text: 'Bot reply', is_echo: true },
          }],
        }],
      };

      const results = normalizeMetaPayload(payload);
      expect(results).toHaveLength(0);
    });
  });

  describe('Instagram messages', () => {
    it('should normalize an Instagram text message', () => {
      const payload = {
        object: 'instagram' as const,
        entry: [{
          id: 'IG_BIZ_789',
          time: 1711756800,
          messaging: [{
            sender: { id: 'IGSID_111' },
            recipient: { id: 'IG_BIZ_789' },
            timestamp: 1711756800000,
            message: { mid: 'm_ig_abc', text: 'Hello from Instagram!' },
          }],
        }],
      };

      const results = normalizeMetaPayload(payload);
      expect(results).toHaveLength(1);
      expect(results[0].channel).toBe('instagram');
      expect(results[0].recipientId).toBe('IG_BIZ_789');
      expect(results[0].event.message?.content).toBe('Hello from Instagram!');
    });
  });

  describe('attachments', () => {
    it('should normalize an image attachment', () => {
      const payload = {
        object: 'page' as const,
        entry: [{
          id: 'PAGE_123',
          time: 1711756800,
          messaging: [{
            sender: { id: 'USER_456' },
            recipient: { id: 'PAGE_123' },
            timestamp: 1711756800000,
            message: {
              mid: 'm_img',
              attachments: [{
                type: 'image' as const,
                payload: { url: 'https://example.com/photo.jpg' },
              }],
            },
          }],
        }],
      };

      const results = normalizeMetaPayload(payload);
      expect(results).toHaveLength(1);
      expect(results[0].event.message?.type).toBe('image');
      expect(results[0].event.message?.mediaUrl).toBe('https://example.com/photo.jpg');
    });
  });

  describe('postbacks and quick replies', () => {
    it('should normalize a postback', () => {
      const payload = {
        object: 'page' as const,
        entry: [{
          id: 'PAGE_123',
          time: 1711756800,
          messaging: [{
            sender: { id: 'USER_456' },
            recipient: { id: 'PAGE_123' },
            timestamp: 1711756800000,
            postback: { title: 'Get Started', payload: 'GET_STARTED' },
          }],
        }],
      };

      const results = normalizeMetaPayload(payload);
      expect(results).toHaveLength(1);
      expect(results[0].event.type).toBe('postback');
      expect(results[0].event.postback?.payload).toBe('GET_STARTED');
    });

    it('should normalize a quick reply as postback', () => {
      const payload = {
        object: 'page' as const,
        entry: [{
          id: 'PAGE_123',
          time: 1711756800,
          messaging: [{
            sender: { id: 'USER_456' },
            recipient: { id: 'PAGE_123' },
            timestamp: 1711756800000,
            message: {
              mid: 'm_qr',
              text: 'Option A',
              quick_reply: { payload: 'OPTION_A' },
            },
          }],
        }],
      };

      const results = normalizeMetaPayload(payload);
      expect(results).toHaveLength(1);
      expect(results[0].event.type).toBe('postback');
      expect(results[0].event.postback?.payload).toBe('OPTION_A');
    });
  });

  describe('delivery and read receipts', () => {
    it('should normalize delivery receipt', () => {
      const payload = {
        object: 'page' as const,
        entry: [{
          id: 'PAGE_123',
          time: 1711756800,
          messaging: [{
            sender: { id: 'USER_456' },
            recipient: { id: 'PAGE_123' },
            timestamp: 1711756800000,
            delivery: { mids: ['m_1', 'm_2'], watermark: 1711756800000 },
          }],
        }],
      };

      const results = normalizeMetaPayload(payload);
      expect(results).toHaveLength(1);
      expect(results[0].event.type).toBe('delivery');
      expect(results[0].event.receipt?.messageIds).toEqual(['m_1', 'm_2']);
    });

    it('should normalize read receipt as log-only', () => {
      const payload = {
        object: 'page' as const,
        entry: [{
          id: 'PAGE_123',
          time: 1711756800,
          messaging: [{
            sender: { id: 'USER_456' },
            recipient: { id: 'PAGE_123' },
            timestamp: 1711756800000,
            read: { watermark: 1711756800000 },
          }],
        }],
      };

      const results = normalizeMetaPayload(payload);
      expect(results).toHaveLength(1);
      expect(results[0].event.type).toBe('read');
      expect(results[0].event.receipt?.messageIds).toEqual([]);
    });
  });

  describe('multiple events in single webhook', () => {
    it('should normalize multiple events from different pages', () => {
      const payload = {
        object: 'page' as const,
        entry: [
          {
            id: 'PAGE_A',
            time: 1711756800,
            messaging: [{
              sender: { id: 'USER_1' },
              recipient: { id: 'PAGE_A' },
              timestamp: 1711756800000,
              message: { mid: 'm_1', text: 'Message to Page A' },
            }],
          },
          {
            id: 'PAGE_B',
            time: 1711756800,
            messaging: [{
              sender: { id: 'USER_2' },
              recipient: { id: 'PAGE_B' },
              timestamp: 1711756800000,
              message: { mid: 'm_2', text: 'Message to Page B' },
            }],
          },
        ],
      };

      const results = normalizeMetaPayload(payload);
      expect(results).toHaveLength(2);
      expect(results[0].recipientId).toBe('PAGE_A');
      expect(results[1].recipientId).toBe('PAGE_B');
    });
  });
});
```

- [ ] **Step 2: Run tests**

```bash
cd chatbot-platform/api && npx vitest run src/__tests__/unit/meta-normalizer.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add api/src/__tests__/unit/meta-normalizer.test.ts
git commit -m "test: add Meta event normalizer unit tests"
```

---

## Summary

| Task | What it builds |
|------|---------------|
| 1 | Environment config + migration (partial unique index + lastInboundAt) |
| 2 | Credential helpers + connection resolver |
| 3 | Meta event normalizer (shared Messenger + IG) |
| 4 | Webhook route (HMAC, challenge, dispatcher) + server mount |
| 5 | Messenger outbound transport (Send API, typing, carousels) |
| 6 | Instagram outbound transport (IG Send API) |
| 7 | OAuth service + routes (login URL, callback, page listing, connect) |
| 8 | Setup + disconnect services (webhook subscription, cleanup) |
| 9 | Profile service + adapter registration |
| 10 | Portal /settings/channels page (list, connect, disconnect UI) |
| 11 | Unit tests for Meta normalizer |
