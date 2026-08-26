/**
 * WhatsApp Embedded Signup (Tech Provider) — gated by WHATSAPP_ES_ENABLED.
 *
 * This is not Facebook Login for Messenger. The exchangeable code from FB.login
 * ({ config_id, response_type: 'code' }) is swapped for a customer-scoped
 * business token WITHOUT `redirect_uri`. Copying handleOAuthCallback will fail.
 *
 * Official flow (v4):
 *  1. GET /oauth/access_token?client_id&client_secret&code
 *  2. POST /{WABA_ID}/subscribed_apps
 *  3. POST /{PHONE_NUMBER_ID}/register  { messaging_product, pin }
 *  4. Persist via setupWhatsAppConnection
 *
 * Keep off until Tech Provider onboarding + whatsapp_business_* Advanced access.
 */

import crypto from 'crypto';
import axios from 'axios';
import { config } from '../../config/environment';
import { FB_GRAPH_API as GRAPH_API, META_GRAPH_VERSION } from '../meta/graph-api';
import { logger } from '../../utils/logger';
import { setupWhatsAppConnection } from './setup.service';
import { ChannelConnection } from '../../database/entities/ChannelConnection';

export function isWhatsAppEmbeddedSignupReady(): boolean {
  return Boolean(
    config.whatsapp.embeddedSignup.enabled
    && config.whatsapp.embeddedSignup.configId
    && config.meta.appId
    && config.meta.appSecret,
  );
}

export function getWhatsAppEmbeddedSignupPublicConfig(): {
  enabled: boolean;
  appId: string;
  configId: string;
  graphVersion: string;
} {
  const ready = isWhatsAppEmbeddedSignupReady();
  return {
    enabled: ready,
    appId: ready ? config.meta.appId : '',
    configId: ready ? config.whatsapp.embeddedSignup.configId : '',
    graphVersion: META_GRAPH_VERSION,
  };
}

/**
 * Exchange the 30-second Embedded Signup code for a business token.
 * Must NOT send redirect_uri.
 */
export async function exchangeEmbeddedSignupCode(code: string): Promise<string> {
  const response = await axios.get<{ access_token?: string }>(`${GRAPH_API}/oauth/access_token`, {
    params: {
      client_id: config.meta.appId,
      client_secret: config.meta.appSecret,
      code,
    },
    timeout: 10_000,
  });
  const token = response.data?.access_token;
  if (!token) {
    throw new Error('Embedded Signup token exchange returned no access_token');
  }
  return token;
}

function newTwoStepPin(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * Register the customer's phone number for Cloud API. Best-effort: an already
 * registered number must not fail the whole connect.
 */
export async function registerWhatsAppPhoneNumber(
  phoneNumberId: string,
  accessToken: string,
  pin: string,
): Promise<void> {
  await axios.post(
    `${GRAPH_API}/${phoneNumberId}/register`,
    { messaging_product: 'whatsapp', pin },
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 10_000,
    },
  );
}

export async function completeWhatsAppEmbeddedSignup(
  tenantId: string,
  params: { code: string; phoneNumberId: string; wabaId: string },
): Promise<ChannelConnection> {
  const accessToken = await exchangeEmbeddedSignupCode(params.code);
  const pin = newTwoStepPin();

  try {
    await registerWhatsAppPhoneNumber(params.phoneNumberId, accessToken, pin);
  } catch (err) {
    logger.warn('[whatsapp-es] Phone register failed (may already be registered)', {
      tenantId,
      phoneNumberId: params.phoneNumberId,
      error: err instanceof Error ? err.message : 'unknown',
    });
  }

  return setupWhatsAppConnection(tenantId, {
    phoneNumberId: params.phoneNumberId,
    accessToken,
    wabaId: params.wabaId,
  });
}
