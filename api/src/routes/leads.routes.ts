/**
 * Leads inbox API.
 *
 * Backs the `/leads` portal page. Returns a cursor-paginated list of
 * the tenant's captured leads, newest first. Cursor is the
 * `(created_at, id)` of the last row in the previous page — opaque to
 * the client, base64 of `"<ISO timestamp>|<UUID>"`.
 *
 * Audit gap #5 closure: the `leadCapture` entitlement flag was
 * previously declared but had zero `requireFeature` consumer. This
 * route is the first real gate. Essential and Pro both have
 * `leadCapture: true`; Free / Enterprise are open via the catalog.
 */
import { Router, Request, Response } from 'express';
import { AppDataSource } from '../database/data-source';
import { Lead } from '../database/entities/Lead';
import { requireClerkAuth, autoProvision } from '../middleware/clerk.middleware';
import { resolveTenantContext } from '../middleware/super-admin.middleware';
import { asyncHandler, BadRequestError } from '../middleware/error-handler';
import { sendSuccess } from '../utils/response';
import { requireFeature } from '../billing/enforce';

const router = Router();

router.use(requireClerkAuth, autoProvision, resolveTenantContext);

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

interface CursorParts {
  createdAt: Date;
  id: string;
}

function encodeCursor(parts: CursorParts): string {
  return Buffer.from(`${parts.createdAt.toISOString()}|${parts.id}`, 'utf8').toString('base64url');
}

function decodeCursor(raw: string): CursorParts {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    throw new BadRequestError('Invalid cursor');
  }
  const [iso, id] = decoded.split('|');
  if (!iso || !id) throw new BadRequestError('Invalid cursor');
  const createdAt = new Date(iso);
  if (Number.isNaN(createdAt.getTime())) throw new BadRequestError('Invalid cursor');
  return { createdAt, id };
}

router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = req.tenantId!;

    // Audit gap #5: enforce the entitlement at the read boundary. The
    // `capture_lead` tool (write side) gates by tier indirectly via the
    // bot's agent runtime, which doesn't run on Free anyway
    // (dailyLlmCalls=0). This is the missing read-side gate.
    await requireFeature(tenantId, 'leadCapture', 'plan_limit_lead_capture');

    const limitRaw = parseInt(String(req.query.limit ?? DEFAULT_LIMIT), 10);
    const limit = Math.min(
      Math.max(Number.isFinite(limitRaw) ? limitRaw : DEFAULT_LIMIT, 1),
      MAX_LIMIT,
    );

    const repo = AppDataSource.getRepository(Lead);
    const qb = repo
      .createQueryBuilder('l')
      .where('l.tenant_id = :tenantId', { tenantId })
      .andWhere('l.deleted_at IS NULL')
      .orderBy('l.created_at', 'DESC')
      .addOrderBy('l.id', 'DESC')
      .limit(limit + 1); // ask for one extra to detect "has more"

    if (typeof req.query.cursor === 'string' && req.query.cursor.length > 0) {
      const { createdAt, id } = decodeCursor(req.query.cursor);
      // Tuple ordering: skip rows older than the cursor row, OR same
      // timestamp with a smaller id (stable tiebreak).
      qb.andWhere(
        '(l.created_at, l.id) < (:cursorCreatedAt, :cursorId)',
        { cursorCreatedAt: createdAt.toISOString(), cursorId: id },
      );
    }

    const rows = await qb.getMany();
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;

    const nextCursor = hasMore
      ? encodeCursor({
          createdAt: pageRows[pageRows.length - 1].createdAt,
          id: pageRows[pageRows.length - 1].id,
        })
      : null;

    sendSuccess(res, {
      leads: pageRows.map((l) => ({
        id: l.id,
        sessionId: l.sessionId,
        botId: l.botId,
        name: l.name,
        email: l.email,
        phone: l.phone,
        source: l.source,
        notes: l.notes,
        createdAt: l.createdAt.toISOString(),
      })),
      nextCursor,
    });
  }),
);

export default router;
