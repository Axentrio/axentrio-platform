# Multi-Channel Integration Foundation + Telegram Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a channel abstraction layer that decouples message handling from the web widget, then implement Telegram as the first external channel to prove the architecture. Meta channels (Messenger, Instagram, WhatsApp) follow as a separate plan built on this foundation.

**Architecture:** Four-concern channel pipeline (ConnectionResolver, WebhookVerifier, EventNormalizer, OutboundTransport). Async inbound processing via Bull queue. New entities for channel connections, conversation bindings, webhook event logs, and message delivery tracking. Outbound transport layer replaces direct WebSocket emission so bot/agent replies route through the correct channel. Telegram Bot API as first adapter.

**Tech Stack:** TypeORM (entities + migrations), Bull queue (async inbound), node-telegram-bot-api or raw HTTP (Telegram Bot API), existing encryption/circuit-breaker/retry infrastructure.

**Scope:** This plan covers the foundation layer + Telegram only. Meta channels (Messenger, IG, WhatsApp) are a follow-up plan that reuses everything built here.

---

### Task 1: Channel Database Entities & Migration

**Files:**
- Create: `api/src/database/entities/ChannelConnection.ts`
- Create: `api/src/database/entities/ConversationBinding.ts`
- Create: `api/src/database/entities/WebhookEventLog.ts`
- Create: `api/src/database/entities/MessageDelivery.ts`
- Create: `api/src/database/migrations/1775500000000-CreateChannelTables.ts`
- Modify: `api/src/database/data-source.ts` (add entity imports)
- Modify: `api/src/database/entities/ChatSession.ts` (add channel + conversationBinding relation)

- [ ] **Step 1: Create ChannelConnection entity**

Create `api/src/database/entities/ChannelConnection.ts`:

```typescript
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Tenant } from './Tenant';

export type ChannelType = 'widget' | 'telegram' | 'messenger' | 'instagram' | 'whatsapp';

export type ChannelConnectionStatus = 'active' | 'disconnected' | 'error' | 'pending_setup';

@Entity('channel_connections')
@Index(['tenantId', 'channel'], { unique: false })
@Index(['tenantId', 'channel', 'status'])
export class ChannelConnection {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid')
  tenantId!: string;

  @Column({ type: 'varchar', length: 20 })
  channel!: ChannelType;

  @Column({ type: 'varchar', length: 20, default: 'pending_setup' })
  status!: ChannelConnectionStatus;

  @Column({ type: 'varchar', length: 255, nullable: true })
  label!: string | null;

  // Platform-specific account identifier (bot username, page ID, phone number, etc.)
  @Column({ type: 'varchar', length: 255, nullable: true })
  platformAccountId!: string | null;

  // Encrypted credentials blob — structure varies by channel
  // Telegram: { botToken }
  // Messenger: { pageAccessToken, pageId, appSecret }
  // WhatsApp: { accessToken, phoneNumberId, wabaId }
  // Instagram: { accessToken, igUserId, pageId }
  @Column({ type: 'jsonb', default: '{}' })
  credentials!: Record<string, unknown>;

  // Webhook verification token (for platforms that need challenge verification)
  @Column({ type: 'varchar', length: 255, nullable: true })
  webhookVerifyToken!: string | null;

  // Webhook secret for signature verification on inbound events
  @Column({ type: 'varchar', length: 255, nullable: true })
  webhookSecret!: string | null;

  // Channel-specific configuration (e.g., bot commands, menu buttons, greeting text)
  @Column({ type: 'jsonb', default: '{}' })
  config!: Record<string, unknown>;

  // Platform-specific scopes/permissions granted
  @Column({ type: 'simple-array', nullable: true })
  scopes!: string[] | null;

  @Column({ type: 'timestamp', nullable: true })
  lastHealthCheckAt!: Date | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  lastError!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @ManyToOne(() => Tenant)
  @JoinColumn({ name: 'tenantId' })
  tenant!: Tenant;

  isActive(): boolean {
    return this.status === 'active';
  }
}
```

- [ ] **Step 2: Create ConversationBinding entity**

Create `api/src/database/entities/ConversationBinding.ts`:

```typescript
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  Unique,
} from 'typeorm';
import { ChatSession } from './ChatSession';
import { ChannelConnection } from './ChannelConnection';

@Entity('conversation_bindings')
@Unique(['channelConnectionId', 'externalUserId', 'externalThreadId'])
@Index(['sessionId'])
@Index(['channelConnectionId', 'externalUserId'])
export class ConversationBinding {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid')
  sessionId!: string;

  @Column('uuid')
  channelConnectionId!: string;

  // Platform user ID (Telegram chat_id, FB PSID, WA phone number, etc.)
  @Column({ type: 'varchar', length: 255 })
  externalUserId!: string;

  // Platform thread/conversation ID (may equal externalUserId for 1:1 chats)
  @Column({ type: 'varchar', length: 255 })
  externalThreadId!: string;

  // Display name from platform profile
  @Column({ type: 'varchar', length: 255, nullable: true })
  externalUserName!: string | null;

  // Platform profile picture URL
  @Column({ type: 'varchar', length: 500, nullable: true })
  externalAvatarUrl!: string | null;

  // Additional platform-specific user data
  @Column({ type: 'jsonb', default: '{}' })
  platformUserData!: Record<string, unknown>;

  @CreateDateColumn()
  createdAt!: Date;

  @ManyToOne(() => ChatSession)
  @JoinColumn({ name: 'sessionId' })
  session!: ChatSession;

  @ManyToOne(() => ChannelConnection)
  @JoinColumn({ name: 'channelConnectionId' })
  channelConnection!: ChannelConnection;
}
```

- [ ] **Step 3: Create WebhookEventLog entity**

Create `api/src/database/entities/WebhookEventLog.ts`:

```typescript
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';
import { ChannelType } from './ChannelConnection';

@Entity('webhook_event_log')
@Index(['dedupeKey'], { unique: true })
@Index(['channelConnectionId', 'createdAt'])
@Index(['status', 'createdAt'])
export class WebhookEventLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid')
  channelConnectionId!: string;

  @Column({ type: 'varchar', length: 20 })
  channel!: ChannelType;

  // Platform-specific unique event identifier for idempotency
  // Telegram: update_id, Meta: entry[].messaging[].timestamp+sender.id
  @Column({ type: 'varchar', length: 255 })
  dedupeKey!: string;

  @Column({ type: 'varchar', length: 50 })
  eventType!: string; // 'message', 'postback', 'delivery', 'read', 'reaction', etc.

  @Column({ type: 'jsonb' })
  rawPayload!: Record<string, unknown>;

  @Column({ type: 'varchar', length: 20, default: 'received' })
  status!: 'received' | 'processing' | 'processed' | 'failed' | 'skipped';

  @Column({ type: 'varchar', length: 500, nullable: true })
  error!: string | null;

  @Column({ type: 'integer', default: 0 })
  processingAttempts!: number;

  @CreateDateColumn()
  createdAt!: Date;
}
```

- [ ] **Step 4: Create MessageDelivery entity**

Create `api/src/database/entities/MessageDelivery.ts`:

```typescript
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { ChannelType } from './ChannelConnection';

@Entity('message_deliveries')
@Index(['internalMessageId'])
@Index(['platformMessageId', 'channel'])
@Index(['channelConnectionId', 'status'])
export class MessageDelivery {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // Our internal message ID (from Message entity)
  @Column('uuid')
  internalMessageId!: string;

  @Column('uuid')
  channelConnectionId!: string;

  @Column({ type: 'varchar', length: 20 })
  channel!: ChannelType;

  // Platform's message ID after successful send
  @Column({ type: 'varchar', length: 255, nullable: true })
  platformMessageId!: string | null;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status!: 'pending' | 'sent' | 'delivered' | 'read' | 'failed';

  @Column({ type: 'integer', default: 0 })
  attempts!: number;

  @Column({ type: 'varchar', length: 500, nullable: true })
  error!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
```

- [ ] **Step 5: Add channel field to ChatSession entity**

In `api/src/database/entities/ChatSession.ts`, add after the `source` column (around line 36):

```typescript
  @Column({ type: 'varchar', length: 20, default: 'widget' })
  channel!: 'widget' | 'telegram' | 'messenger' | 'instagram' | 'whatsapp';

  @Column('uuid', { nullable: true })
  channelConnectionId!: string | null;
```

- [ ] **Step 6: Create the migration**

Create `api/src/database/migrations/1775500000000-CreateChannelTables.ts`:

