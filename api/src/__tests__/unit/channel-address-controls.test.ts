import { describe, expect, it } from 'vitest';
import {
  addressConfirmPayload,
  addressOptionId,
  addressPickerPayload,
  canRenderAddressControls,
  renderChannelAddressControls,
} from '../../channels/address-controls';

const BOUND = 'Turnhoutsebaan 100, 2140 Antwerpen';
const PROPOSED = 'Turnhoutsebaan 101, 2140 Antwerpen';

describe('channel address controls', () => {
  it.each(['widget', 'messenger', 'instagram', 'whatsapp'] as const)(
    '%s can render a server-observed address control',
    (channel) => expect(canRenderAddressControls(channel)).toBe(true),
  );

  it.each(['telegram', undefined, 'unknown'])(
    '%s fails closed',
    (channel) => expect(canRenderAddressControls(channel)).toBe(false),
  );

  it('renders full picker choices in prose and only numbered Meta button titles', () => {
    const firstId = addressOptionId('ChIJ_first');
    const secondId = addressOptionId('ChIJ_second');
    const rendered = renderChannelAddressControls(
      { type: 'text', content: 'I found these times.' },
      {
        kind: 'address_picker',
        reason: 'unverified',
        query: BOUND,
        options: [
          { id: firstId, placeId: 'ChIJ_first', text: BOUND },
          { id: secondId, placeId: 'ChIJ_second', text: PROPOSED },
        ],
      },
      'messenger',
    );

    expect(rendered.content).toBe('I found these times.');
    expect(rendered.protectedTail).toContain(`1. ${BOUND}`);
    expect(rendered.protectedTail).toContain(`2. ${PROPOSED}`);
    expect(rendered.quickReplies).toEqual([
      { title: '1', value: addressPickerPayload(firstId) },
      { title: '2', value: addressPickerPayload(secondId) },
    ]);
    expect(rendered.quickReplies!.every((reply) => typeof reply !== 'string' && reply.title.length <= 20)).toBe(true);
    expect(JSON.stringify(rendered.quickReplies)).not.toContain('Turnhoutsebaan');
  });

  it('renders equal-prefix corrections as unambiguous numbered choices', () => {
    const rendered = renderChannelAddressControls(
      { type: 'text', content: 'Which address should I use?' },
      { kind: 'address_confirm', proposalId: 'proposal-1', bound: BOUND, proposed: PROPOSED },
      'whatsapp',
    );

    expect(rendered.content).toBe('Which address should I use?');
    expect(rendered.protectedTail).toContain(`1. ${BOUND}`);
    expect(rendered.protectedTail).toContain(`2. ${PROPOSED}`);
    expect(rendered.quickReplies).toEqual([
      { title: '1', value: addressConfirmPayload('proposal-1', 'bound') },
      { title: '2', value: addressConfirmPayload('proposal-1', 'proposed') },
    ]);
  });

  it('does not mint numbered Meta replies when the picker has no street options', () => {
    const response = { type: 'text' as const, content: 'I need the street, house number, postal code, and city.' };
    const emptyPicker = {
      kind: 'address_picker' as const,
      reason: 'too_vague' as const,
      query: 'Antwerp',
      options: [] as Array<{ id: string; placeId: string; text: string }>,
    };
    expect(renderChannelAddressControls(response, emptyPicker, 'whatsapp')).toEqual(response);
    expect(renderChannelAddressControls(response, { ...emptyPicker, options: undefined }, 'messenger')).toEqual(
      response,
    );
  });

  it('does not turn Telegram or widget affordances into channel quick replies', () => {
    const response = { type: 'text' as const, content: 'hello' };
    const affordance = {
      kind: 'address_confirm' as const,
      proposalId: 'proposal-1',
      bound: BOUND,
      proposed: PROPOSED,
    };
    expect(renderChannelAddressControls(response, affordance, 'telegram')).toEqual(response);
    expect(renderChannelAddressControls(response, affordance, 'widget')).toEqual(response);
  });
});
