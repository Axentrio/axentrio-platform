/**
 * Was the correction question ever actually put in front of the customer?
 *
 * The one-shot cap is a promise about QUESTIONS ASKED, and every cheap proxy for that has now been
 * wrong in production:
 *
 *   isNew            counted proposals. Three tools propose and one asks, so `check_availability`
 *                    spent the question by saying nothing.
 *   presented        counted the claim. A second `create_booking` in the same batch found it spent
 *                    and booked past a question sitting unread in a tool result.
 *   presentedByRun   counted the agent run. A run is one customer message - except when the turn
 *                    coalescer re-runs that same message after a processor error, which mints a
 *                    fresh run id. The refusal lifts and it books, and the customer saw nothing,
 *                    because the run that asked died before its reply was written.
 *
 * Each guard named something adjacent to the real thing. The real thing is observable: the reply
 * carrying the control is a row in `messages`, with the proposal id in its metadata. If that row
 * exists the customer was shown the question; if it does not, nobody was asked, whatever any flag
 * says.
 *
 * PERSISTED, not delivered, and the gap is deliberate. `finalizeReply` writes the row and outbound
 * routing sends it afterwards, so a reply that persisted and then failed to send counts as asked.
 * That window is small, it is the same one the coalescer's own watermark accepts as "answered", and
 * closing it would need a delivery receipt this platform does not have on every channel.
 */
import type { DataSource } from 'typeorm';
import { logger } from '../../utils/logger';

/**
 * Fails to `null`, meaning "cannot tell", rather than to a boolean.
 *
 * The caller has to choose a direction and the two are not symmetric: guessing "not asked" asks
 * again on every turn, which wedges a customer whose address Google cannot suggest - the exact
 * outcome the cap exists to prevent, and worse than the thing it guards. So a caller that cannot
 * tell falls back to the older, weaker signal rather than to either boolean.
 */
export async function questionWasAsked(
  dataSource: DataSource | undefined,
  sessionId: string,
  proposalId: string
): Promise<boolean | null> {
  if (!dataSource) return null;
  try {
    const rows: Array<{ exists: boolean }> = await dataSource.query(
      // JOINED TO participants AND REQUIRING type = 'bot'.
      //
      // Without that join this asked whether ANY message carried the id, and `POST /widget/message`
      // stores customer-supplied `metadata` verbatim (`widget.ts:453`) - so a customer could post
      // `{affordance:{proposalId}}`, manufacture the evidence that they had already been asked, and
      // `create_booking` would proceed without asking. The correction this feature exists to
      // collect would be silently skipped, by the guard meant to guarantee it was collected.
      //
      // Only the platform writes a bot message, so the participant type is what makes this a
      // statement about what the SERVER said rather than about what anyone claimed.
      `SELECT EXISTS (
         SELECT 1
           FROM messages m
           JOIN participants p ON p.id = m.participant_id
          WHERE m.session_id = $1
            AND m.is_deleted = false
            AND p.type = 'bot'
            AND m.metadata -> 'affordance' ->> 'proposalId' = $2
       ) AS exists`,
      [sessionId, proposalId]
    );
    return rows?.[0]?.exists === true;
  } catch (error) {
    // Never throws into a booking. A monitor that can break a booking is worse than the blindness
    // it cures, and the same is true of a guard.
    logger.warn('[Travel] could not tell whether the address question was asked', { sessionId, error });
    return null;
  }
}