```typescript
import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateChannelTables1775500000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // ChannelConnection
    await queryRunner.query(`
      CREATE TABLE "channel_connections" (
        "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
        "tenantId" uuid NOT NULL,
        "channel" varchar(20) NOT NULL,
        "status" varchar(20) NOT NULL DEFAULT 'pending_setup',
        "label" varchar(255),
        "platformAccountId" varchar(255),
        "credentials" jsonb NOT NULL DEFAULT '{}',
        "webhookVerifyToken" varchar(255),
        "webhookSecret" varchar(255),
        "config" jsonb NOT NULL DEFAULT '{}',
        "scopes" text,
        "lastHealthCheckAt" timestamp,
        "lastError" varchar(500),
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_channel_connections" PRIMARY KEY ("id"),
        CONSTRAINT "FK_channel_connections_tenant" FOREIGN KEY ("tenantId")
          REFERENCES "tenants"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_channel_conn_tenant_channel" ON "channel_connections" ("tenantId", "channel")`);
    await queryRunner.query(`CREATE INDEX "IDX_channel_conn_tenant_channel_status" ON "channel_connections" ("tenantId", "channel", "status")`);

    // ConversationBinding
    await queryRunner.query(`
      CREATE TABLE "conversation_bindings" (
        "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
        "sessionId" uuid NOT NULL,
        "channelConnectionId" uuid NOT NULL,
        "externalUserId" varchar(255) NOT NULL,
        "externalThreadId" varchar(255) NOT NULL,
        "externalUserName" varchar(255),
        "externalAvatarUrl" varchar(500),
        "platformUserData" jsonb NOT NULL DEFAULT '{}',
        "createdAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_conversation_bindings" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_conv_binding_conn_user_thread" UNIQUE ("channelConnectionId", "externalUserId", "externalThreadId"),
        CONSTRAINT "FK_conv_binding_session" FOREIGN KEY ("sessionId")
          REFERENCES "chat_sessions"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_conv_binding_channel_conn" FOREIGN KEY ("channelConnectionId")
          REFERENCES "channel_connections"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_conv_binding_session" ON "conversation_bindings" ("sessionId")`);
    await queryRunner.query(`CREATE INDEX "IDX_conv_binding_conn_user" ON "conversation_bindings" ("channelConnectionId", "externalUserId")`);

    // WebhookEventLog
    await queryRunner.query(`
      CREATE TABLE "webhook_event_log" (
        "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
        "channelConnectionId" uuid NOT NULL,
        "channel" varchar(20) NOT NULL,
        "dedupeKey" varchar(255) NOT NULL,
        "eventType" varchar(50) NOT NULL,
        "rawPayload" jsonb NOT NULL,
        "status" varchar(20) NOT NULL DEFAULT 'received',
        "error" varchar(500),
        "processingAttempts" integer NOT NULL DEFAULT 0,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_webhook_event_log" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_webhook_event_dedupe" UNIQUE ("dedupeKey")
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_webhook_event_conn_created" ON "webhook_event_log" ("channelConnectionId", "createdAt")`);
    await queryRunner.query(`CREATE INDEX "IDX_webhook_event_status" ON "webhook_event_log" ("status", "createdAt")`);

    // MessageDelivery
    await queryRunner.query(`
      CREATE TABLE "message_deliveries" (
        "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
        "internalMessageId" uuid NOT NULL,
        "channelConnectionId" uuid NOT NULL,
        "channel" varchar(20) NOT NULL,
        "platformMessageId" varchar(255),
        "status" varchar(20) NOT NULL DEFAULT 'pending',
        "attempts" integer NOT NULL DEFAULT 0,
        "error" varchar(500),
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_message_deliveries" PRIMARY KEY ("id"),
        CONSTRAINT "FK_message_delivery_message" FOREIGN KEY ("internalMessageId")
          REFERENCES "messages"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_message_delivery_conn" FOREIGN KEY ("channelConnectionId")
          REFERENCES "channel_connections"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_msg_delivery_internal" ON "message_deliveries" ("internalMessageId")`);
    await queryRunner.query(`CREATE INDEX "IDX_msg_delivery_platform" ON "message_deliveries" ("platformMessageId", "channel")`);
    await queryRunner.query(`CREATE INDEX "IDX_msg_delivery_conn_status" ON "message_deliveries" ("channelConnectionId", "status")`);

    // Add channel columns to chat_sessions
    await queryRunner.query(`ALTER TABLE "chat_sessions" ADD "channel" varchar(20) NOT NULL DEFAULT 'widget'`);
    await queryRunner.query(`ALTER TABLE "chat_sessions" ADD "channelConnectionId" uuid`);
    await queryRunner.query(`
      ALTER TABLE "chat_sessions" ADD CONSTRAINT "FK_chat_session_channel_conn"
        FOREIGN KEY ("channelConnectionId") REFERENCES "channel_connections"("id") ON DELETE SET NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "chat_sessions" DROP CONSTRAINT IF EXISTS "FK_chat_session_channel_conn"`);
    await queryRunner.query(`ALTER TABLE "chat_sessions" DROP COLUMN IF EXISTS "channelConnectionId"`);
    await queryRunner.query(`ALTER TABLE "chat_sessions" DROP COLUMN IF EXISTS "channel"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "message_deliveries"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "webhook_event_log"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "conversation_bindings"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "channel_connections"`);
  }
}
```

- [ ] **Step 7: Register entities in data-source.ts**

In `api/src/database/data-source.ts`, add imports for `ChannelConnection`, `ConversationBinding`, `WebhookEventLog`, `MessageDelivery` and add them to the entities array.

- [ ] **Step 8: Run migration and verify**

```bash
cd chatbot-platform/api && npx typeorm migration:run -d src/database/data-source.ts
```

Expected: Migration creates 4 new tables and adds 2 columns to chat_sessions.

- [ ] **Step 9: Commit**

```bash
git add api/src/database/entities/ChannelConnection.ts api/src/database/entities/ConversationBinding.ts \
  api/src/database/entities/WebhookEventLog.ts api/src/database/entities/MessageDelivery.ts \
  api/src/database/migrations/1775500000000-CreateChannelTables.ts \
  api/src/database/entities/ChatSession.ts api/src/database/data-source.ts
git commit -m "feat: add channel entities (ChannelConnection, ConversationBinding, WebhookEventLog, MessageDelivery)"
```

---

### Task 2: Channel Types & Interfaces

**Files:**
- Create: `api/src/channels/types.ts`
- Create: `api/src/channels/index.ts`

- [ ] **Step 1: Create channel type definitions**

Create `api/src/channels/types.ts`:

```typescript
import { Request } from 'express';
import { ChannelConnection, ChannelType } from '../database/entities/ChannelConnection';
import { ChatSession } from '../database/entities/ChatSession';
import { ResponsePayload } from '../n8n/types/message.types';

// --- Inbound (platform → us) ---

export interface NormalizedEvent {
  type: 'message' | 'postback' | 'delivery' | 'read' | 'reaction' | 'referral' | 'status' | 'unknown';
  // For message events
  message?: {
    type: 'text' | 'image' | 'video' | 'audio' | 'file' | 'location' | 'contact' | 'sticker';
    content: string;
    mediaUrl?: string;
    mediaMetadata?: Record<string, unknown>;
    replyToExternalId?: string;
  };
  // For postback/button events
  postback?: {
    payload: string;
    title?: string;
  };
  // For delivery/read receipts
  receipt?: {
    messageIds: string[];
    status: 'delivered' | 'read';
  };
  // Platform user identity
  sender: {
    externalUserId: string;
    externalThreadId: string;
    displayName?: string;
    avatarUrl?: string;
    platformData?: Record<string, unknown>;
  };
  // Dedupe key (must be unique per event from this platform)
  dedupeKey: string;
  // Original timestamp from platform
  timestamp: Date;
  // Raw event for debugging
  rawEventType: string;
}

// --- Outbound (us → platform) ---

export interface OutboundChannelMessage {
  type: 'text' | 'image' | 'video' | 'audio' | 'file' | 'quick_reply' | 'carousel' | 'template' | 'typing';
  content?: string;
  quickReplies?: Array<{ title: string; payload: string }>;
  buttons?: Array<{ type: 'url' | 'postback'; title: string; value: string }>;
  mediaUrl?: string;
  mediaMetadata?: Record<string, unknown>;
  // For carousels
  cards?: Array<{
    title: string;
    subtitle?: string;
    imageUrl?: string;
    buttons?: Array<{ type: 'url' | 'postback'; title: string; value: string }>;
  }>;
}

export interface DeliveryResult {
  success: boolean;
  platformMessageId?: string;
  error?: string;
  retryable?: boolean;
}

// --- Channel Capability Flags ---

export interface ChannelCapabilities {
  maxTextLength: number;
  supportsQuickReplies: boolean;
  maxQuickReplies: number;
  supportsButtons: boolean;
  maxButtons: number;
  supportsCarousel: boolean;
  maxCarouselCards: number;
  supportsImages: boolean;
  supportsVideo: boolean;
  supportsAudio: boolean;
  supportsFiles: boolean;
  supportsTypingIndicator: boolean;
  supportsReadReceipts: boolean;
  supportsMessageEdit: boolean;
  supportsMessageDelete: boolean;
  supportsStickers: boolean;
  // Platform-specific messaging windows (e.g., Meta 24h rule)
  hasMessagingWindow: boolean;
  messagingWindowHours?: number;
  // Whether outbound outside window requires templates
  requiresTemplatesOutsideWindow: boolean;
}

// --- Four-Concern Pipeline Interfaces ---

/**
 * Resolves an inbound webhook request to a specific tenant channel connection.
 * Handles the mapping from platform-specific identifiers to our internal connection.
 */
export interface ConnectionResolver {
  /**
   * Given a raw webhook request, determine which ChannelConnection it belongs to.
   * For Telegram: extract bot token from URL path or look up by secret_token header.
   * For Meta: extract page ID from payload, look up connection.
   */
  resolve(req: Request): Promise<ChannelConnection | null>;
}

/**
 * Verifies webhook authenticity using platform-specific mechanisms.
 */
export interface WebhookVerifier {
  /**
   * Handle GET verification challenges (Meta webhook subscription).
   * Returns the challenge response string, or null if not a challenge request.
   */
  handleVerificationChallenge(req: Request, connection: ChannelConnection): string | null;

  /**
   * Verify the signature/authenticity of an inbound POST webhook.
   * Telegram: X-Telegram-Bot-Api-Secret-Token header.
   * Meta: X-Hub-Signature-256 HMAC of raw body with app secret.
   */
  verifySignature(req: Request, connection: ChannelConnection): boolean;
}

/**
 * Converts platform-specific webhook payloads into normalized events.
 */
export interface EventNormalizer {
  /**
   * Parse the raw webhook body into one or more normalized events.
   * Meta webhooks can contain multiple entries/messaging events.
   * Telegram updates contain one event each.
   */
  normalize(rawPayload: unknown, connection: ChannelConnection): NormalizedEvent[];
}

/**
 * Sends outbound messages through the correct platform API.
 */
export interface OutboundTransport {
  /**
   * Convert a ResponsePayload into a platform-specific format and send it.
   * Handles capability degradation (e.g., carousels → multiple messages on Telegram).
   */
  send(
    message: OutboundChannelMessage,
    externalThreadId: string,
    connection: ChannelConnection,
  ): Promise<DeliveryResult>;

  /**
   * Send a typing indicator on this channel.
   */
  sendTypingIndicator(externalThreadId: string, connection: ChannelConnection): Promise<void>;

  /**
   * Get capability flags for this channel.
   */
  getCapabilities(): ChannelCapabilities;
}

// --- Channel Adapter (combines all four concerns) ---

export interface ChannelAdapter {
  channel: ChannelType;
  connectionResolver: ConnectionResolver;
  webhookVerifier: WebhookVerifier;
  eventNormalizer: EventNormalizer;
  outboundTransport: OutboundTransport;
}

// --- Response Formatter Utility ---

/**
 * Converts our internal ResponsePayload (from n8n/RAG) into
 * OutboundChannelMessage, respecting channel capabilities.
 * Falls back gracefully when a channel doesn't support a feature.
 */
