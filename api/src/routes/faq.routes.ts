import { Router, Request, Response } from 'express';
import { AppDataSource, runInTransaction } from '../database/data-source';
import { FaqSection } from '../database/entities/FaqSection';
import { FaqItem } from '../database/entities/FaqItem';
import { requireClerkAuth, autoProvision, ProvisionedRequest } from '../middleware/clerk.middleware';
import { requireSuperAdmin } from '../middleware/super-admin.middleware';
import {
  asyncHandler,
  ConflictError,
  NotFoundError,
} from '../middleware/error-handler';
import { validate } from '../middleware/validate';
import { sendSuccess, sendCreated, sendNoContent } from '../utils/response';
import { logAudit } from '../utils/audit';
import {
  createFaqSectionSchema,
  updateFaqSectionSchema,
  createFaqItemSchema,
  updateFaqItemSchema,
  reorderFaqSchema,
} from '../schemas';

const router = Router();
const sectionRepo = AppDataSource.getRepository(FaqSection);
const itemRepo = AppDataSource.getRepository(FaqItem);

router.use(requireClerkAuth, autoProvision);

/**
 * GET /faq — full tree, ordered. Any authed user.
 */
router.get(
  '/',
  asyncHandler(async (_req: Request, res: Response): Promise<void> => {
    const sections = await sectionRepo.find({ order: { position: 'ASC', id: 'ASC' } });
    const items = await itemRepo.find({ order: { sectionId: 'ASC', position: 'ASC', id: 'ASC' } });

    const itemsBySection = new Map<string, FaqItem[]>();
    for (const it of items) {
      const arr = itemsBySection.get(it.sectionId);
      if (arr) arr.push(it);
      else itemsBySection.set(it.sectionId, [it]);
    }

    const tree = sections.map((s) => ({
      id: s.id,
      position: s.position,
      isReserved: s.isReserved,
      titles: s.titles,
      items: (itemsBySection.get(s.id) ?? []).map((it) => ({
        id: it.id,
        sectionId: it.sectionId,
        slug: it.slug,
        position: it.position,
        question: it.question,
        answer: it.answer,
      })),
    }));

    sendSuccess(res, { sections: tree });
  })
);

// All mutations require super_admin.
router.use(requireSuperAdmin);

/**
 * POST /faq/sections — create a section. Position appended.
 */
router.post(
  '/sections',
  validate(createFaqSectionSchema),
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const authReq = req as ProvisionedRequest;
    const { id, titles } = req.body;

    const existing = await sectionRepo.findOne({ where: { id } });
    if (existing) throw new ConflictError('Section id already exists');

    const max = await sectionRepo
      .createQueryBuilder('s')
      .select('COALESCE(MAX(s.position), -1)', 'maxPos')
      .getRawOne<{ maxPos: number }>();
    const position = (max?.maxPos ?? -1) + 1;

    const section = sectionRepo.create({ id, titles, position, isReserved: false });
    await sectionRepo.save(section);

    await logAudit(authReq.userId!, 'faq.section.create', 'faq_section', id);
    sendCreated(res, section);
  })
);

/**
 * PATCH /faq/sections/:id — update titles only. Id and position are immutable
 * via this endpoint (position changes go through /reorder).
 */
router.patch(
  '/sections/:id',
  validate(updateFaqSectionSchema),
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const authReq = req as ProvisionedRequest;
    const section = await sectionRepo.findOne({ where: { id: req.params.id } });
    if (!section) throw new NotFoundError('Section not found');

    if (req.body.titles) section.titles = req.body.titles;
    await sectionRepo.save(section);

    await logAudit(authReq.userId!, 'faq.section.update', 'faq_section', section.id);
    sendSuccess(res, section);
  })
);

/**
 * DELETE /faq/sections/:id — 409 if reserved.
 */
router.delete(
  '/sections/:id',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const authReq = req as ProvisionedRequest;
    const section = await sectionRepo.findOne({ where: { id: req.params.id } });
    if (!section) throw new NotFoundError('Section not found');
    if (section.isReserved) {
      throw new ConflictError('Reserved section cannot be deleted', {
        reason: 'reserved',
        sectionId: section.id,
      });
    }
    await sectionRepo.remove(section);

    await logAudit(authReq.userId!, 'faq.section.delete', 'faq_section', section.id);
    sendNoContent(res);
  })
);

/**
 * POST /faq/sections/:sectionId/items — create item in section. Position appended.
 */
