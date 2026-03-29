import { Router, Request, Response } from 'express';
import { AppDataSource } from '../database/data-source';
import { CannedResponse } from '../database/entities/CannedResponse';
import { requireClerkAuth, autoProvision, ProvisionedRequest } from '../middleware/clerk.middleware';
import { resolveTenantContext } from '../middleware/super-admin.middleware';
import { parsePaginationParams, applyPagination } from '../utils/pagination';
import { asyncHandler, NotFoundError, ForbiddenError, ConflictError } from '../middleware/error-handler';
import { validate } from '../middleware/validate';
import { sendSuccess, sendCreated, sendNoContent } from '../utils/response';
import {
  createCannedResponseSchema,
  updateCannedResponseSchema,
  useCannedResponseSchema,
  listCannedResponsesSchema,
} from '../schemas';

const router = Router();
const cannedResponseRepository = AppDataSource.getRepository(CannedResponse);

router.use(requireClerkAuth, autoProvision, resolveTenantContext);

/**
 * GET /canned-responses
 * List shared responses + caller's personal responses
 */
router.get(
  '/',
  validate(listCannedResponsesSchema, 'query'),
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const authReq = req as ProvisionedRequest;
    const tenantId = authReq.tenantId;
    const userId = authReq.userId;
    const params = parsePaginationParams(req.query as Record<string, unknown>);
    const { search, category, scope } = req.query;

    const qb = cannedResponseRepository.createQueryBuilder('cr')
      .where('cr.tenantId = :tenantId', { tenantId })
      .andWhere('cr.isActive = true');

    // Scope filtering: shared responses + own personal responses
    if (scope === 'shared') {
      qb.andWhere('cr.scope = :scope', { scope: 'shared' });
    } else if (scope === 'personal') {
      qb.andWhere('cr.scope = :scope AND cr.createdByUserId = :userId', { scope: 'personal', userId });
    } else {
      qb.andWhere('(cr.scope = :shared OR (cr.scope = :personal AND cr.createdByUserId = :userId))', {
        shared: 'shared',
        personal: 'personal',
        userId,
      });
    }

    if (search) {
      qb.andWhere('(cr.title ILIKE :search OR cr.shortcut ILIKE :search)', { search: `%${search}%` });
    }
    if (category) {
      qb.andWhere('cr.category = :category', { category });
    }

    qb.orderBy('cr.usageCount', 'DESC').addOrderBy('cr.createdAt', 'DESC');

    const result = await applyPagination(qb, params);
    sendSuccess(res, result);
  })
);

/**
 * GET /canned-responses/:id
 */
router.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const authReq = req as ProvisionedRequest;
    const tenantId = authReq.tenantId;
    const userId = authReq.userId;

    const cr = await cannedResponseRepository.findOne({
      where: { id: req.params.id, tenantId, isActive: true },
    });

    if (!cr) throw new NotFoundError('Canned response not found');
    if (cr.scope === 'personal' && cr.createdByUserId !== userId) {
      throw new NotFoundError('Canned response not found');
    }

    sendSuccess(res, cr);
  })
);

/**
 * POST /canned-responses
 * Admins/supervisors can create shared. Anyone can create personal.
 */
router.post(
  '/',
  validate(createCannedResponseSchema),
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const authReq = req as ProvisionedRequest;
    const tenantId = authReq.tenantId;
    const userId = authReq.userId;
    const role = authReq.userRole;
    const body = req.body;

    if (body.scope === 'shared' && !['admin', 'supervisor', 'super_admin'].includes(role!)) {
      throw new ForbiddenError('Only admins can create shared canned responses');
    }

    // Check for duplicate shortcut
    const existingQb = cannedResponseRepository.createQueryBuilder('cr')
      .where('cr.tenantId = :tenantId', { tenantId })
      .andWhere('cr.shortcut = :shortcut', { shortcut: body.shortcut })
      .andWhere('cr.isActive = true');

    if (body.scope === 'shared') {
      existingQb.andWhere('cr.scope = :scope', { scope: 'shared' });
    } else {
      existingQb.andWhere('cr.scope = :scope AND cr.createdByUserId = :userId', { scope: 'personal', userId });
    }

    const existing = await existingQb.getOne();
    if (existing) {
      throw new ConflictError('A canned response with this shortcut already exists');
    }

    const cr = cannedResponseRepository.create({
      ...body,
      tenantId,
      createdByUserId: userId,
    });

    const saved = await cannedResponseRepository.save(cr);
    sendCreated(res, saved);
  })
);

/**
 * PATCH /canned-responses/:id
 * Admins/supervisors can edit shared. Owners can edit their personal.
 */
router.patch(
  '/:id',
  validate(updateCannedResponseSchema),
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const authReq = req as ProvisionedRequest;
    const tenantId = authReq.tenantId;
    const userId = authReq.userId;
    const role = authReq.userRole;

    const cr = await cannedResponseRepository.findOne({
      where: { id: req.params.id, tenantId, isActive: true },
    });

    if (!cr) throw new NotFoundError('Canned response not found');

    if (cr.scope === 'shared' && !['admin', 'supervisor', 'super_admin'].includes(role!)) {
      throw new ForbiddenError('Only admins can edit shared canned responses');
    }
    if (cr.scope === 'personal' && cr.createdByUserId !== userId) {
      throw new NotFoundError('Canned response not found');
    }

    Object.assign(cr, req.body);
    const updated = await cannedResponseRepository.save(cr);
    sendSuccess(res, updated);
  })
);

/**
 * DELETE /canned-responses/:id
 * Soft delete (set isActive = false)
 */
router.delete(
  '/:id',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const authReq = req as ProvisionedRequest;
    const tenantId = authReq.tenantId;
    const userId = authReq.userId;
    const role = authReq.userRole;

    const cr = await cannedResponseRepository.findOne({
      where: { id: req.params.id, tenantId, isActive: true },
    });

    if (!cr) throw new NotFoundError('Canned response not found');

    if (cr.scope === 'shared' && !['admin', 'supervisor', 'super_admin'].includes(role!)) {
      throw new ForbiddenError('Only admins can delete shared canned responses');
    }
    if (cr.scope === 'personal' && cr.createdByUserId !== userId) {
      throw new NotFoundError('Canned response not found');
    }

    cr.isActive = false;
    await cannedResponseRepository.save(cr);
    sendNoContent(res);
  })
);

/**
 * POST /canned-responses/:id/use
 * Resolve variables, increment usage count, return resolved content
 */
router.post(
  '/:id/use',
  validate(useCannedResponseSchema),
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const authReq = req as ProvisionedRequest;
    const tenantId = authReq.tenantId;
    const userId = authReq.userId;
    const { variables = {} } = req.body;

    const cr = await cannedResponseRepository.findOne({
      where: { id: req.params.id, tenantId, isActive: true },
    });

    if (!cr) throw new NotFoundError('Canned response not found');
    if (cr.scope === 'personal' && cr.createdByUserId !== userId) {
      throw new NotFoundError('Canned response not found');
    }

    // Resolve variables — unmatched placeholders stay as-is
    const resolvedContent = cr.content.replace(
      /\{\{(\w+)\}\}/g,
      (match, key) => variables[key] ?? match
    );

    // Increment usage count
    cr.usageCount += 1;
    await cannedResponseRepository.save(cr);

    sendSuccess(res, { content: resolvedContent, usageCount: cr.usageCount });
  })
);

export default router;