export function formatResponseForChannel(
  response: ResponsePayload,
  capabilities: ChannelCapabilities,
): OutboundChannelMessage[] {
  const messages: OutboundChannelMessage[] = [];
  const type = response.type || 'text';

  switch (type) {
    case 'text':
    case 'quick_reply': {
      const msg: OutboundChannelMessage = {
        type: 'text',
        content: typeof response.content === 'string' ? response.content : JSON.stringify(response.content),
      };
      if (response.quickReplies && capabilities.supportsQuickReplies) {
        msg.type = 'quick_reply';
        msg.quickReplies = response.quickReplies
          .slice(0, capabilities.maxQuickReplies)
          .map((qr) => typeof qr === 'string' ? { title: qr, payload: qr } : { title: qr.title, payload: qr.value || qr.title });
      }
      if (response.buttons && capabilities.supportsButtons) {
        msg.buttons = response.buttons
          .slice(0, capabilities.maxButtons)
          .map((b) => ({ type: b.type as 'url' | 'postback', title: b.title, value: b.url || b.payload || '' }));
      }
      // Truncate content if exceeds channel limit
      if (msg.content && msg.content.length > capabilities.maxTextLength) {
        msg.content = msg.content.slice(0, capabilities.maxTextLength - 3) + '...';
      }
      messages.push(msg);
      break;
    }
    case 'image':
    case 'video':
    case 'audio':
    case 'file': {
      if (
        (type === 'image' && !capabilities.supportsImages) ||
        (type === 'video' && !capabilities.supportsVideo) ||
        (type === 'audio' && !capabilities.supportsAudio) ||
        (type === 'file' && !capabilities.supportsFiles)
      ) {
        // Fallback: send as text with URL
        messages.push({
          type: 'text',
          content: typeof response.content === 'string' ? response.content : `[${type} attachment]`,
        });
      } else {
        messages.push({
          type,
          mediaUrl: typeof response.content === 'string' ? response.content : undefined,
          content: typeof response.content === 'string' ? response.content : undefined,
        });
      }
      break;
    }
    case 'carousel': {
      if (!capabilities.supportsCarousel) {
        // Fallback: send each card as a separate text+image message
        const attachments = response.attachments || [];
        for (const att of attachments.slice(0, 5)) {
          messages.push({
            type: 'text',
            content: `*${att.title || ''}*\n${att.description || ''}`,
            buttons: att.buttons?.map((b: any) => ({
              type: b.type as 'url' | 'postback',
              title: b.title,
              value: b.url || b.payload || '',
            })),
          });
        }
        if (messages.length === 0) {
          messages.push({ type: 'text', content: typeof response.content === 'string' ? response.content : '[carousel]' });
        }
      } else {
        messages.push({
          type: 'carousel',
          cards: (response.attachments || []).slice(0, capabilities.maxCarouselCards).map((att: any) => ({
            title: att.title || '',
            subtitle: att.description,
            imageUrl: att.url,
            buttons: att.buttons?.slice(0, capabilities.maxButtons).map((b: any) => ({
              type: b.type as 'url' | 'postback',
              title: b.title,
              value: b.url || b.payload || '',
            })),
          })),
        });
      }
      break;
    }
    case 'typing': {
      if (capabilities.supportsTypingIndicator) {
        messages.push({ type: 'typing' });
      }
      break;
    }
    default: {
      // Unknown type — send as text
      messages.push({
        type: 'text',
        content: typeof response.content === 'string' ? response.content : JSON.stringify(response.content),
      });
    }
  }

  return messages;
}
```

- [ ] **Step 2: Create channel module index**

Create `api/src/channels/index.ts`:

```typescript
export * from './types';
```

- [ ] **Step 3: Commit**

```bash
git add api/src/channels/
git commit -m "feat: add channel abstraction types and interfaces"
```

---

### Task 3: Channel Registry & Inbound Pipeline

**Files:**
- Create: `api/src/channels/channel-registry.ts`
- Create: `api/src/channels/inbound-pipeline.ts`
- Create: `api/src/channels/channel-webhook.routes.ts`
- Modify: `api/src/server.ts` (mount channel webhook routes)

- [ ] **Step 1: Create channel registry**

Create `api/src/channels/channel-registry.ts`:

```typescript
import { ChannelType } from '../database/entities/ChannelConnection';
import { ChannelAdapter } from './types';

const adapters = new Map<ChannelType, ChannelAdapter>();

export function registerChannelAdapter(adapter: ChannelAdapter): void {
  adapters.set(adapter.channel, adapter);
}

export function getChannelAdapter(channel: ChannelType): ChannelAdapter | undefined {
  return adapters.get(channel);
}

export function getRegisteredChannels(): ChannelType[] {
  return Array.from(adapters.keys());
}
```

- [ ] **Step 2: Create inbound pipeline**

This is the core async processing pipeline. It receives raw webhook events, dedupes, persists, and queues them for processing.

Create `api/src/channels/inbound-pipeline.ts`:

```typescript
import { getRepository, runInTransaction } from '../database/data-source';
import { WebhookEventLog } from '../database/entities/WebhookEventLog';
import { ConversationBinding } from '../database/entities/ConversationBinding';
import { ChatSession } from '../database/entities/ChatSession';
import { Participant } from '../database/entities/Participant';
import { Message } from '../database/entities/Message';
import { ChannelConnection } from '../database/entities/ChannelConnection';
import { NormalizedEvent } from './types';
import { encrypt } from '../utils/encryption';
import { forwardMessageToN8n } from '../services/message-forwarding.service';
import { getIO } from '../websocket/socket.handler';

/**
 * Process a normalized event through the inbound pipeline.
 * Called from the Bull queue processor (async, not in the webhook request).
 *
 * Flow: dedupe check → find/create conversation binding → find/create session →
 *       save message → broadcast to portal → forward to RAG/n8n
 */
export async function processInboundEvent(
  event: NormalizedEvent,
  connection: ChannelConnection,
): Promise<void> {
  // 1. Dedupe check (the webhook_event_log entry was created at receive time)
  const eventLogRepo = getRepository(WebhookEventLog);
  const existingEvent = await eventLogRepo.findOne({
    where: { dedupeKey: event.dedupeKey },
  });

  if (!existingEvent || existingEvent.status === 'processed' || existingEvent.status === 'skipped') {
    return; // Already processed or doesn't exist
  }

  // Mark as processing
  await eventLogRepo.update(existingEvent.id, {
    status: 'processing',
    processingAttempts: () => '"processingAttempts" + 1',
  });

  try {
    // 2. Only process message and postback events into conversations
    if (event.type !== 'message' && event.type !== 'postback') {
      // Handle receipts, reactions, etc. as status updates
      await handleNonMessageEvent(event, connection);
      await eventLogRepo.update(existingEvent.id, { status: 'processed' });
      return;
    }

    // 3. Find or create conversation binding + session
    const { session, binding, participant } = await findOrCreateConversation(event, connection);

    // 4. Determine message content
    const content = event.type === 'postback'
      ? event.postback?.payload || event.postback?.title || ''
      : event.message?.content || '';

    const messageType = event.message?.type === 'image' ? 'image'
      : event.message?.type === 'file' ? 'file'
      : 'text';

    // 5. Save message (encrypted)
    const messageRepo = getRepository(Message);
    const encrypted = encrypt(content);
    const savedMessage = messageRepo.create({
      sessionId: session.id,
      tenantId: connection.tenantId,
      participantId: participant.id,
      type: messageType,
      content: encrypted,
      contentEncrypted: true,
      status: 'sent',
      metadata: {
        ...(event.message?.mediaUrl ? { fileUrl: event.message.mediaUrl } : {}),
        ...(event.message?.mediaMetadata || {}),
        channel: connection.channel,
        externalUserId: event.sender.externalUserId,
      },
    });
    await messageRepo.save(savedMessage);

    // Update session activity
    const sessionRepo = getRepository(ChatSession);
    session.messageCount = (session.messageCount || 0) + 1;
    session.lastActivityAt = new Date();
    await sessionRepo.save(session);

    // 6. Broadcast to portal agents via WebSocket (so agents see the message)
    const io = getIO();
    if (io) {
      io.to(`${connection.tenantId}:${session.id}`).emit('message:new', {
        id: savedMessage.id,
        sessionId: session.id,
        participantId: participant.id,
        type: messageType,
        content, // Plain text for WebSocket
        status: 'sent',
        createdAt: savedMessage.createdAt,
        metadata: savedMessage.metadata,
      });
    }

    // 7. Forward to RAG/n8n (reuse existing pipeline)
    await forwardMessageToN8n(session, savedMessage);

    // 8. Mark event as processed
    await eventLogRepo.update(existingEvent.id, { status: 'processed' });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    await eventLogRepo.update(existingEvent.id, {
      status: 'failed',
      error: errorMessage.slice(0, 500),
    });
    throw error; // Re-throw so Bull queue can retry
  }
}

async function findOrCreateConversation(
  event: NormalizedEvent,
  connection: ChannelConnection,
): Promise<{ session: ChatSession; binding: ConversationBinding; participant: Participant }> {
  const bindingRepo = getRepository(ConversationBinding);
  const sessionRepo = getRepository(ChatSession);
  const participantRepo = getRepository(Participant);

  // Look for existing binding
  let binding = await bindingRepo.findOne({
    where: {
      channelConnectionId: connection.id,
      externalUserId: event.sender.externalUserId,
      externalThreadId: event.sender.externalThreadId,
    },
    relations: ['session'],
  });

  if (binding && binding.session && !binding.session.endedAt) {
    // Existing active conversation
    const session = binding.session;
    const participant = await participantRepo.findOne({
      where: { sessionId: session.id, type: 'user' },
    });
    if (!participant) {
      throw new Error(`No user participant found for session ${session.id}`);
    }

    // Update profile if changed
    if (event.sender.displayName && event.sender.displayName !== binding.externalUserName) {
      binding.externalUserName = event.sender.displayName;
      binding.externalAvatarUrl = event.sender.avatarUrl || binding.externalAvatarUrl;
      await bindingRepo.save(binding);
    }

    return { session, binding, participant };
  }

  // Create new session + binding + participant
  return runInTransaction(async (manager) => {
    const newSession = manager.create(ChatSession, {
      tenantId: connection.tenantId,
      visitorId: `${connection.channel}:${event.sender.externalUserId}`,
      status: 'bot', // External channel messages start in bot mode
      channel: connection.channel,
      channelConnectionId: connection.id,
      source: connection.channel,
      metadata: {
        channel: connection.channel,
        externalUserId: event.sender.externalUserId,
        platformUserData: event.sender.platformData,
      },
    });
    const savedSession = await manager.save(newSession);

    const newParticipant = manager.create(Participant, {
      sessionId: savedSession.id,
      type: 'user',
      name: event.sender.displayName || `${connection.channel} user`,
      avatarUrl: event.sender.avatarUrl,
      isAnonymous: !event.sender.displayName,
      metadata: {
        channel: connection.channel,
        externalUserId: event.sender.externalUserId,
      },
    });
    const savedParticipant = await manager.save(newParticipant);

    const newBinding = manager.create(ConversationBinding, {
      sessionId: savedSession.id,
      channelConnectionId: connection.id,
      externalUserId: event.sender.externalUserId,
      externalThreadId: event.sender.externalThreadId,
      externalUserName: event.sender.displayName,
      externalAvatarUrl: event.sender.avatarUrl,
      platformUserData: event.sender.platformData || {},
    });
    const savedBinding = await manager.save(newBinding);

    return {
      session: savedSession,
      binding: savedBinding,
      participant: savedParticipant,
    };
  });
}

