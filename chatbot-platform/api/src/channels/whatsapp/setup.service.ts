/**
 * WhatsApp Cloud API Setup Service (single-tenant / manual onboarding).
 *
 * Spike scope: the tenant pastes a phone_number_id + a permanent access token
 * (System User token) and, optionally, the WABA id so we can subscribe it to
 * webhooks. Multi-tenant Embedded Signup is a later phase — see
 * wiki/references/meta-messaging/whatsapp-cloud-api.md.
 */

import axios from 'axios';
import { getRepository } from '../../database/data-source';
import { ChannelConnection } from '../../database/entities/ChannelConnection';
import { encryptCredential, getWhatsAppAccessToken } from '../credential-utils';
import { FB_GRAPH_API as GRAPH_API } from '../meta/graph-api';
import { logger } from '../../utils/logger';

interface PhoneNumberInfo {
  id: string;
  display_phone_number?: string;
  verified_name?: string;
}

/**
 * Validate a phone number ID + access token by reading the phone number node.
 */
export async function validateWhatsAppCredentials(
  phoneNumberId: string,
  accessToken: string,
): Promise<PhoneNumberInfo> {
  const response = await axios.get<PhoneNumberInfo>(`${GRAPH_API}/${phoneNumberId}`, {
    params: { fields: 'id,display_phone_number,verified_name' },
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: 10_000,
  });

  if (!response.data?.id) {
    throw new Error('WhatsApp phone number lookup returned no id');
  }
  return response.data;
}

/**
 * Subscribe the WhatsApp Business Account to this app's webhooks. Best-effort:
 * if the WABA id is unknown, the tenant subscribes manually in the dashboard.
 */
async function subscribeWaba(wabaId: string, accessToken: string): Promise<void> {
  await axios.post(`${GRAPH_API}/${wabaId}/subscribed_apps`, null, {
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: 10_000,
  });
}

/**
 * Full setup: validate credentials, create/reactivate the connection, and
 * subscribe the WABA to webhooks if its id is provided.
 */
export async function setupWhatsAppConnection(
  tenantId: string,
  params: { phoneNumberId: string; accessToken: string; wabaId?: string; label?: string },
): Promise<ChannelConnection> {
  const { phoneNumberId, accessToken, wabaId, label } = params;
  const repo = getRepository(ChannelConnection);

  // 1. Validate the credentials
  const info = await validateWhatsAppCredentials(phoneNumberId, accessToken);

  const resolvedLabel = label
    ?? info.verified_name
    ?? (info.display_phone_number ? `WhatsApp ${info.display_phone_number}` : 'WhatsApp');

  const credentials = { accessToken: encryptCredential(accessToken), wabaId };
  const channelConfig = {
    displayPhoneNumber: info.display_phone_number,
    verifiedName: info.verified_name,
    wabaId,
  };

  // 2. Create or reactivate the connection (keyed on phone_number_id)
  let connection = await repo.findOne({
    where: { tenantId, channel: 'whatsapp', platformAccountId: phoneNumberId },
  });

  if (connection) {
    connection.credentials = credentials;
    connection.config = channelConfig;
    connection.label = resolvedLabel;
    connection.status = 'pending_setup';
    connection.lastError = null;
  } else {
    connection = repo.create({
      tenantId,
      channel: 'whatsapp',
      status: 'pending_setup',
      label: resolvedLabel,
      platformAccountId: phoneNumberId,
      credentials,
      config: channelConfig,
    });
  }
  connection = await repo.save(connection) as ChannelConnection;

  // 3. Subscribe the WABA to webhooks (best-effort)
  if (wabaId) {
    try {
      await subscribeWaba(wabaId, accessToken);
      connection.status = 'active';
      connection.lastError = null;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown webhook subscription error';
      logger.error('[whatsapp-setup] Failed to subscribe WABA', { tenantId, wabaId, error: message });
      connection.status = 'error';
      connection.lastError = `Webhook subscription failed: ${message}`;
    }
  } else {
    // No WABA id — assume the tenant subscribed manually in the dashboard.
    connection.status = 'active';
  }

  return repo.save(connection) as Promise<ChannelConnection>;
}

/**
 * Disconnect a WhatsApp connection: unsubscribe the WABA (best-effort) and mark
 * disconnected, clearing credentials.
 */
export async function disconnectWhatsAppConnection(connectionId: string): Promise<ChannelConnection> {
  const repo = getRepository(ChannelConnection);
  const connection = await repo.findOne({ where: { id: connectionId } });
  if (!connection) {
    throw new Error(`ChannelConnection ${connectionId} not found`);
  }

  const accessToken = connection.credentials
    ? getWhatsAppAccessToken(connection.credentials as Record<string, unknown>)
    : null;
  const wabaId = (connection.config as { wabaId?: string } | null)?.wabaId;

  if (accessToken && wabaId) {
    try {
      await axios.delete(`${GRAPH_API}/${wabaId}/subscribed_apps`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 10_000,
      });
    } catch (err) {
      logger.warn('[whatsapp-disconnect] Failed to unsubscribe WABA', {
        connectionId,
        error: err instanceof Error ? err.message : 'unknown',
      });
    }
  }

  connection.credentials = {};
  connection.status = 'disconnected';
  connection.lastError = null;
  return repo.save(connection) as Promise<ChannelConnection>;
}
