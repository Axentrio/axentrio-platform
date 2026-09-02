import { describe, it, expect } from 'vitest';
import { MessengerOutboundTransport } from '../../channels/meta/messenger-transport';
import { InstagramOutboundTransport } from '../../channels/meta/instagram-transport';
import { FB_GRAPH_API } from '../../channels/meta/graph-api';
import { ChannelConnection } from '../../database/entities/ChannelConnection';

// buildSendBody is protected — exercise it via an `any` cast (it's the unit under test).
const buildBody = (t: unknown, msg: Record<string, unknown>) =>
  (t as { buildSendBody: (m: unknown, r: string) => Record<string, unknown> }).buildSendBody(msg, 'recip-1');

const buildRequest = (t: unknown, connection: ChannelConnection) =>
  (t as { buildRequest: (c: ChannelConnection) => { url: string } | { error: string } }).buildRequest(connection);

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

describe('Meta transports — outbound send URL', () => {
  it('instagram: uses graph.facebook.com with the IG business id (Facebook Login path)', () => {
    const transport = new InstagramOutboundTransport();
    const connection = {
      platformAccountId: '17841434799597402',
      credentials: {
        pageAccessToken: 'page-token',
        pageId: '1161984810327648',
        igBusinessId: '17841434799597402',
      },
    } as ChannelConnection;

    const request = buildRequest(transport, connection);
    expect('error' in request).toBe(false);
    if ('error' in request) return;

    expect(request.url).toBe(`${FB_GRAPH_API}/17841434799597402/messages`);
    expect(request.url).toContain('graph.facebook.com');
    expect(request.url).not.toContain('graph.instagram.com');
  });
});