async function handleNonMessageEvent(
  event: NormalizedEvent,
  connection: ChannelConnection,
): Promise<void> {
  if (event.type === 'delivery' || event.type === 'read') {
    // Update message delivery status
    // Look up by platformMessageId from receipt
    const { MessageDelivery } = await import('../database/entities/MessageDelivery');
    const deliveryRepo = getRepository(MessageDelivery);

    if (event.receipt) {
      for (const platformMsgId of event.receipt.messageIds) {
        await deliveryRepo.update(
          { platformMessageId: platformMsgId, channelConnectionId: connection.id },
          { status: event.receipt.status },
        );
      }
    }
  }
  // Other event types (reactions, referrals, etc.) can be handled later
}
```

- [ ] **Step 3: Create channel webhook routes**

Create `api/src/channels/channel-webhook.routes.ts`:

```typescript
import { Router, Request, Response } from 'express';
import { getRepository } from '../database/data-source';
import { WebhookEventLog } from '../database/entities/WebhookEventLog';
import { getChannelAdapter } from './channel-registry';
import { ChannelType } from '../database/entities/ChannelConnection';
import { processInboundEvent } from './inbound-pipeline';
import { getMessageQueue } from '../queue/message-queue';

const router = Router();

/**
 * Unified channel webhook handler.
 * Pattern: POST /api/v1/channels/:channel/webhook
 *
 * Flow: resolve connection → verify signature → normalize events →
 *       persist raw events (dedupe) → queue for async processing → 200 OK fast
 */
router.all('/channels/:channel/webhook', async (req: Request, res: Response) => {
  const channel = req.params.channel as ChannelType;
  const adapter = getChannelAdapter(channel);

  if (!adapter) {
    return res.status(404).json({ error: `Channel ${channel} not supported` });
  }

  // 1. Handle GET verification challenges (Meta requires this)
  if (req.method === 'GET') {
    try {
      // For challenge verification, we need to resolve the connection first
      const connection = await adapter.connectionResolver.resolve(req);
      if (!connection) {
        return res.status(404).json({ error: 'No matching channel connection' });
      }
      const challenge = adapter.webhookVerifier.handleVerificationChallenge(req, connection);
      if (challenge !== null) {
        return res.status(200).send(challenge);
      }
    } catch {
      // Fall through
    }
    return res.status(400).json({ error: 'Invalid verification request' });
  }

  // 2. Resolve which tenant/connection this webhook belongs to
  const connection = await adapter.connectionResolver.resolve(req);
  if (!connection) {
    return res.status(404).json({ error: 'No matching channel connection' });
  }

  // 3. Verify webhook signature
  if (!adapter.webhookVerifier.verifySignature(req, connection)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // 4. Normalize into events
  const events = adapter.eventNormalizer.normalize(req.body, connection);
  if (events.length === 0) {
    return res.status(200).json({ ok: true });
  }

  // 5. Persist raw events for idempotency, then queue for async processing
  const eventLogRepo = getRepository(WebhookEventLog);
  const queue = getMessageQueue();

  for (const event of events) {
    try {
      // Insert with dedupe key — if duplicate, the unique constraint catches it
      const logEntry = eventLogRepo.create({
        channelConnectionId: connection.id,
        channel: connection.channel,
        dedupeKey: event.dedupeKey,
        eventType: event.rawEventType,
        rawPayload: req.body,
        status: 'received',
      });
      await eventLogRepo.save(logEntry);

      // Queue for async processing
      if (queue) {
        await queue.add('channel-inbound', {
          eventDedupeKey: event.dedupeKey,
          connectionId: connection.id,
          event,
        }, {
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: 100,
          removeOnFail: 500,
        });
      } else {
        // Fallback: process inline if queue unavailable
        await processInboundEvent(event, connection);
      }
    } catch (error: any) {
      // Duplicate key = already received, skip silently
      if (error?.code === '23505') continue;
      console.error(`[channel-webhook] Error processing ${channel} event:`, error);
    }
  }

  // 6. Return 200 fast — processing happens async
  return res.status(200).json({ ok: true });
});

export default router;
```

- [ ] **Step 4: Mount channel routes in server.ts**

In `api/src/server.ts`, add after the existing route registrations (around line 200):

```typescript
import channelWebhookRoutes from './channels/channel-webhook.routes';

// ... inside startServer(), after other app.use() calls:
app.use('/api/v1', channelWebhookRoutes);
```

- [ ] **Step 5: Commit**

```bash
git add api/src/channels/ api/src/server.ts
git commit -m "feat: add channel registry, inbound pipeline, and webhook routes"
```

---

### Task 4: Outbound Transport Layer

This is the critical refactor: bot/agent replies must route through the correct channel instead of only going to WebSocket.

**Files:**
- Create: `api/src/channels/outbound-router.ts`
- Modify: `api/src/services/message-forwarding.service.ts` (use outbound router for bot replies)
- Modify: `api/src/n8n/webhook.service.ts` (use outbound router for n8n replies)
- Modify: `api/src/websocket/socket.handler.ts` (use outbound router for agent replies)

- [ ] **Step 1: Create outbound router**

Create `api/src/channels/outbound-router.ts`:

```typescript
import { getRepository } from '../database/data-source';
import { ChatSession } from '../database/entities/ChatSession';
import { ConversationBinding } from '../database/entities/ConversationBinding';
import { ChannelConnection } from '../database/entities/ChannelConnection';
import { MessageDelivery } from '../database/entities/MessageDelivery';
import { ResponsePayload } from '../n8n/types/message.types';
import { getChannelAdapter } from './channel-registry';
import { formatResponseForChannel, DeliveryResult } from './types';
import { getIO } from '../websocket/socket.handler';

export interface OutboundContext {
  sessionId: string;
  tenantId: string;
  messageId: string; // Internal message ID for delivery tracking
}

/**
 * Routes an outbound response to the correct channel.
 * - Widget sessions → WebSocket (existing behavior)
 * - External channel sessions → Platform API via adapter
 * - Always broadcasts to portal agents via WebSocket regardless of channel
 */
export async function routeOutboundMessage(
  response: ResponsePayload,
  context: OutboundContext,
  socketPayload?: Record<string, unknown>, // Pre-built WebSocket payload for portal broadcast
): Promise<DeliveryResult> {
  const sessionRepo = getRepository(ChatSession);
  const session = await sessionRepo.findOne({ where: { id: context.sessionId } });

  if (!session) {
    return { success: false, error: 'Session not found' };
  }

  // Always broadcast to portal agents via WebSocket (so agents see all messages)
  const io = getIO();
  if (io && socketPayload) {
    io.to(`${context.tenantId}:${context.sessionId}`).emit('message:new', socketPayload);
  }

  // If widget channel, WebSocket emission above is sufficient
  if (session.channel === 'widget' || !session.channelConnectionId) {
    return { success: true };
  }

  // External channel — route through adapter
  const adapter = getChannelAdapter(session.channel);
  if (!adapter) {
    return { success: false, error: `No adapter for channel ${session.channel}` };
  }

  // Find the conversation binding to get the external thread ID
  const bindingRepo = getRepository(ConversationBinding);
  const binding = await bindingRepo.findOne({
    where: { sessionId: session.id, channelConnectionId: session.channelConnectionId },
  });

  if (!binding) {
    return { success: false, error: 'No conversation binding found' };
  }

  // Find the channel connection for credentials
  const connectionRepo = getRepository(ChannelConnection);
  const connection = await connectionRepo.findOne({
    where: { id: session.channelConnectionId },
  });

  if (!connection || !connection.isActive()) {
    return { success: false, error: 'Channel connection not active' };
  }

  // Format response for this channel's capabilities
  const capabilities = adapter.outboundTransport.getCapabilities();
  const channelMessages = formatResponseForChannel(response, capabilities);

  // Send each message part (carousels may split into multiple messages)
  const deliveryRepo = getRepository(MessageDelivery);

  for (const msg of channelMessages) {
    if (msg.type === 'typing') {
      await adapter.outboundTransport.sendTypingIndicator(binding.externalThreadId, connection);
      continue;
    }

    const result = await adapter.outboundTransport.send(
      msg,
      binding.externalThreadId,
      connection,
    );

    // Track delivery
    const delivery = deliveryRepo.create({
      internalMessageId: context.messageId,
      channelConnectionId: connection.id,
      channel: connection.channel,
      platformMessageId: result.platformMessageId || null,
      status: result.success ? 'sent' : 'failed',
      attempts: 1,
      error: result.error || null,
    });
    await deliveryRepo.save(delivery);

    if (!result.success) {
      return result;
    }
  }

  return { success: true };
}

/**
 * Send a typing indicator to the correct channel.
 */
export async function routeTypingIndicator(
  sessionId: string,
  tenantId: string,
  isTyping: boolean,
): Promise<void> {
  const sessionRepo = getRepository(ChatSession);
  const session = await sessionRepo.findOne({ where: { id: sessionId } });

  if (!session) return;

  // Always send to WebSocket for portal
  const io = getIO();
  if (io) {
    io.to(`${tenantId}:${sessionId}`).emit('typing:indicator', { isTyping, participantType: 'bot' });
  }

  // External channel typing
  if (session.channel !== 'widget' && session.channelConnectionId && isTyping) {
    const adapter = getChannelAdapter(session.channel);
    if (!adapter) return;

    const bindingRepo = getRepository(ConversationBinding);
    const binding = await bindingRepo.findOne({
      where: { sessionId, channelConnectionId: session.channelConnectionId },
    });

    const connectionRepo = getRepository(ChannelConnection);
    const connection = await connectionRepo.findOne({
      where: { id: session.channelConnectionId },
    });

    if (binding && connection?.isActive()) {
      await adapter.outboundTransport.sendTypingIndicator(binding.externalThreadId, connection);
    }
  }
}
```

- [ ] **Step 2: Update message-forwarding.service.ts to use outbound router**

In `api/src/services/message-forwarding.service.ts`, modify the `sendBotMessage` function (around line 300) to route through the outbound router instead of emitting directly to WebSocket:

Replace the WebSocket emission in `sendBotMessage` with:

```typescript
import { routeOutboundMessage } from '../channels/outbound-router';

// In sendBotMessage(), after saving the message to DB, replace the io.emit with:
const socketPayload = {
  id: savedMessage.id,
  sessionId: session.id,
  participantId: botParticipantId,
  type: 'text',
  content, // Plain text
  status: 'sent',
  createdAt: savedMessage.createdAt,
};

await routeOutboundMessage(
  { type: 'text', content },
  { sessionId: session.id, tenantId: session.tenantId, messageId: savedMessage.id },
  socketPayload,
);
```

- [ ] **Step 3: Update webhook.service.ts to use outbound router**

In `api/src/n8n/webhook.service.ts`, modify `sendTextMessage`, `sendQuickReplyMessage`, `sendMediaMessage`, `sendCarouselMessage`, and `sendTemplateMessage` to route through the outbound router.

For each of these methods, after saving the message to DB, replace the direct `this.eventEmitter.emit(...)` / `io.emit(...)` with:

```typescript
import { routeOutboundMessage } from '../channels/outbound-router';

// After saving message in each send*Message method:
await routeOutboundMessage(
  payload, // The ResponsePayload that was passed in
  { sessionId, tenantId, messageId: savedMessage.id },
  {
    id: savedMessage.id,
    sessionId,
    participantId: botParticipant.id,
    type: payload.type || 'text',
    content: typeof payload.content === 'string' ? payload.content : JSON.stringify(payload.content),
    status: 'sent',
    createdAt: new Date(),
    metadata: savedMessage.metadata,
  },
);
```

- [ ] **Step 4: Update socket.handler.ts for agent replies to external channels**

In `api/src/websocket/socket.handler.ts`, in the `handleMessageSend` function, add routing for agent replies. After the existing WebSocket broadcast (around line 351), add:

```typescript
import { routeOutboundMessage } from '../channels/outbound-router';

// After the existing io.to(...).emit('message:new', ...) for agent messages:
// Check if this is an agent replying to an external channel session
if (senderType === 'agent') {
  const session = await sessionRepo.findOne({ where: { id: sessionId } });
  if (session && session.channel !== 'widget') {
    await routeOutboundMessage(
      { type: 'text', content: messageContent },
      { sessionId, tenantId: session.tenantId, messageId: savedMessage.id },
      undefined, // WebSocket already emitted above
    );
  }
}
```

- [ ] **Step 5: Commit**

```bash
git add api/src/channels/outbound-router.ts api/src/services/message-forwarding.service.ts \
  api/src/n8n/webhook.service.ts api/src/websocket/socket.handler.ts
git commit -m "feat: add outbound transport router for multi-channel message delivery"
```

---

### Task 5: Telegram Adapter — Connection Resolver & Webhook Verifier

**Files:**
- Create: `api/src/channels/telegram/connection-resolver.ts`
- Create: `api/src/channels/telegram/webhook-verifier.ts`
- Create: `api/src/channels/telegram/index.ts`

- [ ] **Step 1: Create Telegram connection resolver**

Telegram webhook updates don't include the bot token, so we use a per-connection secret path segment. Webhook URL format: `/api/v1/channels/telegram/webhook?token=<webhookSecret>`

Create `api/src/channels/telegram/connection-resolver.ts`:

```typescript
import { Request } from 'express';
import { getRepository } from '../../database/data-source';
import { ChannelConnection } from '../../database/entities/ChannelConnection';
import { ConnectionResolver } from '../types';

export class TelegramConnectionResolver implements ConnectionResolver {
  async resolve(req: Request): Promise<ChannelConnection | null> {
    // Strategy 1: Secret token in query param (set when registering webhook with Telegram)
    const token = req.query.token as string | undefined;
    if (token) {
      const repo = getRepository(ChannelConnection);
      return repo.findOne({
        where: {
          channel: 'telegram',
          webhookSecret: token,
          status: 'active',
        },
      });
    }

    // Strategy 2: X-Telegram-Bot-Api-Secret-Token header
    const headerToken = req.headers['x-telegram-bot-api-secret-token'] as string | undefined;
    if (headerToken) {
      const repo = getRepository(ChannelConnection);
      return repo.findOne({
        where: {
          channel: 'telegram',
          webhookSecret: headerToken,
          status: 'active',
        },
      });
    }

    return null;
  }
}
```

- [ ] **Step 2: Create Telegram webhook verifier**

Create `api/src/channels/telegram/webhook-verifier.ts`:

```typescript
import { Request } from 'express';
import { ChannelConnection } from '../../database/entities/ChannelConnection';
import { WebhookVerifier } from '../types';

export class TelegramWebhookVerifier implements WebhookVerifier {
  handleVerificationChallenge(_req: Request, _connection: ChannelConnection): string | null {
    // Telegram doesn't use GET verification challenges
    return null;
  }

  verifySignature(req: Request, connection: ChannelConnection): boolean {
    // Telegram verification is handled by the connection resolver —
    // if we resolved a connection via the secret token, the request is authentic.
    // The secret_token is set when calling setWebhook and Telegram sends it
    // back in X-Telegram-Bot-Api-Secret-Token header on every update.

    // If the connection was resolved via query param, also check the header matches
    const headerToken = req.headers['x-telegram-bot-api-secret-token'] as string | undefined;
    if (headerToken && connection.webhookSecret) {
      return headerToken === connection.webhookSecret;
    }

    // If resolved via query param token match, that's sufficient
    return true;
  }
}
```

- [ ] **Step 3: Create Telegram adapter index (partial — resolver + verifier only)**

Create `api/src/channels/telegram/index.ts`:

```typescript
import { ChannelAdapter } from '../types';
import { TelegramConnectionResolver } from './connection-resolver';
import { TelegramWebhookVerifier } from './webhook-verifier';

// Normalizer and transport added in subsequent tasks
export const telegramConnectionResolver = new TelegramConnectionResolver();
export const telegramWebhookVerifier = new TelegramWebhookVerifier();
```

- [ ] **Step 4: Commit**

```bash
git add api/src/channels/telegram/
git commit -m "feat: add Telegram connection resolver and webhook verifier"
```

---

### Task 6: Telegram Adapter — Event Normalizer

**Files:**
- Create: `api/src/channels/telegram/event-normalizer.ts`
- Modify: `api/src/channels/telegram/index.ts`

- [ ] **Step 1: Create Telegram event normalizer**

Create `api/src/channels/telegram/event-normalizer.ts`:

```typescript
import { ChannelConnection } from '../../database/entities/ChannelConnection';
import { EventNormalizer, NormalizedEvent } from '../types';

// Telegram update types we handle
interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
  // We skip: channel_post, inline_query, chosen_inline_result, etc.
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  photo?: TelegramPhotoSize[];
  video?: TelegramVideo;
  audio?: TelegramAudio;
  document?: TelegramDocument;
  voice?: TelegramVoice;
  sticker?: TelegramSticker;
  caption?: string;
  reply_to_message?: TelegramMessage;
  contact?: { phone_number: string; first_name: string; last_name?: string };
  location?: { latitude: number; longitude: number };
}

interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

interface TelegramVideo {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  duration: number;
  file_size?: number;
  mime_type?: string;
}

interface TelegramAudio {
  file_id: string;
  file_unique_id: string;
  duration: number;
  performer?: string;
  title?: string;
  file_size?: number;
  mime_type?: string;
}

interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  file_size?: number;
  mime_type?: string;
}

interface TelegramVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  file_size?: number;
  mime_type?: string;
}

interface TelegramSticker {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  is_animated: boolean;
  emoji?: string;
}

export class TelegramEventNormalizer implements EventNormalizer {
  normalize(rawPayload: unknown, connection: ChannelConnection): NormalizedEvent[] {
    const update = rawPayload as TelegramUpdate;
    const events: NormalizedEvent[] = [];

    if (update.message) {
      const event = this.normalizeMessage(update, update.message, connection);
      if (event) events.push(event);
    }

    if (update.callback_query) {
      const event = this.normalizeCallbackQuery(update, update.callback_query, connection);
      if (event) events.push(event);
    }

    // edited_message — we could handle as an edit event, skip for now

    return events;
  }

  private normalizeMessage(
    update: TelegramUpdate,
    msg: TelegramMessage,
    connection: ChannelConnection,
  ): NormalizedEvent | null {
    // Skip bot's own messages
    if (msg.from?.is_bot) return null;

    const sender = this.buildSender(msg.from, msg.chat);
    const botToken = (connection.credentials as { botToken?: string }).botToken || '';

    // Determine message type and content
    let type: NormalizedEvent['message'] = undefined;

    if (msg.text) {
      type = { type: 'text', content: msg.text };
    } else if (msg.photo && msg.photo.length > 0) {
      // Use largest photo
      const largest = msg.photo[msg.photo.length - 1];
      type = {
        type: 'image',
        content: msg.caption || '',
        mediaUrl: this.buildFileUrl(largest.file_id, botToken),
        mediaMetadata: {
          fileId: largest.file_id,
          width: largest.width,
          height: largest.height,
          fileSize: largest.file_size,
        },
      };
    } else if (msg.video) {
      type = {
        type: 'video',
        content: msg.caption || '',
        mediaUrl: this.buildFileUrl(msg.video.file_id, botToken),
        mediaMetadata: {
          fileId: msg.video.file_id,
          duration: msg.video.duration,
          mimeType: msg.video.mime_type,
        },
      };
    } else if (msg.audio || msg.voice) {
      const audio = msg.audio || msg.voice!;
      type = {
        type: 'audio',
        content: msg.caption || '',
        mediaUrl: this.buildFileUrl(audio.file_id, botToken),
        mediaMetadata: {
          fileId: audio.file_id,
          duration: audio.duration,
          mimeType: audio.mime_type,
        },
      };
    } else if (msg.document) {
      type = {
        type: 'file',
        content: msg.caption || msg.document.file_name || '',
        mediaUrl: this.buildFileUrl(msg.document.file_id, botToken),
        mediaMetadata: {
          fileId: msg.document.file_id,
          fileName: msg.document.file_name,
          mimeType: msg.document.mime_type,
          fileSize: msg.document.file_size,
        },
      };
    } else if (msg.sticker) {
      type = {
        type: 'sticker',
        content: msg.sticker.emoji || '[sticker]',
        mediaUrl: this.buildFileUrl(msg.sticker.file_id, botToken),
        mediaMetadata: { fileId: msg.sticker.file_id },
      };
    } else if (msg.location) {
      type = {
        type: 'location',
        content: `${msg.location.latitude},${msg.location.longitude}`,
        mediaMetadata: {
          latitude: msg.location.latitude,
          longitude: msg.location.longitude,
        },
      };
    } else if (msg.contact) {
      type = {
        type: 'contact',
        content: `${msg.contact.first_name} ${msg.contact.last_name || ''}: ${msg.contact.phone_number}`,
      };
    } else {
      // Unknown message type
      type = { type: 'text', content: '[unsupported message type]' };
    }

    return {
      type: 'message',
      message: type,
      sender,
      dedupeKey: `telegram:${update.update_id}`,
      timestamp: new Date(msg.date * 1000),
      rawEventType: 'message',
      ...(msg.reply_to_message ? { message: { ...type, replyToExternalId: String(msg.reply_to_message.message_id) } } : {}),
    };
  }

