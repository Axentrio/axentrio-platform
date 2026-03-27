import { Router } from 'express';
import multer from 'multer';
import { asyncHandler } from '../middleware/error-handler';
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

// Read-only: admin, supervisor
router.get('/base', requireRole('admin', 'supervisor'), asyncHandler(ctrl.getKnowledgeBase));
router.get('/documents', requireRole('admin', 'supervisor'), asyncHandler(ctrl.listDocuments));
router.get('/documents/:id', requireRole('admin', 'supervisor'), asyncHandler(ctrl.getDocument));
router.get('/stats', requireRole('admin', 'supervisor'), asyncHandler(ctrl.getStats));

// Write: admin only
router.patch('/base', requireRole('admin'), asyncHandler(ctrl.updateKnowledgeBase));
router.post('/documents/upload', requireRole('admin'), upload.single('file'), asyncHandler(ctrl.uploadFile));
router.post('/documents', requireRole('admin'), asyncHandler(ctrl.createDocument));
router.put('/documents/:id', requireRole('admin'), asyncHandler(ctrl.updateDocument));
router.delete('/documents/:id', requireRole('admin'), asyncHandler(ctrl.deleteDocument));
router.post('/documents/:id/retry', requireRole('admin'), asyncHandler(ctrl.retryDocument));

export default router;
