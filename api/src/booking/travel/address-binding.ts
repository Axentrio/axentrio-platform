/**
 * The address binding and the Pending Correction lifecycle.
 *
 * A Pending Correction is one question about one binding:
 *
 *   none -> RECORDED -> ASKED -> SETTLED
 *              |          |
 *              +-- VOID --+-> none
 *
 * The transitions are deliberately represented in Postgres, beside the booking write they guard.
 * Redis cannot fence a Postgres INSERT: a lease can expire between checking the binding and writing
 * the booking. A row lock in the booking transaction can, so this table is the authority.
 *
 * Five rules are enforced here and at its two call sites:
 *
 * 1. Recording is not asking. Any booking tool may record; only create_booking on a surface that
 *    renders the control may ask.
 * 2. ASKED means a renderable server-authored reply was persisted. `markQuestionAsked` verifies the
 *    message row and is called in the same transaction that creates it.
 * 3. A question is about one binding. The pending record snapshots A, and proposalId names A-or-B.
 * 4. Only RECORDED may be superseded. ASKED stays until answer, selection, expiry, or consumption.
 * 5. The id identifies the question; the persisted server reply is the evidence it was asked.
 */
import type { EntityManager } from 'typeorm';
import { AppDataSource } from '../../database/data-source';
import {
  type PendingCorrectionRecord,
} from '../../database/entities/AddressBinding';
import { returningRows } from '../../utils/raw-sql';
import { logger } from '../../utils/logger';
import { canRenderAddressControls } from '../../channels/address-control-capability';

const FRESH_SQL = `updated_at > now() - interval '35 minutes'`;

export interface BoundAddress {
  placeId?: string;
  formattedAddress: string;
}

export interface AddressBindingRef {
  /** Active-address generation. Pending-question transitions do not change it. */
  version: number;
  formattedAddress: string;
}

export interface BoundAddressSnapshot {
  address: BoundAddress;
  ref: AddressBindingRef;
}

export interface PendingCorrection extends BoundAddress {
  proposalId: string;
  status: 'recorded' | 'asked';
  askedMessageId?: string;
  bound: BoundAddress;
  /** The binding the caller read before trying to record this question. Input-only. */
  expectedActivePlaceId?: string;
  expectedActiveAddress?: string;
}

export interface CorrectionProposal extends BoundAddress {
  proposalId: string;
  expectedActivePlaceId?: string;
  expectedActiveAddress?: string;
}

interface BindingRow {
  session_id: string;
  address: string | null;
  place_id: string | null;
  source: 'picked' | 'confirmed' | null;
  pending: PendingCorrectionRecord | null;
  version: number;
}

const executor = (manager?: EntityManager): EntityManager => manager ?? AppDataSource.manager;

async function readFreshRow(sessionId: string, manager?: EntityManager, lock = false): Promise<BindingRow | null> {
  const rows = await executor(manager).query(
    `SELECT session_id, address, place_id, source, pending, version
       FROM chatbot_address_bindings
      WHERE session_id = $1 AND ${FRESH_SQL}
      ${lock ? 'FOR UPDATE' : ''}`,
    [sessionId]
  ) as BindingRow[];
  return rows[0] ?? null;
}

function activeFrom(row: BindingRow | null): BoundAddress | null {
  if (!row?.address) return null;
  return {
    formattedAddress: row.address,
    ...(row.place_id ? { placeId: row.place_id } : {}),
  };
}

function pendingFrom(row: BindingRow | null): PendingCorrection | null {
  const pending = row?.pending;
  if (!pending) return null;
  return {
    proposalId: pending.proposalId,
    formattedAddress: pending.formattedAddress,
    status: pending.status,
    ...(pending.askedMessageId ? { askedMessageId: pending.askedMessageId } : {}),
    bound: {
      formattedAddress: pending.boundAddress,
      ...(pending.boundPlaceId ? { placeId: pending.boundPlaceId } : {}),
    },
  };
}

/** The active address plus the generation a booking must consume. */
export async function getBoundAddressSnapshot(sessionId: string): Promise<BoundAddressSnapshot | null> {
  try {
    const row = await readFreshRow(sessionId);
    const address = activeFrom(row);
    if (!row || !address) return null;
    return { address, ref: { version: row.version, formattedAddress: address.formattedAddress } };
  } catch (error) {
    // Losing the optional binding falls back to the free-text path that predates this feature.
    logger.warn('[Travel] address binding read failed', { sessionId, error });
    return null;
  }
}