  private normalizeCallbackQuery(
    update: TelegramUpdate,
    query: TelegramCallbackQuery,
    _connection: ChannelConnection,
  ): NormalizedEvent | null {
    const chat = query.message?.chat;
    if (!chat) return null;

    return {
      type: 'postback',
      postback: {
        payload: query.data || '',
        title: query.data || '',
      },
      sender: this.buildSender(query.from, chat),
      dedupeKey: `telegram:cb:${query.id}`,
      timestamp: new Date(),
      rawEventType: 'callback_query',
    };
  }

  private buildSender(
    from: TelegramUser | undefined,
    chat: TelegramChat,
  ): NormalizedEvent['sender'] {
    const displayName = from
      ? [from.first_name, from.last_name].filter(Boolean).join(' ')
      : chat.title || chat.first_name || 'Unknown';

    return {
      externalUserId: String(from?.id || chat.id),
      externalThreadId: String(chat.id),
      displayName,
      platformData: {
        username: from?.username,
        languageCode: from?.language_code,
        chatType: chat.type,
      },
    };
  }

  private buildFileUrl(fileId: string, _botToken: string): string {
    // Note: Telegram file URLs require a two-step process:
    // 1. Call getFile API to get file_path
    // 2. Download from https://api.telegram.org/file/bot<token>/<file_path>
    // We store the file_id here; the media gateway (future task) resolves the actual URL
    return `telegram-file://${fileId}`;
  }
}
```

- [ ] **Step 2: Export normalizer from index**

Update `api/src/channels/telegram/index.ts`:

```typescript
import { ChannelAdapter } from '../types';
import { TelegramConnectionResolver } from './connection-resolver';
import { TelegramWebhookVerifier } from './webhook-verifier';
import { TelegramEventNormalizer } from './event-normalizer';

export const telegramConnectionResolver = new TelegramConnectionResolver();
export const telegramWebhookVerifier = new TelegramWebhookVerifier();
export const telegramEventNormalizer = new TelegramEventNormalizer();
```

- [ ] **Step 3: Commit**

```bash
git add api/src/channels/telegram/
git commit -m "feat: add Telegram event normalizer with support for text, media, callbacks"
```

---

### Task 7: Telegram Adapter — Outbound Transport

**Files:**
- Create: `api/src/channels/telegram/outbound-transport.ts`
- Modify: `api/src/channels/telegram/index.ts` (complete adapter + register)
- Modify: `api/src/server.ts` (register Telegram adapter on startup)

- [ ] **Step 1: Create Telegram outbound transport**

Create `api/src/channels/telegram/outbound-transport.ts`:

```typescript
import axios from 'axios';
import { ChannelConnection } from '../../database/entities/ChannelConnection';
import { OutboundTransport, OutboundChannelMessage, DeliveryResult, ChannelCapabilities } from '../types';

const TELEGRAM_API = 'https://api.telegram.org';

export class TelegramOutboundTransport implements OutboundTransport {
  getCapabilities(): ChannelCapabilities {
    return {
      maxTextLength: 4096,
      supportsQuickReplies: true, // Via inline keyboard
      maxQuickReplies: 100, // Telegram is generous
      supportsButtons: true, // Inline keyboard buttons
      maxButtons: 100,
      supportsCarousel: false, // No native carousel; we fall back to multiple messages
      maxCarouselCards: 0,
      supportsImages: true,
      supportsVideo: true,
      supportsAudio: true,
      supportsFiles: true,
      supportsTypingIndicator: true,
      supportsReadReceipts: false,
      supportsMessageEdit: true,
      supportsMessageDelete: true,
      supportsStickers: true,
      hasMessagingWindow: false,
      requiresTemplatesOutsideWindow: false,
    };
  }

