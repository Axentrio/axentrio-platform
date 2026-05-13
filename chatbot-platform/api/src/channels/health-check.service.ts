/**
 * Channel Health Check Service
 * Probes platform APIs to verify stored credentials are still valid.
 * Writes lastHealthCheckAt + lastError on the ChannelConnection.
 */

import axios from 'axios';
import { getRepository } from '../database/data-source';
import { ChannelConnection } from '../database/entities/ChannelConnection';
import { getTelegramBotToken, getMetaPageAccessToken } from './credential-utils';
import { logger } from '../utils/logger';

const TELEGRAM_API = 'https://api.telegram.org';
const META_GRAPH_API = 'https://graph.facebook.com/v21.0';
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

  const outcome = await probeChannel(conn);

  conn.lastHealthCheckAt = outcome.checkedAt;
  conn.lastError = outcome.error;
  if (conn.status === 'active' || conn.status === 'error') {
    conn.status = outcome.ok ? 'active' : 'error';
  }

  return (await repo.save(conn)) as ChannelConnection;
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
