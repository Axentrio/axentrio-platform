import { config } from '../../config/environment';
import { ChannelAdapter } from '../types';
import { GraphWebhookVerifier } from '../meta/graph-webhook';
import { WhatsAppConnectionResolver } from './connection-resolver';
import { WhatsAppEventNormalizer } from './event-normalizer';
import { WhatsAppOutboundTransport } from './whatsapp-transport';

/**
 * WhatsApp Cloud API adapter — a first-class ChannelAdapter implementing all
 * four concerns. Shares the Graph webhook verifier with Messenger/Instagram;
 * the dedicated inbound route (whatsapp/webhook.routes.ts) reuses the same
 * shared `createGraphWebhookRouter` factory.
 */
export const whatsappAdapter: ChannelAdapter = {
  channel: 'whatsapp',
  connectionResolver: new WhatsAppConnectionResolver(),
  webhookVerifier: new GraphWebhookVerifier(config.whatsapp.verifyToken, config.whatsapp.appSecret),
  eventNormalizer: new WhatsAppEventNormalizer(),
  outboundTransport: new WhatsAppOutboundTransport(),
};
