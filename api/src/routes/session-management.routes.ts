import { Router, Request, Response } from 'express';
import { AppDataSource } from '../database/data-source';
import { requireClerkAuth, autoProvision } from '../middleware/clerk.middleware';
import { requireRole } from '../middleware/auth.middleware';
import { resolveTenantContext } from '../middleware/super-admin.middleware';
import { asyncHandler, ValidationError, BadRequestError } from '../middleware';
import { sendSuccess } from '../utils/response';
import { logger } from '../utils/logger';
import { logAudit } from '../utils/audit';
import { logComplianceEvent } from '../compliance/compliance-events.service';
import {
  CONVERSATION_RETENTION_SETTING,
  MAX_CONVERSATION_RETENTION_DAYS,
  MIN_CONVERSATION_RETENTION_DAYS,
  readConversationRetentionDays,
} from '../conversations/conversation-retention.service';

const router = Router();
router.use(requireClerkAuth, autoProvision, resolveTenantContext);

// POST /api/v1/chats/bulk-close — close multiple sessions
router.post('/bulk-close', requireRole('admin'), asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.user!.tenantId;
  const { sessionIds, olderThanHours } = req.body;

  // Bulk admin sweep, deliberately NOT per-row through the command service.
  // ownership + version move in the SAME statement so the columns never desync
  // and any in-flight AI commit is fenced (B-PR2b).
  let result;
  if (sessionIds && Array.isArray(sessionIds)) {
    result = await AppDataSource.query(
      `UPDATE chat_sessions SET status = 'closed', ownership = 'closed',
              ownership_version = ownership_version + 1,
              ended_at = NOW(), updated_at = NOW()
       WHERE tenant_id = $1 AND id = ANY($2) AND status != 'closed'
       RETURNING id`,
      [tenantId, sessionIds]
    );
  } else if (olderThanHours && typeof olderThanHours === 'number') {
    const cutoff = new Date(Date.now() - olderThanHours * 60 * 60 * 1000);
    result = await AppDataSource.query(
      `UPDATE chat_sessions SET status = 'closed', ownership = 'closed',
              ownership_version = ownership_version + 1,
              ended_at = NOW(), updated_at = NOW()
       WHERE tenant_id = $1 AND status IN ('bot', 'waiting') AND last_activity_at < $2
       RETURNING id`,
      [tenantId, cutoff]
    );
  } else {
    throw new ValidationError('Provide sessionIds array or olderThanHours number');
  }

  const count = Array.isArray(result) ? result.length : 0;
  logger.info(`Bulk closed ${count} sessions for tenant ${tenantId}`);
  sendSuccess(res, { closedCount: count });
}));

// DELETE /api/v1/chats/bulk-delete — permanently delete closed sessions + their messages
router.delete('/bulk-delete', requireRole('admin'), asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.user!.tenantId;
  const { olderThanDays } = req.body;

  if (!olderThanDays || typeof olderThanDays !== 'number' || olderThanDays < 1) {
    throw new ValidationError('olderThanDays is required (minimum 1)');
  }

  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);

  const deletedMsgs = await AppDataSource.query(
    `DELETE FROM messages WHERE session_id IN (
       SELECT id FROM chat_sessions WHERE tenant_id = $1 AND status = 'closed' AND ended_at < $2
     ) RETURNING id`,
    [tenantId, cutoff]
  );

  const deletedParticipants = await AppDataSource.query(
    `DELETE FROM participants WHERE session_id IN (
       SELECT id FROM chat_sessions WHERE tenant_id = $1 AND status = 'closed' AND ended_at < $2
     ) RETURNING id`,
    [tenantId, cutoff]
  );

  const deletedSessions = await AppDataSource.query(
    `DELETE FROM chat_sessions WHERE tenant_id = $1 AND status = 'closed' AND ended_at < $2 RETURNING id`,
    [tenantId, cutoff]
  );

  const stats = {
    sessions: Array.isArray(deletedSessions) ? deletedSessions.length : 0,
    messages: Array.isArray(deletedMsgs) ? deletedMsgs.length : 0,
    participants: Array.isArray(deletedParticipants) ? deletedParticipants.length : 0,
  };

  logger.info(`Bulk deleted sessions for tenant ${tenantId}`, stats);
  sendSuccess(res, stats);
}));

// GET /api/v1/chats/stats — session counts by status
router.get('/stats', requireRole('admin', 'supervisor'), asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.user!.tenantId;

  const stats = await AppDataSource.query(
    `SELECT status, COUNT(*)::int as count FROM chat_sessions WHERE tenant_id = $1 GROUP BY status`,
    [tenantId]
  );

  const byStatus: Record<string, number> = {};
  for (const row of stats) {
    byStatus[row.status] = row.count;
  }

  sendSuccess(res, { byStatus, total: Object.values(byStatus).reduce((a, b) => a + b, 0) });
}));

/**
 * Conversation retention policy.
 *
 * GET is readable by any seat that can see the inbox; PUT is admin-only, because
 * setting it schedules irreversible deletion of customer conversations.
 *
 * `null` means KEEP FOREVER and is the default for every existing tenant —
 * nothing expires unless someone chooses a period. Defaulting to a number would
 * have deleted historical conversations on deploy.
 */
router.get('/retention', asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.user!.tenantId;

  const [row] = await AppDataSource.query(`SELECT settings FROM tenants WHERE id = $1`, [tenantId]);
  sendSuccess(res, {
    retentionDays: readConversationRetentionDays(row?.settings),
    minDays: MIN_CONVERSATION_RETENTION_DAYS,
    maxDays: MAX_CONVERSATION_RETENTION_DAYS,
  });
}));

router.put('/retention', requireRole('admin'), asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.user!.tenantId;
  const raw = (req.body ?? {}).retentionDays;

  let value: number | null;
  if (raw === null) {
    value = null; // explicit "keep forever"
  } else if (
    typeof raw === 'number' &&
    Number.isInteger(raw) &&
    raw >= MIN_CONVERSATION_RETENTION_DAYS &&
    raw <= MAX_CONVERSATION_RETENTION_DAYS
  ) {
    value = raw;
  } else {
    throw new BadRequestError(
      `retentionDays must be null, or an integer between ${MIN_CONVERSATION_RETENTION_DAYS} and ${MAX_CONVERSATION_RETENTION_DAYS}`,
    );
  }

  // Targeted jsonb write so a concurrent settings writer is not clobbered. `null`
  // REMOVES the key entirely, which is what the sweep treats as "keep forever".
  await AppDataSource.query(
    value === null
      ? `UPDATE tenants SET settings = COALESCE(settings, '{}'::jsonb) - '${CONVERSATION_RETENTION_SETTING}', updated_at = now() WHERE id = $1`
      : `UPDATE tenants SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('${CONVERSATION_RETENTION_SETTING}', $2::int), updated_at = now() WHERE id = $1`,
    value === null ? [tenantId] : [tenantId, value],
  );

  // Audited: this schedules irreversible deletion of customer conversations.
  await logAudit(req.userId!, 'conversations.retention_updated', 'tenant', tenantId, tenantId, {
    retentionDays: value,
  });
  await logComplianceEvent({
    actorId: req.userId!,
    eventType: 'conversations.retention_updated',
    tenantId,
    subjectType: 'tenant',
    subjectId: tenantId,
    details: { retentionDays: value },
  });

  sendSuccess(res, { retentionDays: value });
}));

export default router;
