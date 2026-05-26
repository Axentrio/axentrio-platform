import { config } from '../../config/environment';
import { ChannelAdapter } from '../types';
import { GraphWebhookVerifier } from './graph-webhook';
import { MetaConnectionResolver } from './connection-resolver';
import { MetaEventNormalizer } from './event-normalizer';
import { MessengerOutboundTransport } from './messenger-transport';
import { InstagramOutboundTransport } from './instagram-transport';

// Messenger and Instagram are first-class ChannelAdapters sharing the Graph
// webhook verifier + normalizer. Inbound events arrive on the dedicated
// raw-body route (meta/webhook.routes.ts), which reuses the same shared
// createGraphWebhookRouter factory; the outbound router looks these adapters up
// by channel type to send replies.

const metaVerifier = new GraphWebhookVerifier(config.meta.verifyToken, config.meta.appSecret);
const metaNormalizer = new MetaEventNormalizer();

export const messengerAdapter: ChannelAdapter = {
  channel: 'messenger',
  connectionResolver: new MetaConnectionResolver('messenger'),
  webhookVerifier: metaVerifier,
  eventNormalizer: metaNormalizer,
  outboundTransport: new MessengerOutboundTransport(),
};

export const instagramAdapter: ChannelAdapter = {
  channel: 'instagram',
  connectionResolver: new MetaConnectionResolver('instagram'),
  webhookVerifier: metaVerifier,
  eventNormalizer: metaNormalizer,
  outboundTransport: new InstagramOutboundTransport(),
};
