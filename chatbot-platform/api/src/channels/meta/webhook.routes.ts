import { config } from '../../config/environment';
import { createGraphWebhookRouter } from './graph-webhook';
import { normalizeMetaPayload } from './event-normalizer';
import { resolveMetaConnection } from './connection-resolver';

/**
 * Meta webhook (Messenger + Instagram). A single payload can carry events for
 * both channels across multiple Pages — `normalizeMetaPayload` tags each event
 * with its channel, and `resolveMetaConnection` maps it to a connection.
 */
export default createGraphWebhookRouter({
  name: 'meta-webhook',
  verifyToken: config.meta.verifyToken,
  appSecret: config.meta.appSecret,
  normalize: (payload) => normalizeMetaPayload(payload as Parameters<typeof normalizeMetaPayload>[0]),
  resolve: (recipientId, channel) =>
    resolveMetaConnection(recipientId, channel as 'messenger' | 'instagram'),
});
