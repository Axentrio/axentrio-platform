import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { ApiError, asyncHandler } from '../middleware/error-handler';
import { requireClerkAuth, autoProvision } from '../middleware/clerk.middleware';
import { resolveTenantContext } from '../middleware/super-admin.middleware';
import { requireRole } from '../middleware/auth.middleware';
import * as ctrl from './knowledge.controller';

const router = Router();

// All routes require authentication
router.use(requireClerkAuth, autoProvision, resolveTenantContext);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    cb(null, allowed.includes(file.mimetype));
  },
});

// Read-only: admin, supervisor, agent (super_admin bypasses via middleware)
router.get('/base', requireRole('admin', 'supervisor', 'agent'), asyncHandler(ctrl.getKnowledgeBase));
router.get('/documents', requireRole('admin', 'supervisor', 'agent'), asyncHandler(ctrl.listDocuments));
router.get('/documents/:id', requireRole('admin', 'supervisor', 'agent'), asyncHandler(ctrl.getDocument));
router.get('/stats', requireRole('admin', 'supervisor', 'agent'), asyncHandler(ctrl.getStats));

// Write: admin only (super_admin bypasses via middleware)
router.patch('/base', requireRole('admin'), asyncHandler(ctrl.updateKnowledgeBase));
router.post('/documents/upload', requireRole('admin'), upload.single('file'), asyncHandler(ctrl.uploadFile));
router.post('/documents', requireRole('admin'), asyncHandler(ctrl.createDocument));
router.put('/documents/:id', requireRole('admin'), asyncHandler(ctrl.updateDocument));
router.delete('/documents/:id', requireRole('admin'), asyncHandler(ctrl.deleteDocument));
router.post('/documents/:id/retry', requireRole('admin'), asyncHandler(ctrl.retryDocument));

// Adapter: multer errors (e.g. LIMIT_FILE_SIZE) reach Express before the
// controller runs, so they bypass asyncHandler's ZodError adapter. Convert
// them to ApiError so the global handler emits the standard envelope with
// the multer code preserved in error.code (e.g. LIMIT_FILE_SIZE).
router.use((err: Error, _req: Request, _res: Response, next: NextFunction) => {
  if (err instanceof multer.MulterError) {
    return next(new ApiError(err.message, 400, err.code));
  }
  return next(err);
});

export default router;
