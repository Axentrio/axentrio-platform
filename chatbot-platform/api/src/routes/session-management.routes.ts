import { Router, Request, Response } from 'express';
import { AppDataSource } from '../database/data-source';
import { requireClerkAuth, autoProvision } from '../middleware/clerk.middleware';
import { requireRole } from '../middleware/auth.middleware';
import { resolveTenantContext } from '../middleware/super-admin.middleware';
import { asyncHandler, ValidationError } from '../middleware';
import { logger } from '../utils/logger';

const router = Router();
router.use(requireClerkAuth, autoProvision, resolveTenantContext);

// POST /api/v1/chats/bulk-close — close multiple sessions
router.post('/bulk-close', requireRole('admin'), asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.user!.tenantId;
  const { sessionIds, olderThanHours } = req.body;

  let result;
  if (sessionIds && Array.isArray(sessionIds)) {
    result = await AppDataSource.query(
      `UPDATE chat_sessions SET status = 'closed', ended_at = NOW(), updated_at = NOW()
       WHERE tenant_id = $1 AND id = ANY($2) AND status != 'closed'
       RETURNING id`,
      [tenantId, sessionIds]
    );
  } else if (olderThanHours && typeof olderThanHours === 'number') {
    const cutoff = new Date(Date.now() - olderThanHours * 60 * 60 * 1000);
    result = await AppDataSource.query(
      `UPDATE chat_sessions SET status = 'closed', ended_at = NOW(), updated_at = NOW()
       WHERE tenant_id = $1 AND status IN ('bot', 'waiting') AND last_activity_at < $2
       RETURNING id`,
      [tenantId, cutoff]
    );
  } else {
    throw new ValidationError('Provide sessionIds array or olderThanHours number');
  }

  const count = Array.isArray(result) ? result.length : 0;
  logger.info(`Bulk closed ${count} sessions for tenant ${tenantId}`);
  res.json({ success: true, data: { closedCount: count } });
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
  res.json({ success: true, data: stats });
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

  res.json({ success: true, data: { byStatus, total: Object.values(byStatus).reduce((a, b) => a + b, 0) } });
}));

export default router;