router.post(
  '/sections/:sectionId/items',
  validate(createFaqItemSchema),
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const authReq = req as ProvisionedRequest;
    const { sectionId } = req.params;
    const { slug, question, answer } = req.body;

    const section = await sectionRepo.findOne({ where: { id: sectionId } });
    if (!section) throw new NotFoundError('Section not found');

    const dupe = await itemRepo.findOne({ where: { sectionId, slug } });
    if (dupe) throw new ConflictError('Slug already exists in this section');

    const max = await itemRepo
      .createQueryBuilder('i')
      .select('COALESCE(MAX(i.position), -1)', 'maxPos')
      .where('i.sectionId = :sectionId', { sectionId })
      .getRawOne<{ maxPos: number }>();
    const position = (max?.maxPos ?? -1) + 1;

    const item = itemRepo.create({ sectionId, slug, question, answer, position });
    await itemRepo.save(item);

    await logAudit(authReq.userId!, 'faq.item.create', 'faq_item', item.id);
    sendCreated(res, item);
  })
);

/**
 * PATCH /faq/items/:id — update slug/sectionId/question/answer. Position changes
 * go through /reorder. Moving the last item out of a reserved section is rejected.
 */
router.patch(
  '/items/:id',
  validate(updateFaqItemSchema),
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const authReq = req as ProvisionedRequest;
    const item = await itemRepo.findOne({ where: { id: req.params.id } });
    if (!item) throw new NotFoundError('Item not found');

    const originalSectionId = item.sectionId;
    const targetSectionId: string = req.body.sectionId ?? item.sectionId;

    if (targetSectionId !== originalSectionId) {
      const target = await sectionRepo.findOne({ where: { id: targetSectionId } });
      if (!target) throw new NotFoundError('Target section not found');

      // Moving out of a reserved section: must leave ≥1 item behind.
      const fromSection = await sectionRepo.findOne({ where: { id: originalSectionId } });
      if (fromSection?.isReserved) {
        const remaining = await itemRepo.count({ where: { sectionId: originalSectionId } });
        if (remaining <= 1) {
          throw new ConflictError('Reserved section must keep at least one item', {
            reason: 'reserved_min_items',
            sectionId: originalSectionId,
          });
        }
      }
    }

    if (req.body.slug !== undefined && req.body.slug !== item.slug) {
      const dupe = await itemRepo.findOne({
        where: { sectionId: targetSectionId, slug: req.body.slug },
      });
      if (dupe && dupe.id !== item.id) {
        throw new ConflictError('Slug already exists in this section');
      }
      item.slug = req.body.slug;
    }

    if (req.body.sectionId !== undefined) item.sectionId = req.body.sectionId;
    if (req.body.question) item.question = req.body.question;
    if (req.body.answer) item.answer = req.body.answer;

    await itemRepo.save(item);

    await logAudit(authReq.userId!, 'faq.item.update', 'faq_item', item.id);
    sendSuccess(res, item);
  })
);

/**
 * DELETE /faq/items/:id — 409 if deleting would leave a reserved section empty.
 */
router.delete(
  '/items/:id',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const authReq = req as ProvisionedRequest;
    const item = await itemRepo.findOne({ where: { id: req.params.id } });
    if (!item) throw new NotFoundError('Item not found');

    const section = await sectionRepo.findOne({ where: { id: item.sectionId } });
    if (section?.isReserved) {
      const count = await itemRepo.count({ where: { sectionId: section.id } });
      if (count <= 1) {
        throw new ConflictError('Reserved section must keep at least one item', {
          reason: 'reserved_min_items',
          sectionId: section.id,
        });
      }
    }

    await itemRepo.remove(item);
    await logAudit(authReq.userId!, 'faq.item.delete', 'faq_item', req.params.id);
    sendNoContent(res);
  })
);

/**
 * POST /faq/reorder — bulk position update for sections and/or items. All
 * updates run in a single transaction; last writer wins under concurrent edits.
 */
router.post(
  '/reorder',
  validate(reorderFaqSchema),
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const authReq = req as ProvisionedRequest;
    const { sections, items } = req.body;

    await runInTransaction(async (manager) => {
      if (sections?.length) {
        for (const s of sections) {
          await manager.update(FaqSection, { id: s.id }, { position: s.position });
        }
      }
      if (items?.length) {
        for (const it of items) {
          await manager.update(
            FaqItem,
            { id: it.id },
            { position: it.position, sectionId: it.sectionId }
          );
        }
      }
    });

    await logAudit(authReq.userId!, 'faq.reorder', 'faq', 'bulk', undefined, {
      sectionCount: sections?.length ?? 0,
      itemCount: items?.length ?? 0,
    });
    sendNoContent(res);
  })
);

export default router;
