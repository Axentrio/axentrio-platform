/**
 * Channel Health Check Service
 * Probes platform APIs to verify stored credentials are still valid.
 * Writes lastHealthCheckAt + lastError on the ChannelConnection.
 */

import axios from 'axios';
import { getRepository } from '../database/data-source';
import { ChannelConnection } from '../database/entities/ChannelConnection';
import { getTelegramBotToken, getMetaPageAccessToken, getWhatsAppAccessToken } from './credential-utils';
import { logger } from '../utils/logger';
import { notificationService } from '../services/notification.service';
import { getRedisClient } from '../config/redis';
import { FB_GRAPH_API as META_GRAPH_API } from './meta/graph-api';

const TELEGRAM_API = 'https://api.telegram.org';
const PROBE_TIMEOUT_MS = 10_000;

export interface HealthCheckOutcome {
  ok: boolean;
  error: string | null;
  checkedAt: Date;
}

/**
 * Run a health check against the platform that owns this connection.
 * Persists lastHealthCheckAt + lastError, and flips status between 'active'
 * and 'error' (does not disturb 'pending_setup' or 'disconnected').
 */
export async function runHealthCheck(connectionId: string): Promise<ChannelConnection> {
  const repo = getRepository(ChannelConnection);
  const conn = (await repo.findOne({ where: { id: connectionId } })) as ChannelConnection | null;
  if (!conn) {
    throw new Error(`ChannelConnection ${connectionId} not found`);
  }

  const prevStatus = conn.status;
  const outcome = await probeChannel(conn);

  conn.lastHealthCheckAt = outcome.checkedAt;
  conn.lastError = outcome.error;
  if (conn.status === 'active' || conn.status === 'error') {
    conn.status = outcome.ok ? 'active' : 'error';
  }

  const saved = (await repo.save(conn)) as ChannelConnection;

  // Notify the tenant ONLY on the active→error transition, so "the bot stopped
  // working" isn't silent — and (deliberately no permanent dedupe) a channel that
  // recovers and later breaks again re-notifies. Within one outage the transition
  // fires once (subsequent probes see status already 'error'), and the outbound
  // trigger is debounced, so this won't spam.
  if (prevStatus === 'active' && saved.status === 'error') {
    void notifyChannelDown(saved);
  }

  return saved;
}

async function notifyChannelDown(conn: ChannelConnection): Promise<void> {
  try {
    await notificationService.createForTenant({
      tenantId: conn.tenantId,
      type: 'channel.error',
      title: 'A channel needs attention',
      message: `Your ${conn.channel} connection stopped working${conn.lastError ? `: ${conn.lastError}` : ''}. Reconnect it in Settings → Channels.`,
      data: { connectionId: conn.id, channel: conn.channel, lastError: conn.lastError },
    });
  } catch (err) {
    logger.warn('[health-check] channel-down notification failed', {
      connectionId: conn.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Fire-and-forget health probe debounced to ≤1 per connection per 60s
 * (cross-instance via Redis SET NX EX; fail-open to probing if Redis is down).
 * Used by the outbound path so a burst of failed sends can't fan out into a
 * storm of provider probes (or concurrent active→error double-notifications).
 */
export async function triggerHealthCheckDebounced(connectionId: string): Promise<void> {
  // The debounce is a best-effort optimisation — a Redis error must FAIL OPEN to
  // probing (an extra probe is far better than leaving a broken channel green).
  let skip = false;
  try {
    const redis = getRedisClient();
    if (redis) {
      const acquired = await redis.set(`channel:probe:${connectionId}`, '1', 'EX', 60, 'NX');
      skip = acquired !== 'OK'; // a probe ran for this connection recently
    }
  } catch (err) {
    logger.warn('[health-check] probe debounce check failed — probing anyway', {
      connectionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (skip) return;

  try {
    await runHealthCheck(connectionId);
  } catch (err) {
    logger.warn('[health-check] debounced probe failed', {
      connectionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function probeChannel(conn: ChannelConnection): Promise<HealthCheckOutcome> {
  const checkedAt = new Date();
  try {
    if (conn.channel === 'telegram') {
      const token = conn.credentials ? getTelegramBotToken(conn.credentials as Record<string, unknown>) : null;
      if (!token) {
        throw new Error('Missing botToken in stored credentials');
      }
      const res = await axios.get<{ ok: boolean; description?: string }>(
        `${TELEGRAM_API}/bot${token}/getMe`,
        { timeout: PROBE_TIMEOUT_MS },
      );
      if (!res.data?.ok) {
        throw new Error(res.data?.description ?? 'Telegram getMe returned ok=false');
      }
      return { ok: true, error: null, checkedAt };
    }

    if (conn.channel === 'messenger' || conn.channel === 'instagram') {
      const token = conn.credentials ? getMetaPageAccessToken(conn.credentials as Record<string, unknown>) : null;
      if (!token) {
        throw new Error('Missing pageAccessToken in stored credentials');
      }
      const res = await axios.get<{ id?: string; name?: string }>(
        `${META_GRAPH_API}/me`,
        { params: { fields: 'id,name', access_token: token }, timeout: PROBE_TIMEOUT_MS },
      );
      if (!res.data?.id) {
        throw new Error('Meta /me returned no id');
      }
      return { ok: true, error: null, checkedAt };
    }

    if (conn.channel === 'whatsapp') {
      const token = conn.credentials ? getWhatsAppAccessToken(conn.credentials as Record<string, unknown>) : null;
      const phoneNumberId = conn.platformAccountId;
      if (!token) {
        throw new Error('Missing accessToken in stored credentials');
      }
      if (!phoneNumberId) {
        throw new Error('Missing WhatsApp phone number ID');
      }
      // Probe the phone number node — confirms the token still owns it.
      const res = await axios.get<{ id?: string }>(
        `${META_GRAPH_API}/${phoneNumberId}`,
        {
          params: { fields: 'id,verified_name,quality_rating' },
          headers: { Authorization: `Bearer ${token}` },
          timeout: PROBE_TIMEOUT_MS,
        },
      );
      if (!res.data?.id) {
        throw new Error('WhatsApp phone number probe returned no id');
      }
      return { ok: true, error: null, checkedAt };
    }

    throw new Error(`Health check not implemented for channel '${conn.channel}'`);
  } catch (err) {
    const raw = err instanceof Error ? err.message : 'Unknown error';
    const message = raw.length > 500 ? `${raw.slice(0, 497)}...` : raw;
    logger.warn('Channel health check failed', {
      connectionId: conn.id,
      channel: conn.channel,
      error: message,
    });
    return { ok: false, error: message, checkedAt };
  }
}
