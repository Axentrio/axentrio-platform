import { ChannelAdapter } from '../types';
import { TelegramConnectionResolver } from './connection-resolver';
import { TelegramWebhookVerifier } from './webhook-verifier';
import { TelegramEventNormalizer } from './event-normalizer';
import { TelegramOutboundTransport } from './outbound-transport';

export const telegramAdapter: ChannelAdapter = {
  channel: 'telegram',
  connectionResolver: new TelegramConnectionResolver(),
  webhookVerifier: new TelegramWebhookVerifier(),
  eventNormalizer: new TelegramEventNormalizer(),
  outboundTransport: new TelegramOutboundTransport(),
};
