import { config } from '../../config/environment';
import { createGraphWebhookRouter } from '../meta/graph-webhook';
import { normalizeWhatsAppPayload } from './event-normalizer';
import { resolveWhatsAppConnection } from './connection-resolver';
import { logWhatsAppAccountUpdates } from './account-update';

/**
 * WhatsApp Cloud API webhook. Same Graph mechanics as Meta — reuses the shared
 * raw-body router. The WABA payload is scoped to phone numbers (the recipient
 * id), so the channel is always 'whatsapp'.
 *
 * Subscribe `account_update` on this callback before going Live with Embedded
 * Signup. Messages still flow through the normalizer; account_update is logged.
 */
export default createGraphWebhookRouter({
  name: 'whatsapp-webhook',
  verifyToken: config.whatsapp.verifyToken,
  appSecret: config.whatsapp.appSecret,
  normalize: (payload) => {
    logWhatsAppAccountUpdates(payload);
    return normalizeWhatsAppPayload(payload as Parameters<typeof normalizeWhatsAppPayload>[0]);
  },
  resolve: (recipientId) => resolveWhatsAppConnection(recipientId),
});
