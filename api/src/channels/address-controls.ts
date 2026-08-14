import crypto from 'crypto';
import { AppDataSource } from '../database/data-source';
import { AddressOffer } from '../database/entities/AddressOffer';
import { returningRows } from '../utils/raw-sql';
import type { ChannelType } from '../database/entities/ChannelConnection';
import type { Affordance } from '../agent/tool-adapter';
import type { ResponsePayload } from './response.types';
import { bindAddress, confirmCorrection, rejectCorrection } from '../booking/travel/address-binding';
import { resolvePlaceId } from '../booking/travel/geocoding.service';
import { isMetaAddressControlChannel } from './address-control-capability';

export { canRenderAddressControls } from './address-control-capability';

const PICK_PREFIX = 'ax:addr:pick:';
const CONFIRM_PREFIX = 'ax:addr:confirm:';

/** Stable, opaque and short enough for every Meta reply-button payload. */
export function addressOptionId(placeId: string): string {
  return crypto.createHash('sha256').update(placeId).digest('hex').slice(0, 16);
}

export function addressPickerPayload(optionId: string): string {
  return `${PICK_PREFIX}${optionId}`;
}

export function addressConfirmPayload(proposalId: string, choice: 'bound' | 'proposed'): string {
  return `${CONFIRM_PREFIX}${proposalId}:${choice}`;
}

/**
 * Turn an address affordance into native Meta quick replies.
 *
 * Full addresses stay in the body. Titles are just 1/2/3, so Meta's 20-character truncation
 * cannot make two same-street choices identical. Payloads contain only opaque ids.
 */
export function renderChannelAddressControls(
  response: ResponsePayload,
  affordance: Affordance | undefined,
  channel: ChannelType | undefined,
): ResponsePayload {
  if (!affordance || !isMetaAddressControlChannel(channel)) return response;

  if (affordance.kind === 'address_picker') {
    const options = affordance.options?.slice(0, 3) ?? [];
    if (!options.length) return response;
    return {
      ...response,
      content: String(response.content ?? ''),
      // The numbered list is a protected tail: truncation must never cut an address off the button
      // that names it (#97 D2). Full addresses in the body, bare numbers on the titles.
      protectedTail: `\n\n${options.map((option, i) => `${i + 1}. ${option.text}`).join('\n')}`,
      quickReplies: options.map((option, i) => ({
        title: String(i + 1),
        value: addressPickerPayload(option.id),
      })),
    };
  }

  return {
    ...response,
    content: String(response.content ?? ''),
    protectedTail: `\n\n1. ${affordance.bound}\n2. ${affordance.proposed}`,
    quickReplies: [
      { title: '1', value: addressConfirmPayload(affordance.proposalId, 'bound') },
      { title: '2', value: addressConfirmPayload(affordance.proposalId, 'proposed') },
    ],
  };
}

type AddressControlEvent = { type: string; payload?: string };
type AddressControlContext = { sessionId: string; tenantId: string; channel: ChannelType };
export type AddressControlResult = { handled: false } | { handled: true; content?: string };

/**
 * Apply a signed-channel postback before it becomes an ordinary customer message.
 *
 * A picker action needs persisted server evidence just like a correction answer does. A payload
 * with a guessed id is therefore consumed but ignored, never handed to the model as text.
 */
export async function applyChannelAddressControl(
  event: AddressControlEvent,
  context: AddressControlContext,
): Promise<AddressControlResult> {
  if (event.type !== 'postback' || !event.payload || !isMetaAddressControlChannel(context.channel)) {
    return { handled: false };
  }

  if (event.payload.startsWith(PICK_PREFIX)) {
    const token = event.payload.slice(PICK_PREFIX.length);
    if (!/^[0-9a-f-]{36}$/i.test(token)) return { handled: true };
    // #97 D3: the token is an offer row id. The offer table is the authority, not message metadata;
    // a guessed token finds no live offer and is consumed but ignored.
    const offer = await AppDataSource.getRepository(AddressOffer).findOne({
      where: { id: token, sessionId: context.sessionId, channel: context.channel },
    });
    if (!offer || offer.consumedAt || offer.expiresAt.getTime() <= Date.now()) return { handled: true };
    const resolved = await resolvePlaceId(context.tenantId, offer.placeId);
    if (resolved.status !== 'placed') return { handled: true };
    // Consume the whole SET and bind in one transaction: picking any option retires its siblings, so
    // two taps cannot move the binding twice (AC 3). A losing concurrent tap finds the set consumed.
    const bound = await AppDataSource.transaction(async (manager) => {
      const claimed = returningRows<{ id: string }>(await manager.query(
        `UPDATE chatbot_address_offers
            SET consumed_at = now()
          WHERE set_id = $1 AND consumed_at IS NULL AND expires_at > now()
        RETURNING id`,
        [offer.setId],
      ));
      if (claimed.length === 0) return null;
      await bindAddress(
        context.sessionId,
        { placeId: resolved.place.placeId, formattedAddress: resolved.place.formattedAddress },
        manager,
      );
      return resolved.place.formattedAddress;
    });
    return bound ? { handled: true, content: bound } : { handled: true };
  }

  if (event.payload.startsWith(CONFIRM_PREFIX)) {
    const match = event.payload.match(/^ax:addr:confirm:([^:]{1,128}):(bound|proposed)$/);
    if (!match) return { handled: true };
    const [, proposalId, choice] = match;
    const result = choice === 'proposed'
      ? await confirmCorrection(context.sessionId, proposalId)
      : await rejectCorrection(context.sessionId, proposalId);
    return result.applied ? { handled: true, content: result.address } : { handled: true };
  }

  return { handled: false };
}