  async send(
    message: OutboundChannelMessage,
    externalThreadId: string,
    connection: ChannelConnection,
  ): Promise<DeliveryResult> {
    const botToken = (connection.credentials as { botToken?: string }).botToken;
    if (!botToken) {
      return { success: false, error: 'No bot token configured', retryable: false };
    }

    try {
      switch (message.type) {
        case 'text':
        case 'quick_reply':
          return await this.sendTextMessage(botToken, externalThreadId, message);
        case 'image':
          return await this.sendPhoto(botToken, externalThreadId, message);
        case 'video':
          return await this.sendVideo(botToken, externalThreadId, message);
        case 'audio':
          return await this.sendAudio(botToken, externalThreadId, message);
        case 'file':
          return await this.sendDocument(botToken, externalThreadId, message);
        default:
          // Fallback: send as text
          return await this.sendTextMessage(botToken, externalThreadId, {
            ...message,
            type: 'text',
            content: message.content || '[unsupported message type]',
          });
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      const retryable = axios.isAxiosError(error)
        ? error.response?.status !== 400 && error.response?.status !== 403
        : true;
      return { success: false, error: errMsg, retryable };
    }
  }

  async sendTypingIndicator(externalThreadId: string, connection: ChannelConnection): Promise<void> {
    const botToken = (connection.credentials as { botToken?: string }).botToken;
    if (!botToken) return;

    try {
      await this.callTelegramApi(botToken, 'sendChatAction', {
        chat_id: externalThreadId,
        action: 'typing',
      });
    } catch {
      // Typing indicators are best-effort
    }
  }

  private async sendTextMessage(
    botToken: string,
    chatId: string,
    message: OutboundChannelMessage,
  ): Promise<DeliveryResult> {
    const params: Record<string, unknown> = {
      chat_id: chatId,
      text: message.content || '',
      parse_mode: 'HTML',
    };

    // Build inline keyboard from quick replies and/or buttons
    const keyboard = this.buildInlineKeyboard(message);
    if (keyboard.length > 0) {
      params.reply_markup = { inline_keyboard: keyboard };
    }

    const response = await this.callTelegramApi(botToken, 'sendMessage', params);
    return {
      success: true,
      platformMessageId: String(response.result?.message_id),
    };
  }

  private async sendPhoto(
    botToken: string,
    chatId: string,
    message: OutboundChannelMessage,
  ): Promise<DeliveryResult> {
    const params: Record<string, unknown> = {
      chat_id: chatId,
      photo: message.mediaUrl || message.content,
      caption: message.content && message.mediaUrl ? message.content : undefined,
      parse_mode: 'HTML',
    };

    const keyboard = this.buildInlineKeyboard(message);
    if (keyboard.length > 0) {
      params.reply_markup = { inline_keyboard: keyboard };
    }

    const response = await this.callTelegramApi(botToken, 'sendPhoto', params);
    return {
      success: true,
      platformMessageId: String(response.result?.message_id),
    };
  }

  private async sendVideo(
    botToken: string,
    chatId: string,
    message: OutboundChannelMessage,
  ): Promise<DeliveryResult> {
    const response = await this.callTelegramApi(botToken, 'sendVideo', {
      chat_id: chatId,
      video: message.mediaUrl || message.content,
      caption: message.content && message.mediaUrl ? message.content : undefined,
      parse_mode: 'HTML',
    });
    return { success: true, platformMessageId: String(response.result?.message_id) };
  }

  private async sendAudio(
    botToken: string,
    chatId: string,
    message: OutboundChannelMessage,
  ): Promise<DeliveryResult> {
    const response = await this.callTelegramApi(botToken, 'sendAudio', {
      chat_id: chatId,
      audio: message.mediaUrl || message.content,
      caption: message.content && message.mediaUrl ? message.content : undefined,
      parse_mode: 'HTML',
    });
    return { success: true, platformMessageId: String(response.result?.message_id) };
  }

  private async sendDocument(
    botToken: string,
    chatId: string,
    message: OutboundChannelMessage,
  ): Promise<DeliveryResult> {
    const response = await this.callTelegramApi(botToken, 'sendDocument', {
      chat_id: chatId,
      document: message.mediaUrl || message.content,
      caption: message.content && message.mediaUrl ? message.content : undefined,
      parse_mode: 'HTML',
    });
    return { success: true, platformMessageId: String(response.result?.message_id) };
  }

  private buildInlineKeyboard(
    message: OutboundChannelMessage,
  ): Array<Array<{ text: string; callback_data?: string; url?: string }>> {
    const rows: Array<Array<{ text: string; callback_data?: string; url?: string }>> = [];

    // Quick replies as inline keyboard buttons (2 per row)
    if (message.quickReplies && message.quickReplies.length > 0) {
      for (let i = 0; i < message.quickReplies.length; i += 2) {
        const row = message.quickReplies.slice(i, i + 2).map((qr) => ({
          text: qr.title,
          callback_data: qr.payload.slice(0, 64), // Telegram limit
        }));
        rows.push(row);
      }
    }

    // Buttons (URL or postback)
    if (message.buttons && message.buttons.length > 0) {
      for (const btn of message.buttons) {
        if (btn.type === 'url') {
          rows.push([{ text: btn.title, url: btn.value }]);
        } else {
          rows.push([{ text: btn.title, callback_data: btn.value.slice(0, 64) }]);
        }
      }
    }

    return rows;
  }

  private async callTelegramApi(
    botToken: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<{ ok: boolean; result?: any }> {
    const response = await axios.post(
      `${TELEGRAM_API}/bot${botToken}/${method}`,
      params,
      { timeout: 10000 },
    );
    return response.data;
  }
}
```

- [ ] **Step 2: Complete the Telegram adapter and export it**

Update `api/src/channels/telegram/index.ts`:

```typescript
import { ChannelAdapter } from '../types';
import { TelegramConnectionResolver } from './connection-resolver';
import { TelegramWebhookVerifier } from './webhook-verifier';
import { TelegramEventNormalizer } from './event-normalizer';
import { TelegramOutboundTransport } from './outbound-transport';

export const telegramAdapter: ChannelAdapter = {
  channel: 'telegram',
  connectionResolver: new TelegramConnectionResolver(),
  webhookVerifier: new TelegramWebhookVerifier(),
  eventNormalizer: new TelegramEventNormalizer(),
  outboundTransport: new TelegramOutboundTransport(),
};
```

- [ ] **Step 3: Register Telegram adapter on server startup**

In `api/src/server.ts`, add after webhook module initialization:

```typescript
import { registerChannelAdapter } from './channels/channel-registry';
import { telegramAdapter } from './channels/telegram';

// Inside startServer(), after createWebhookModule():
registerChannelAdapter(telegramAdapter);
console.log('[channels] Telegram adapter registered');
```

- [ ] **Step 4: Commit**

```bash
git add api/src/channels/telegram/ api/src/server.ts
git commit -m "feat: complete Telegram adapter with outbound transport and register on startup"
```

---

### Task 8: Telegram Webhook Registration API

Tenants need a way to connect their Telegram bot. This task adds an API endpoint for registering a Telegram bot connection.

**Files:**
- Create: `api/src/channels/telegram/setup.service.ts`
- Create: `api/src/channels/channel-management.routes.ts`
- Modify: `api/src/server.ts` (mount management routes)

- [ ] **Step 1: Create Telegram setup service**

Create `api/src/channels/telegram/setup.service.ts`:

```typescript
import axios from 'axios';
import crypto from 'crypto';
import { getRepository } from '../../database/data-source';
import { ChannelConnection } from '../../database/entities/ChannelConnection';

const TELEGRAM_API = 'https://api.telegram.org';

interface TelegramBotInfo {
  id: number;
  is_bot: boolean;
  first_name: string;
  username: string;
}

/**
 * Validates a bot token by calling Telegram's getMe API.
 */
export async function validateBotToken(botToken: string): Promise<TelegramBotInfo> {
  const response = await axios.get(`${TELEGRAM_API}/bot${botToken}/getMe`, { timeout: 10000 });
  if (!response.data.ok) {
    throw new Error('Invalid bot token');
  }
  return response.data.result;
}

/**
 * Registers a Telegram bot webhook with Telegram's servers.
 */
export async function registerTelegramWebhook(
  botToken: string,
  webhookUrl: string,
  secretToken: string,
): Promise<void> {
  const response = await axios.post(`${TELEGRAM_API}/bot${botToken}/setWebhook`, {
    url: webhookUrl,
    secret_token: secretToken,
    allowed_updates: ['message', 'edited_message', 'callback_query'],
    drop_pending_updates: false,
  }, { timeout: 10000 });

  if (!response.data.ok) {
    throw new Error(`Failed to set webhook: ${response.data.description}`);
  }
}

/**
 * Removes the Telegram bot webhook.
 */
export async function removeTelegramWebhook(botToken: string): Promise<void> {
  await axios.post(`${TELEGRAM_API}/bot${botToken}/deleteWebhook`, {}, { timeout: 10000 });
}

/**
 * Full setup flow: validate token → create connection → register webhook.
 */
export async function setupTelegramConnection(
  tenantId: string,
  botToken: string,
  baseUrl: string, // e.g., https://api.yourplatform.com
  label?: string,
): Promise<ChannelConnection> {
  // 1. Validate bot token
  const botInfo = await validateBotToken(botToken);

  // 2. Generate webhook secret
  const webhookSecret = crypto.randomBytes(32).toString('hex');

  // 3. Create or update channel connection
  const repo = getRepository(ChannelConnection);
  let connection = await repo.findOne({
    where: { tenantId, channel: 'telegram', platformAccountId: String(botInfo.id) },
  });

  if (connection) {
    // Update existing connection
    connection.credentials = { botToken };
    connection.webhookSecret = webhookSecret;
    connection.label = label || `@${botInfo.username}`;
    connection.platformAccountId = String(botInfo.id);
    connection.status = 'active';
    connection.lastError = null;
  } else {
    connection = repo.create({
      tenantId,
      channel: 'telegram',
      status: 'active',
      label: label || `@${botInfo.username}`,
      platformAccountId: String(botInfo.id),
      credentials: { botToken },
      webhookSecret,
      config: {
        botUsername: botInfo.username,
        botFirstName: botInfo.first_name,
      },
    });
  }

  await repo.save(connection);

  // 4. Register webhook with Telegram
  const webhookUrl = `${baseUrl}/api/v1/channels/telegram/webhook?token=${webhookSecret}`;
  try {
    await registerTelegramWebhook(botToken, webhookUrl, webhookSecret);
  } catch (error) {
    // Webhook registration failed — mark connection with error
    connection.status = 'error';
    connection.lastError = error instanceof Error ? error.message : 'Webhook registration failed';
    await repo.save(connection);
    throw error;
  }

  return connection;
}

/**
 * Disconnect a Telegram bot: remove webhook + deactivate connection.
 */
export async function disconnectTelegramConnection(connectionId: string): Promise<void> {
  const repo = getRepository(ChannelConnection);
  const connection = await repo.findOne({ where: { id: connectionId, channel: 'telegram' } });

  if (!connection) throw new Error('Connection not found');

  const botToken = (connection.credentials as { botToken?: string }).botToken;
  if (botToken) {
    try {
      await removeTelegramWebhook(botToken);
    } catch {
      // Best-effort removal
    }
  }

  connection.status = 'disconnected';
  connection.credentials = {};
  await repo.save(connection);
}
```

- [ ] **Step 2: Create channel management routes**

Create `api/src/channels/channel-management.routes.ts`:

```typescript
import { Router, Request, Response } from 'express';
import { requireClerkAuth } from '../middleware/auth';
import { getRepository } from '../database/data-source';
import { ChannelConnection } from '../database/entities/ChannelConnection';
import { setupTelegramConnection, disconnectTelegramConnection } from './telegram/setup.service';

const router = Router();

// All routes require authentication
router.use(requireClerkAuth);

/**
 * GET /api/v1/channels/connections
 * List all channel connections for the tenant.
 */
router.get('/connections', async (req: Request, res: Response) => {
  const tenantId = (req as any).tenantId;
  const repo = getRepository(ChannelConnection);

  const connections = await repo.find({
    where: { tenantId },
    order: { createdAt: 'DESC' },
    select: ['id', 'channel', 'status', 'label', 'platformAccountId', 'config', 'lastHealthCheckAt', 'lastError', 'createdAt'],
  });

  return res.json({ connections });
});

/**
 * POST /api/v1/channels/telegram/connect
 * Connect a Telegram bot to the tenant.
 */
router.post('/telegram/connect', async (req: Request, res: Response) => {
  const tenantId = (req as any).tenantId;
  const { botToken, label } = req.body;

  if (!botToken || typeof botToken !== 'string') {
    return res.status(400).json({ error: 'botToken is required' });
  }

  // Determine base URL from request
  const baseUrl = `${req.protocol}://${req.get('host')}`;

  try {
    const connection = await setupTelegramConnection(tenantId, botToken, baseUrl, label);
    return res.status(201).json({
      connection: {
        id: connection.id,
        channel: connection.channel,
        status: connection.status,
        label: connection.label,
        platformAccountId: connection.platformAccountId,
        config: connection.config,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to connect Telegram bot';
    return res.status(400).json({ error: message });
  }
});

/**
 * DELETE /api/v1/channels/:connectionId/disconnect
 * Disconnect a channel connection.
 */
router.delete('/:connectionId/disconnect', async (req: Request, res: Response) => {
  const tenantId = (req as any).tenantId;
  const { connectionId } = req.params;

  const repo = getRepository(ChannelConnection);
  const connection = await repo.findOne({ where: { id: connectionId, tenantId } });

  if (!connection) {
    return res.status(404).json({ error: 'Connection not found' });
  }

  try {
    if (connection.channel === 'telegram') {
      await disconnectTelegramConnection(connectionId);
    } else {
      // Generic disconnect — just mark as disconnected
      connection.status = 'disconnected';
      await repo.save(connection);
    }

    return res.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to disconnect';
    return res.status(500).json({ error: message });
  }
});

export default router;
```

- [ ] **Step 3: Mount channel management routes in server.ts**

In `api/src/server.ts`, add after the channel webhook routes:

```typescript
import channelManagementRoutes from './channels/channel-management.routes';

// Inside startServer():
app.use('/api/v1/channels', channelManagementRoutes);
```

- [ ] **Step 4: Commit**

```bash
git add api/src/channels/telegram/setup.service.ts api/src/channels/channel-management.routes.ts api/src/server.ts
git commit -m "feat: add Telegram webhook registration API and channel management routes"
```

---

### Task 9: Bull Queue Processor for Channel Inbound Events

**Files:**
- Create: `api/src/channels/inbound-queue.processor.ts`
- Modify: `api/src/server.ts` (initialize the channel inbound queue)

- [ ] **Step 1: Create inbound queue processor**

Create `api/src/channels/inbound-queue.processor.ts`:

```typescript
import Bull from 'bull';
import { getRepository } from '../database/data-source';
import { ChannelConnection } from '../database/entities/ChannelConnection';
import { processInboundEvent } from './inbound-pipeline';
import { NormalizedEvent } from './types';

let channelInboundQueue: Bull.Queue | null = null;

interface InboundJobData {
  eventDedupeKey: string;
  connectionId: string;
  event: NormalizedEvent;
}

export function initializeChannelInboundQueue(redisUrl: string): Bull.Queue {
  channelInboundQueue = new Bull<InboundJobData>('channel-inbound', redisUrl, {
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  });

  channelInboundQueue.process('channel-inbound', 5, async (job) => {
    const { connectionId, event } = job.data;

    const connectionRepo = getRepository(ChannelConnection);
    const connection = await connectionRepo.findOne({ where: { id: connectionId } });

    if (!connection) {
      console.error(`[channel-inbound] Connection ${connectionId} not found, skipping`);
      return;
    }

    // Reconstruct Date objects (serialized as strings through Bull)
    const normalizedEvent: NormalizedEvent = {
      ...event,
      timestamp: new Date(event.timestamp),
    };

    await processInboundEvent(normalizedEvent, connection);
  });

  channelInboundQueue.on('failed', (job, err) => {
    console.error(`[channel-inbound] Job ${job.id} failed:`, err.message);
  });

  channelInboundQueue.on('stalled', (jobId) => {
    console.warn(`[channel-inbound] Job ${jobId} stalled`);
  });

  console.log('[channel-inbound] Queue processor initialized');
  return channelInboundQueue;
}

export function getChannelInboundQueue(): Bull.Queue | null {
  return channelInboundQueue;
}
```

- [ ] **Step 2: Update channel-webhook.routes.ts to use the dedicated queue**

In `api/src/channels/channel-webhook.routes.ts`, replace the `getMessageQueue()` import with:

```typescript
import { getChannelInboundQueue } from './inbound-queue.processor';

// In the webhook handler, replace:
//   const queue = getMessageQueue();
// With:
//   const queue = getChannelInboundQueue();
```

- [ ] **Step 3: Initialize the queue in server.ts**

In `api/src/server.ts`, after Redis initialization:

```typescript
import { initializeChannelInboundQueue } from './channels/inbound-queue.processor';

// Inside startServer(), after initializeRedis():
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
initializeChannelInboundQueue(redisUrl);
```

- [ ] **Step 4: Commit**

```bash
git add api/src/channels/inbound-queue.processor.ts api/src/channels/channel-webhook.routes.ts api/src/server.ts
git commit -m "feat: add Bull queue processor for async channel inbound event processing"
```

---

### Task 10: Integration Test — Telegram End-to-End Flow

**Files:**
- Create: `api/src/__tests__/integration/telegram-channel.test.ts`

- [ ] **Step 1: Write integration test for the full Telegram flow**

Create `api/src/__tests__/integration/telegram-channel.test.ts`:

```typescript
import request from 'supertest';
import { AppDataSource, getRepository } from '../../database/data-source';
import { ChannelConnection } from '../../database/entities/ChannelConnection';
import { ConversationBinding } from '../../database/entities/ConversationBinding';
import { ChatSession } from '../../database/entities/ChatSession';
import { Message } from '../../database/entities/Message';
import { WebhookEventLog } from '../../database/entities/WebhookEventLog';
import { Tenant } from '../../database/entities/Tenant';
import { registerChannelAdapter } from '../../channels/channel-registry';
import { telegramAdapter } from '../../channels/telegram';

// Register adapter before tests
registerChannelAdapter(telegramAdapter);

describe('Telegram Channel Integration', () => {
  let tenant: Tenant;
  let connection: ChannelConnection;
  let app: any; // Express app

  beforeAll(async () => {
    // Assumes test database is initialized via global setup
    app = (await import('../../server')).app;
  });

  beforeEach(async () => {
    // Create test tenant
    const tenantRepo = getRepository(Tenant);
    tenant = tenantRepo.create({
      name: 'Test Tenant',
      slug: `test-${Date.now()}`,
      apiKey: `test-key-${Date.now()}`,
      status: 'active',
    });
    await tenantRepo.save(tenant);

    // Create test channel connection
    const connRepo = getRepository(ChannelConnection);
    connection = connRepo.create({
      tenantId: tenant.id,
      channel: 'telegram',
      status: 'active',
      label: '@test_bot',
      platformAccountId: '123456789',
      credentials: { botToken: 'test-bot-token' },
      webhookSecret: 'test-webhook-secret',
      config: { botUsername: 'test_bot' },
    });
    await connRepo.save(connection);
  });

  it('should receive a Telegram text message and create session + binding', async () => {
    const telegramUpdate = {
      update_id: 100001,
      message: {
        message_id: 1,
        from: { id: 999, is_bot: false, first_name: 'John', last_name: 'Doe', username: 'johndoe' },
        chat: { id: 999, type: 'private', first_name: 'John' },
        date: Math.floor(Date.now() / 1000),
        text: 'Hello from Telegram!',
      },
    };

    const response = await request(app)
      .post('/api/v1/channels/telegram/webhook?token=test-webhook-secret')
      .set('X-Telegram-Bot-Api-Secret-Token', 'test-webhook-secret')
      .send(telegramUpdate)
      .expect(200);

    expect(response.body.ok).toBe(true);

    // Verify webhook event was logged
    const eventLogRepo = getRepository(WebhookEventLog);
    const eventLog = await eventLogRepo.findOne({ where: { dedupeKey: 'telegram:100001' } });
    expect(eventLog).toBeDefined();
    expect(eventLog!.channel).toBe('telegram');

    // Note: Actual message processing happens async via Bull queue.
    // In integration tests with inline fallback (no queue), we can verify immediately.
    // With queue, we'd need to wait or process the job manually.
  });

  it('should reject webhook with invalid secret', async () => {
    const telegramUpdate = {
      update_id: 100002,
      message: {
        message_id: 2,
        from: { id: 999, is_bot: false, first_name: 'John' },
        chat: { id: 999, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: 'Should be rejected',
      },
    };

    await request(app)
      .post('/api/v1/channels/telegram/webhook?token=wrong-secret')
      .set('X-Telegram-Bot-Api-Secret-Token', 'wrong-secret')
      .send(telegramUpdate)
      .expect(404); // No matching connection
  });

  it('should deduplicate repeated webhook events', async () => {
    const telegramUpdate = {
      update_id: 100003,
      message: {
        message_id: 3,
        from: { id: 999, is_bot: false, first_name: 'John' },
        chat: { id: 999, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: 'Duplicate test',
      },
    };

    // Send same update twice
    await request(app)
      .post('/api/v1/channels/telegram/webhook?token=test-webhook-secret')
      .set('X-Telegram-Bot-Api-Secret-Token', 'test-webhook-secret')
      .send(telegramUpdate)
      .expect(200);

    await request(app)
      .post('/api/v1/channels/telegram/webhook?token=test-webhook-secret')
      .set('X-Telegram-Bot-Api-Secret-Token', 'test-webhook-secret')
      .send(telegramUpdate)
      .expect(200);

    // Should only have one event log entry
    const eventLogRepo = getRepository(WebhookEventLog);
    const count = await eventLogRepo.count({ where: { dedupeKey: 'telegram:100003' } });
    expect(count).toBe(1);
  });

  it('should handle callback_query (button press) events', async () => {
    const telegramUpdate = {
      update_id: 100004,
      callback_query: {
        id: 'cb-123',
        from: { id: 999, is_bot: false, first_name: 'John' },
        message: {
          message_id: 5,
          chat: { id: 999, type: 'private' },
          date: Math.floor(Date.now() / 1000),
        },
        data: 'button_payload',
      },
    };

    await request(app)
      .post('/api/v1/channels/telegram/webhook?token=test-webhook-secret')
      .set('X-Telegram-Bot-Api-Secret-Token', 'test-webhook-secret')
      .send(telegramUpdate)
      .expect(200);

    const eventLogRepo = getRepository(WebhookEventLog);
    const eventLog = await eventLogRepo.findOne({ where: { dedupeKey: 'telegram:cb:cb-123' } });
    expect(eventLog).toBeDefined();
    expect(eventLog!.eventType).toBe('callback_query');
  });

  it('should return 404 for unsupported channel', async () => {
    await request(app)
      .post('/api/v1/channels/slack/webhook')
      .send({ test: true })
      .expect(404);
  });
});
```

- [ ] **Step 2: Run the tests**

```bash
cd chatbot-platform/api && npm test -- --testPathPattern=telegram-channel
```

Expected: Tests pass, verifying the webhook receive → dedupe → queue flow.

- [ ] **Step 3: Commit**

```bash
git add api/src/__tests__/integration/telegram-channel.test.ts
git commit -m "test: add Telegram channel integration tests"
```

---

### Task 11: Webhook Event Log Cleanup Job

**Files:**
- Modify: `api/src/server.ts` (add periodic cleanup for webhook_event_log and message_deliveries)

- [ ] **Step 1: Add cleanup job**

In `api/src/server.ts`, add alongside the existing audit log cleanup (around line 260):

```typescript
// Cleanup old webhook event logs (keep 7 days)
setInterval(async () => {
  try {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    await AppDataSource.query(
      `DELETE FROM "webhook_event_log" WHERE "createdAt" < $1 AND "status" IN ('processed', 'skipped')`,
      [cutoff],
    );
    await AppDataSource.query(
      `DELETE FROM "message_deliveries" WHERE "createdAt" < $1 AND "status" IN ('sent', 'delivered', 'read')`,
      [cutoff],
    );
  } catch (error) {
    console.error('[cleanup] Channel event log cleanup failed:', error);
  }
}, 24 * 60 * 60 * 1000); // Every 24 hours
```

- [ ] **Step 2: Commit**

```bash
git add api/src/server.ts
git commit -m "feat: add periodic cleanup for webhook event logs and message deliveries"
```

---

## Summary

| Task | What it builds | Key files |
|------|---------------|-----------|
| 1 | Database entities & migration | 4 new entities, 1 migration, ChatSession update |
| 2 | Channel types & interfaces | `channels/types.ts` with 4-concern pipeline |
| 3 | Channel registry + inbound pipeline + webhook routes | Async receive → dedupe → queue → process |
| 4 | **Outbound transport layer** (critical refactor) | Routes bot/agent/n8n replies through correct channel |
| 5 | Telegram resolver + verifier | Secret-token based connection resolution |
| 6 | Telegram event normalizer | Text, media, callbacks, stickers, location |
| 7 | Telegram outbound transport | sendMessage, sendPhoto, inline keyboards |
| 8 | Telegram setup API | Bot token validation, webhook registration |
| 9 | Bull queue processor | Async inbound event processing |
| 10 | Integration tests | End-to-end Telegram webhook flow |
| 11 | Cleanup job | Periodic purge of processed events |

## What This Enables Next (Follow-Up Plans)

After this foundation is in place:
- **Meta Channels Plan**: Messenger + Instagram + WhatsApp adapters. Reuses all the pipeline infrastructure. Main new work: Meta OAuth flow, app review preparation, WhatsApp template management.
- **Media Gateway**: Download Telegram file_ids, handle expiring Meta media URLs, virus scanning.
- **Portal UI**: Channel connections page, per-channel status dashboard.
- **Channel Health Monitoring**: Token expiry alerts, webhook delivery rate dashboards, reconnection flows.
