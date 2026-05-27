/**
 * Telegram Setup Service
 * Handles bot token validation, webhook registration, and connection lifecycle.
 */

import axios from 'axios';
import crypto from 'crypto';
import { getRepository } from '../../database/data-source';
import { ChannelConnection } from '../../database/entities/ChannelConnection';
import { logger } from '../../utils/logger';
import { encryptCredential, getTelegramBotToken } from '../credential-utils';

const TELEGRAM_API = 'https://api.telegram.org';

interface TelegramBotInfo {
  id: number;
  first_name: string;
  username: string;
}

/**
 * Validate a Telegram bot token by calling getMe.
 */
export async function validateBotToken(botToken: string): Promise<TelegramBotInfo> {
  const url = `${TELEGRAM_API}/bot${botToken}/getMe`;
  const response = await axios.get<{ ok: boolean; result: TelegramBotInfo }>(url, {
    timeout: 10_000,
  });

  if (!response.data.ok) {
    throw new Error('Telegram API returned ok=false for getMe');
  }

  return response.data.result;
}

/**
 * Register a webhook URL with Telegram for the given bot.
 */
export async function registerTelegramWebhook(
  botToken: string,
  webhookUrl: string,
  secretToken: string,
): Promise<void> {
  const url = `${TELEGRAM_API}/bot${botToken}/setWebhook`;
  const response = await axios.post<{ ok: boolean; description?: string }>(url, {
    url: webhookUrl,
    allowed_updates: ['message', 'edited_message', 'callback_query'],
    secret_token: secretToken,
  }, { timeout: 10_000 });

  if (!response.data.ok) {
    throw new Error(`Telegram setWebhook failed: ${response.data.description ?? 'unknown error'}`);
  }
}

/**
 * Remove the webhook for the given bot.
 */
export async function removeTelegramWebhook(botToken: string): Promise<void> {
  const url = `${TELEGRAM_API}/bot${botToken}/deleteWebhook`;
  const response = await axios.post<{ ok: boolean; description?: string }>(url, {}, {
    timeout: 10_000,
  });

  if (!response.data.ok) {
    throw new Error(`Telegram deleteWebhook failed: ${response.data.description ?? 'unknown error'}`);
  }
}

/**
 * Full setup flow: validate token, create/update ChannelConnection, register webhook.
 */
export async function setupTelegramConnection(
  tenantId: string,
  botToken: string,
  baseUrl: string,
  label?: string,
): Promise<ChannelConnection> {
  const repo = getRepository(ChannelConnection);

  // 1. Validate the bot token
  const botInfo = await validateBotToken(botToken);

  // 2. Generate webhook secret
  const webhookSecret = crypto.randomBytes(32).toString('hex');

  // 3. Create or update the connection
  let connection = await repo.findOne({
    where: { tenantId, channel: 'telegram', platformAccountId: String(botInfo.id) },
  });

  if (connection) {
    connection.credentials = { botToken: encryptCredential(botToken) };
    connection.webhookSecret = webhookSecret;
    connection.label = label ?? connection.label;
    connection.status = 'pending_setup';
    connection.lastError = null;
    connection.config = { botUsername: botInfo.username, botFirstName: botInfo.first_name };
  } else {
    connection = repo.create({
      tenantId,
      channel: 'telegram',
      status: 'pending_setup',
      label: label ?? `@${botInfo.username}`,
      platformAccountId: String(botInfo.id),
      credentials: { botToken: encryptCredential(botToken) },
      webhookSecret,
      config: { botUsername: botInfo.username, botFirstName: botInfo.first_name },
    });
  }

  connection = await repo.save(connection) as ChannelConnection;

  // 4. Register webhook with Telegram
  const webhookUrl = `${baseUrl}/api/v1/channels/telegram/webhook`;

  try {
    await registerTelegramWebhook(botToken, webhookUrl, webhookSecret);
    connection.status = 'active';
    connection.lastError = null;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown webhook registration error';
    logger.error('Failed to register Telegram webhook', { tenantId, error: message });
    connection.status = 'error';
    connection.lastError = message;
  }

  return repo.save(connection) as Promise<ChannelConnection>;
}

/**
 * Disconnect a Telegram connection: remove webhook and mark as disconnected.
 */
export async function disconnectTelegramConnection(connectionId: string): Promise<ChannelConnection> {
  const repo = getRepository(ChannelConnection);
  const connection = await repo.findOne({ where: { id: connectionId } });

  if (!connection) {
    throw new Error(`ChannelConnection ${connectionId} not found`);
  }

  // Attempt to remove webhook (best-effort; bot token may already be revoked)
  const botToken = connection.credentials
    ? getTelegramBotToken(connection.credentials as Record<string, unknown>)
    : null;
  if (botToken) {
    try {
      await removeTelegramWebhook(botToken);
    } catch (err) {
      logger.warn('Failed to remove Telegram webhook during disconnect', {
        connectionId,
        error: err instanceof Error ? err.message : 'unknown',
      });
    }
  }

  connection.status = 'disconnected';
  connection.lastError = null;
  return repo.save(connection) as Promise<ChannelConnection>;
}
