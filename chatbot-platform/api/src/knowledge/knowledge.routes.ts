import { Router } from 'express';
import multer from 'multer';
import { asyncHandler } from '../middleware/error-handler';
import { requireClerkAuth, autoProvision } from '../middleware/clerk.middleware';
import { resolveTenantContext } from '../middleware/super-admin.middleware';
import * as ctrl from './knowledge.controller';

const router = Router();

// All routes require agent authentication
router.use(requireClerkAuth, autoProvision, resolveTenantContext);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    cb(null, allowed.includes(file.mimetype));
  },
});

router.get('/base', asyncHandler(ctrl.getKnowledgeBase));
router.patch('/base', asyncHandler(ctrl.updateKnowledgeBase));
router.post('/documents/upload', upload.single('file'), asyncHandler(ctrl.uploadFile));
router.get('/documents', asyncHandler(ctrl.listDocuments));
router.post('/documents', asyncHandler(ctrl.createDocument));
router.get('/documents/:id', asyncHandler(ctrl.getDocument));
router.put('/documents/:id', asyncHandler(ctrl.updateDocument));
router.delete('/documents/:id', asyncHandler(ctrl.deleteDocument));
router.post('/documents/:id/retry', asyncHandler(ctrl.retryDocument));
router.get('/stats', asyncHandler(ctrl.getStats));

export default router;
