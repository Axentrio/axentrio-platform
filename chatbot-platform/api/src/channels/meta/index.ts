import { ChannelAdapter, ConnectionResolver, WebhookVerifier, EventNormalizer } from '../types';
import { MessengerOutboundTransport } from './messenger-transport';
import { InstagramOutboundTransport } from './instagram-transport';

// Meta uses a dedicated webhook route, not the generic adapter pipeline.
// However, we still register adapters so the outbound router can look them up
// by channel type ('messenger' or 'instagram') for sending responses.

// Stub resolver/verifier — Meta webhook handling is in webhook.routes.ts
const stubResolver: ConnectionResolver = {
  async resolve() { return null; },
};
const stubVerifier: WebhookVerifier = {
  handleVerificationChallenge() { return null; },
  verifySignature() { return false; },
};
const stubNormalizer: EventNormalizer = {
  normalize() { return []; },
};

export const messengerAdapter: ChannelAdapter = {
  channel: 'messenger',
  connectionResolver: stubResolver,
  webhookVerifier: stubVerifier,
  eventNormalizer: stubNormalizer,
  outboundTransport: new MessengerOutboundTransport(),
};

export const instagramAdapter: ChannelAdapter = {
  channel: 'instagram',
  connectionResolver: stubResolver,
  webhookVerifier: stubVerifier,
  eventNormalizer: stubNormalizer,
  outboundTransport: new InstagramOutboundTransport(),
};
