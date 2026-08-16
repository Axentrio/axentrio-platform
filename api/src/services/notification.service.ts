/**
 * Notification Service
 * DB-backed operator notifications + mobile device registry. Creating a
 * notification is idempotent per (event, recipient) via `dedupeKey`, and queues
 * a push-delivery job. Recipients are keyed by User.id (matches the auth context
 * used by the notifications routes).
 */
import { IsNull } from 'typeorm';
import { AppDataSource } from '../database/data-source';
import { Notification } from '../database/entities/Notification';
import { MobileDevice } from '../database/entities/MobileDevice';
import { User } from '../database/entities/User';
import { addNotificationJob } from '../queue/message-queue';
import { logger } from '../utils/logger';

export interface CreateNotificationInput {
  tenantId: string;
  type: string;
  title: string;
  message: string;
  data?: Record<string, unknown>;
  /** Stable per-event id used to dedupe, e.g. `handoff:<sessionId>`. */
  dedupeBase?: string;
}

export interface RegisterDeviceInput {
  tenantId: string;
  userId: string;
  clerkUserId?: string;
  expoPushToken: string;
  nativeToken?: string;
  platform: string;
  deviceId?: string;
  appVersion?: string;
  buildNumber?: string;
  runtimeVersion?: string;
  locale?: string;
  timezone?: string;
  permissionStatus?: string;
  environment?: string;
}

export interface ClientNotification {
  id: string;
  userId: string;
  type: string;
  title: string;
  message: string;
  read: boolean;
  createdAt: Date;
  metadata?: Record<string, unknown>;
}

function toClient(n: Notification): ClientNotification {
  return {
    id: n.id,
    userId: n.recipientUserId,
    type: n.type,
    title: n.title,
    message: n.message,
    read: Boolean(n.readAt),
    createdAt: n.createdAt,
    metadata: n.data,
  };
}

async function enqueueDelivery(notificationId: string): Promise<void> {
  try {
    await addNotificationJob({ notificationId });
  } catch (err) {
    // Queue may be unavailable (e.g. Redis down) — don't fail notification creation.
    logger.warn('Failed to enqueue push delivery', {
      notificationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export const notificationService = {
  /**
   * Create one notification per recipient (idempotent) and queue push delivery.
   * Returns the recipient ids actually written (skips deduped/raced recipients),
   * so the caller toasts only those and never re-toasts a fully-deduped retry.
   */
  async createForUsers(
    input: CreateNotificationInput & { recipientUserIds: string[] },
  ): Promise<string[]> {
    const repo = AppDataSource.getRepository(Notification);
    const created: string[] = [];
    for (const recipientUserId of input.recipientUserIds) {
      const dedupeKey = input.dedupeBase ? `${input.dedupeBase}:${recipientUserId}` : undefined;
      if (dedupeKey) {
        const existing = await repo.findOne({ where: { dedupeKey } });
        if (existing) continue;
      }
      try {
        const n = await repo.save(
          repo.create({
            tenantId: input.tenantId,
            recipientUserId,
            type: input.type,
            title: input.title,
            message: input.message,
            data: input.data,
            dedupeKey,
          }),
        );
        await enqueueDelivery(n.id);
        created.push(recipientUserId);
      } catch (err) {
        // Unique dedupe_key violation under a race → already created; ignore.
        logger.debug('Notification create skipped', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return created;
  },

  /** Create for an explicit recipient list, then toast each created recipient. */
  async createForRecipients(
    input: CreateNotificationInput & { recipientUserIds: string[] },
  ): Promise<void> {
    const created = await this.createForUsers(input);
    // Nothing new was written (a fully-deduped retry of the same dedupeBase) →
    // don't re-toast/re-sound desktops for an event they were already alerted to.
    if (created.length === 0) return;

    // Real-time desktop delivery, PER RECIPIENT (#129). The push worker only
    // covers mobile (which most staff don't have), so the toast is how a desktop
    // operator learns of a handoff / guardrail pause / channel-down. It is
    // emitted to each created recipient's OWN room rather than the tenant room,
    // so it follows the (already preference-filtered) recipient list: an operator
    // who opted out gets no row, no push, and now no toast/sound either. One
    // event per recipient room is exactly one toast each — never N-duplicated.
    // Best-effort: a socket hiccup must never fail the write. Lazy import avoids
    // a load-time notification.service↔socket.handler edge.
    try {
      const { emitToAgent } = await import('../websocket/socket.handler');
      const payload = {
        type: input.type,
        title: input.title,
        message: input.message,
        data: input.data ?? null,
      };
      for (const userId of created) emitToAgent(userId, 'notification', payload);
    } catch (err) {
      logger.warn('Failed to emit notification WS event', {
        tenantId: input.tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  /** Fan out to all active operators of a tenant. */
  async createForTenant(input: CreateNotificationInput): Promise<void> {
    const users = await AppDataSource.getRepository(User).find({
      where: { tenantId: input.tenantId, isActive: true },
      select: ['id'],
    });
    if (users.length === 0) return;
    await this.createForRecipients({ ...input, recipientUserIds: users.map((u) => u.id) });
  },

  async list(params: {
    recipientUserId: string;
    unreadOnly: boolean;
    page: number;
    limit: number;
  }): Promise<{ items: ClientNotification[]; total: number; unreadCount: number }> {
    const repo = AppDataSource.getRepository(Notification);
    const baseWhere = { recipientUserId: params.recipientUserId };
    const [rows, total] = await repo.findAndCount({
      where: params.unreadOnly ? { ...baseWhere, readAt: IsNull() } : baseWhere,
      order: { createdAt: 'DESC' },
      skip: (params.page - 1) * params.limit,
      take: params.limit,
    });
    const unreadCount = await repo.count({ where: { ...baseWhere, readAt: IsNull() } });
    return { items: rows.map(toClient), total, unreadCount };
  },

  async markRead(recipientUserId: string, id: string): Promise<ClientNotification | null> {
    const repo = AppDataSource.getRepository(Notification);
    const n = await repo.findOne({ where: { id, recipientUserId } });
    if (!n) return null;
    if (!n.readAt) {
      n.readAt = new Date();
      await repo.save(n);
    }
    return toClient(n);
  },

  async markAllRead(recipientUserId: string): Promise<void> {
    await AppDataSource.getRepository(Notification).update(
      { recipientUserId, readAt: IsNull() },
      { readAt: new Date() },
    );
  },

  async registerDevice(input: RegisterDeviceInput): Promise<MobileDevice> {
    const repo = AppDataSource.getRepository(MobileDevice);
    const existing = await repo.findOne({ where: { expoPushToken: input.expoPushToken } });
    if (existing) {
      repo.merge(existing, { ...input, lastSeenAt: new Date(), revokedAt: null });
      return repo.save(existing);
    }
    return repo.save(repo.create({ ...input, lastSeenAt: new Date() }));
  },

  async unregisterDevice(userId: string, expoPushToken: string): Promise<void> {
    await AppDataSource.getRepository(MobileDevice).update(
      { expoPushToken, userId },
      { revokedAt: new Date() },
    );
  },
};
