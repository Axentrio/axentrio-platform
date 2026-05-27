import { describe, it, expect } from 'vitest';
import { normalizeWhatsAppPayload } from '../../channels/whatsapp/event-normalizer';

const PHONE_NUMBER_ID = 'PNID_123';

function envelope(value: Record<string, unknown>) {
  return {
    object: 'whatsapp_business_account' as const,
    entry: [{ id: 'WABA_1', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp' as const,
      metadata: { display_phone_number: '15551234567', phone_number_id: PHONE_NUMBER_ID },
      ...value,
    } }] }],
  };
}

describe('WhatsApp Event Normalizer', () => {
  it('normalizes a text message and carries contact display name', () => {
    const payload = envelope({
      contacts: [{ profile: { name: 'Ian' }, wa_id: '15559876543' }],
      messages: [{ from: '15559876543', id: 'wamid.AAA', timestamp: '1716000000', type: 'text', text: { body: 'hi' } }],
    });

    const results = normalizeWhatsAppPayload(payload);
    expect(results).toHaveLength(1);
    expect(results[0].channel).toBe('whatsapp');
    expect(results[0].recipientId).toBe(PHONE_NUMBER_ID);
    expect(results[0].event.type).toBe('message');
    expect(results[0].event.message?.type).toBe('text');
    expect(results[0].event.message?.content).toBe('hi');
    expect(results[0].event.sender.externalUserId).toBe('15559876543');
    expect(results[0].event.sender.displayName).toBe('Ian');
    expect(results[0].event.dedupeKey).toBe('wa:PNID_123:wamid.AAA');
  });

  it('normalizes an interactive button reply as a postback', () => {
    const payload = envelope({
      messages: [{
        from: '15559876543', id: 'wamid.BBB', timestamp: '1716000001', type: 'interactive',
        interactive: { type: 'button_reply', button_reply: { id: 'yes', title: 'Yes' } },
      }],
    });

    const results = normalizeWhatsAppPayload(payload);
    expect(results).toHaveLength(1);
    expect(results[0].event.type).toBe('postback');
    expect(results[0].event.postback?.payload).toBe('yes');
    expect(results[0].event.postback?.title).toBe('Yes');
  });

  it('normalizes a media message with the media id stashed in metadata', () => {
    const payload = envelope({
      messages: [{
        from: '15559876543', id: 'wamid.CCC', timestamp: '1716000002', type: 'image',
        image: { id: 'MEDIA_999', mime_type: 'image/jpeg', caption: 'look' },
      }],
    });

    const results = normalizeWhatsAppPayload(payload);
    expect(results).toHaveLength(1);
    expect(results[0].event.message?.type).toBe('image');
    expect(results[0].event.message?.content).toBe('look');
    expect(results[0].event.message?.mediaMetadata?.mediaId).toBe('MEDIA_999');
    expect(results[0].event.message?.mediaUrl).toBeUndefined();
  });

  it('normalizes delivered and read statuses as receipts', () => {
    const payload = envelope({
      statuses: [
        { id: 'wamid.DDD', status: 'delivered', timestamp: '1716000003', recipient_id: '15559876543' },
        { id: 'wamid.DDD', status: 'read', timestamp: '1716000004', recipient_id: '15559876543' },
      ],
    });

    const results = normalizeWhatsAppPayload(payload);
    expect(results).toHaveLength(2);
    expect(results[0].event.type).toBe('delivery');
    expect(results[0].event.receipt?.messageIds).toEqual(['wamid.DDD']);
    expect(results[1].event.type).toBe('read');
  });

  it('skips unknown message types', () => {
    const payload = envelope({
      messages: [{ from: '15559876543', id: 'wamid.EEE', timestamp: '1716000005', type: 'order' }],
    });
    expect(normalizeWhatsAppPayload(payload)).toHaveLength(0);
  });
});
