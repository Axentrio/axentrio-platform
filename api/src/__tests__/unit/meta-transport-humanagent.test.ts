import { describe, it, expect } from 'vitest';
import { MessengerOutboundTransport } from '../../channels/meta/messenger-transport';
import { InstagramOutboundTransport } from '../../channels/meta/instagram-transport';

// buildSendBody is protected — exercise it via an `any` cast (it's the unit under test).
const buildBody = (t: unknown, msg: Record<string, unknown>) =>
  (t as { buildSendBody: (m: unknown, r: string) => Record<string, unknown> }).buildSendBody(msg, 'recip-1');

const transports = [
  ['messenger', new MessengerOutboundTransport()],
  ['instagram', new InstagramOutboundTransport()],
] as const;

describe('Meta transports — HUMAN_AGENT tag (#8)', () => {
  for (const [name, transport] of transports) {
    it(`${name}: a human-agent message uses MESSAGE_TAG + HUMAN_AGENT`, () => {
      const body = buildBody(transport, { type: 'text', content: 'hi', humanAgent: true });
      expect(body.messaging_type).toBe('MESSAGE_TAG');
      expect(body.tag).toBe('HUMAN_AGENT');
    });

    it(`${name}: a normal (bot) message stays RESPONSE with no tag`, () => {
      const body = buildBody(transport, { type: 'text', content: 'hi' });
      expect(body.messaging_type).toBe('RESPONSE');
      expect(body.tag).toBeUndefined();
    });
  }
});
