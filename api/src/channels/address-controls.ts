import crypto from 'crypto';
import { AppDataSource } from '../database/data-source';
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
      content: `${String(response.content ?? '')}\n\n${options.map((option, i) => `${i + 1}. ${option.text}`).join('\n')}`,
      quickReplies: options.map((option, i) => ({
        title: String(i + 1),
        value: addressPickerPayload(option.id),
      })),
    };
  }

  return {
    ...response,
    content: `${String(response.content ?? '')}\n\n1. ${affordance.bound}\n2. ${affordance.proposed}`,
    quickReplies: [
      { title: '1', value: addressConfirmPayload(affordance.proposalId, 'bound') },
      { title: '2', value: addressConfirmPayload(affordance.proposalId, 'proposed') },
    ],
  };
}

type AddressControlEvent = { type: string; payload?: string };
type AddressControlContext = { sessionId: string; tenantId: string; channel: ChannelType };
export type AddressControlResult = { handled: false } | { handled: true; content?: string };

async function offeredPlaceId(sessionId: string, optionId: string): Promise<string | null> {
  const rows = await AppDataSource.query(
    `SELECT option->>'placeId' AS place_id
       FROM messages m
       JOIN participants p ON p.id = m.participant_id
       CROSS JOIN LATERAL jsonb_array_elements(
         COALESCE(m.metadata #> '{affordance,options}', '[]'::jsonb)
       ) option
      WHERE m.session_id = $1
        AND p.type = 'bot'
        AND m.is_deleted = false
        AND m.created_at > now() - interval '35 minutes'
        AND m.metadata #>> '{affordance,kind}' = 'address_picker'
        AND option->>'id' = $2
      ORDER BY m.created_at DESC
      LIMIT 1`,
    [sessionId, optionId],
  ) as Array<{ place_id: string | null }>;
  return rows[0]?.place_id?.trim() || null;
}

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
    const optionId = event.payload.slice(PICK_PREFIX.length);
    if (!/^[a-f0-9]{16}$/.test(optionId)) return { handled: true };
    const placeId = await offeredPlaceId(context.sessionId, optionId);
    if (!placeId || addressOptionId(placeId) !== optionId) return { handled: true };
    const resolved = await resolvePlaceId(context.tenantId, placeId);
    if (resolved.status !== 'placed') return { handled: true };
    await bindAddress(context.sessionId, {
      placeId: resolved.place.placeId,
      formattedAddress: resolved.place.formattedAddress,
    });
    return { handled: true, content: resolved.place.formattedAddress };
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
