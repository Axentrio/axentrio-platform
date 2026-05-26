import { describe, it, expect } from 'vitest';
import { WhatsAppOutboundTransport } from '../../channels/whatsapp/whatsapp-transport';
import { OutboundChannelMessage } from '../../channels/types';

// buildSendBody is private but is the core logic worth asserting directly.
function build(message: OutboundChannelMessage, to = '15559876543') {
  return (new WhatsAppOutboundTransport() as unknown as {
    buildSendBody(m: OutboundChannelMessage, r: string): Record<string, unknown>;
  }).buildSendBody(message, to);
}

describe('WhatsAppOutboundTransport.buildSendBody', () => {
  it('builds a plain text body', () => {
    const body = build({ type: 'text', content: 'hello' });
    expect(body).toMatchObject({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '15559876543',
      type: 'text',
      text: { preview_url: false, body: 'hello' },
    });
  });

  it('builds interactive reply buttons from quick replies (max 3, titles capped)', () => {
    const body = build({
      type: 'quick_reply',
      content: 'Pick one',
      quickReplies: [
        { title: 'Yes', payload: 'yes' },
        { title: 'No', payload: 'no' },
        { title: 'A really long button title that exceeds twenty', payload: 'maybe' },
        { title: 'Fourth', payload: 'fourth' },
      ],
    });

    expect(body.type).toBe('interactive');
    const interactive = body.interactive as any;
    expect(interactive.type).toBe('button');
    expect(interactive.body.text).toBe('Pick one');
    expect(interactive.action.buttons).toHaveLength(3); // capped
    expect(interactive.action.buttons[0]).toEqual({ type: 'reply', reply: { id: 'yes', title: 'Yes' } });
    expect(interactive.action.buttons[2].reply.title.length).toBeLessThanOrEqual(20);
  });

  it('builds a media body with a caption for images', () => {
    const body = build({ type: 'image', mediaUrl: 'https://x/y.jpg', content: 'a cat' });
    expect(body).toMatchObject({
      type: 'image',
      image: { link: 'https://x/y.jpg', caption: 'a cat' },
    });
  });

  it('maps file type to document and omits caption on audio', () => {
    expect(build({ type: 'file', mediaUrl: 'https://x/doc.pdf' }).type).toBe('document');
    const audio = build({ type: 'audio', mediaUrl: 'https://x/a.mp3', content: 'ignored' });
    expect((audio.audio as any).caption).toBeUndefined();
  });

  it('declares a 24h window requiring templates and no typing indicator', () => {
    const caps = new WhatsAppOutboundTransport().getCapabilities();
    expect(caps.hasMessagingWindow).toBe(true);
    expect(caps.requiresTemplatesOutsideWindow).toBe(true);
    expect(caps.supportsTypingIndicator).toBe(false);
    expect(caps.maxTextLength).toBe(4096);
  });
});