/** The address this conversation is currently about, if the customer has chosen one. */
export async function getBoundAddress(sessionId: string): Promise<BoundAddress | null> {
  return (await getBoundAddressSnapshot(sessionId))?.address ?? null;
}

/** The RECORDED or ASKED question, if it is still live. */
export async function getPendingCorrection(sessionId: string): Promise<PendingCorrection | null> {
  try {
    return pendingFrom(await readFreshRow(sessionId));
  } catch (error) {
    logger.warn('[Travel] address question read failed', { sessionId, error });
    return null;
  }
}

/**
 * The customer picked an address. This changes the binding generation and voids every question
 * about the previous binding.
 */
export async function bindAddress(sessionId: string, address: BoundAddress, manager?: EntityManager): Promise<void> {
  const formattedAddress = address.formattedAddress.trim();
  const placeId = address.placeId?.trim();
  if (!formattedAddress || !placeId) throw new Error('A picked address requires text and place identity');
  await executor(manager).query(
    `INSERT INTO chatbot_address_bindings
       (session_id, address, place_id, source, pending, version, updated_at)
     VALUES ($1, $2, $3, 'picked', NULL, 0, now())
     ON CONFLICT (session_id) DO UPDATE
       SET address = EXCLUDED.address,
           place_id = EXCLUDED.place_id,
           source = 'picked',
           pending = NULL,
           version = chatbot_address_bindings.version + 1,
           updated_at = now()`,
    [sessionId, formattedAddress, placeId]
  );
}

/** Record A-or-B, without claiming it was put to the customer. */
export async function proposeCorrection(
  sessionId: string,
  proposal: CorrectionProposal
): Promise<{ isNew: boolean }> {
  try {
    return await AppDataSource.transaction(async (manager) => {
      const row = await readFreshRow(sessionId, manager, true);
      if (!row?.address || !row.source) return { isNew: false };

      const expectedMatches = row.place_id
        ? row.place_id === (proposal.expectedActivePlaceId ?? '')
        : row.address === (proposal.expectedActiveAddress ?? '');
      if (!expectedMatches) return { isNew: false };

      // An ASKED question is visible. A speculative tool may not replace it underneath the tap.
      if (row.pending?.status === 'asked') return { isNew: false };

      const isNew = row.pending?.proposalId !== proposal.proposalId;
      const pending: PendingCorrectionRecord = {
        proposalId: proposal.proposalId,
        formattedAddress: proposal.formattedAddress,
        status: 'recorded',
        boundAddress: row.address,
        boundPlaceId: row.place_id,
        boundSource: row.source,
      };
      await manager.query(
        `UPDATE chatbot_address_bindings
            SET pending = $2::jsonb, updated_at = now()
          WHERE session_id = $1`,
        [sessionId, JSON.stringify(pending)]
      );
      return { isNew };
    });
  } catch (error) {
    logger.warn('[Travel] address proposal failed', { sessionId, error });
    return { isNew: false };
  }
}

export interface QuestionEvidence {
  messageId: string;
  channel: string;
}

/**
 * RECORDED -> ASKED.
 *
 * Only the widget currently renders `address_confirm`. The SQL also proves the named bot message
 * exists in this transaction and carries this exact server-authored affordance; a derivable
 * proposalId alone is never evidence.
 */
export async function markQuestionAsked(
  sessionId: string,
  proposalId: string,
  evidence: QuestionEvidence,
  manager?: EntityManager
): Promise<boolean> {
  if (!canRenderAddressControls(evidence.channel) || !evidence.messageId) return false;
  const rows = returningRows<{ session_id: string }>(await executor(manager).query(
    `UPDATE chatbot_address_bindings b
        SET pending = b.pending || jsonb_build_object(
              'status', 'asked',
              'askedMessageId', $3::text
            ),
            updated_at = now()
      WHERE b.session_id = $1
        AND b.${FRESH_SQL}
        AND b.pending->>'proposalId' = $2
        AND b.pending->>'status' = 'recorded'
        AND EXISTS (
          SELECT 1
            FROM messages m
            JOIN participants p ON p.id = m.participant_id
           WHERE m.id = $3
             AND m.session_id = $1
             AND p.type = 'bot'
             AND m.metadata #>> '{affordance,kind}' = 'address_confirm'
             AND m.metadata #>> '{affordance,proposalId}' = $2
        )
      RETURNING b.session_id`,
    [sessionId, proposalId, evidence.messageId]
  ));
  return rows.length === 1;
}

export type TransitionResult =
  | { applied: false; current: { active: BoundAddress | null; pending: PendingCorrection | null } }
  | { applied: true; address: string };

async function transition(sessionId: string, proposalId: string, confirmed: boolean): Promise<TransitionResult> {
  try {
    return await AppDataSource.transaction(async (manager) => {
      const row = await readFreshRow(sessionId, manager, true);
      const pending = row?.pending;
      if (
        !row?.address ||
        !pending ||
        pending.proposalId !== proposalId ||
        pending.status !== 'asked' ||
        !pending.askedMessageId
      ) {
        return { applied: false, current: { active: activeFrom(row), pending: pendingFrom(row) } };
      }

      const nextAddress = confirmed ? pending.formattedAddress : pending.boundAddress;
      const nextPlaceId = confirmed ? null : pending.boundPlaceId;
      const nextSource = confirmed ? 'confirmed' : pending.boundSource;
      await manager.query(
        `UPDATE chatbot_address_bindings
            SET address = $2,
                place_id = $3,
                source = $4,
                pending = NULL,
                version = version + 1,
                updated_at = now()
          WHERE session_id = $1`,
        [sessionId, nextAddress, nextPlaceId, nextSource]
      );
      return { applied: true, address: nextAddress };
    });
  } catch (error) {
    logger.warn('[Travel] address transition failed', { sessionId, error });
    return { applied: false, current: { active: null, pending: null } };
  }
}

export function confirmCorrection(sessionId: string, proposalId: string): Promise<TransitionResult> {
  return transition(sessionId, proposalId, true);
}

export function rejectCorrection(sessionId: string, proposalId: string): Promise<TransitionResult> {
  return transition(sessionId, proposalId, false);
}

export class AddressBindingMovedError extends Error {
  constructor() {
    super('The address changed while the booking was being created');
    this.name = 'AddressBindingMovedError';
  }
}

/**
 * Consume the exact binding a booking resolved, inside that booking's Postgres transaction.
 * Consumption voids the question as well as clearing the active address: it was a question about
 * this binding, and re-pointing it at a future booking would let a stale control answer a new one.
 */
export async function consumeAddressBinding(
  manager: EntityManager,
  sessionId: string,
  expected: AddressBindingRef | undefined
): Promise<void> {
  if (!expected) return;
  const row = await readFreshRow(sessionId, manager, true);
  if (
    !row?.address ||
    row.version !== expected.version ||
    row.address !== expected.formattedAddress
  ) {
    throw new AddressBindingMovedError();
  }
  await manager.query(
    `UPDATE chatbot_address_bindings
        SET address = NULL,
            place_id = NULL,
            source = NULL,
            pending = NULL,
            version = version + 1,
            updated_at = now()
      WHERE session_id = $1`,
    [sessionId]
  );
}

/** Explicitly void both the binding and its question outside a booking transaction. */
export async function clearAddressBinding(sessionId: string): Promise<void> {
  try {
    await AppDataSource.query(
      `UPDATE chatbot_address_bindings
          SET address = NULL,
              place_id = NULL,
              source = NULL,
              pending = NULL,
              version = version + 1,
              updated_at = now()
        WHERE session_id = $1`,
      [sessionId]
    );
  } catch (error) {
    logger.warn('[Travel] address binding clear failed', { sessionId, error });
  }
}

/** Refresh only a live record. Activity must never resurrect an expired binding or question. */
export async function touchAddressBinding(sessionId: string): Promise<void> {
  try {
    await AppDataSource.query(
      `UPDATE chatbot_address_bindings
          SET updated_at = now()
        WHERE session_id = $1 AND ${FRESH_SQL}`,
      [sessionId]
    );
  } catch {
    // Losing a refresh costs at most one early expiry; it cannot change the chosen address.
  }
}
