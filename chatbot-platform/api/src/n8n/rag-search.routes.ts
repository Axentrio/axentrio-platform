/**
 * Internal RAG Search Endpoint
 * Called by n8n to search tenant knowledge bases.
 * Auth: Bearer token using RAG_INTERNAL_SECRET (platform-level, not per-tenant).
 */

import { Router, Request, Response, NextFunction } from 'express';
import { body, validationResult } from 'express-validator';
import { config } from '../config/environment';
import { logger } from '../utils/logger';
import { AppDataSource } from '../database/data-source';
import { searchKnowledge } from '../llm/rag.service';

const router = Router();

function verifyInternalAuth(req: Request, res: Response, next: NextFunction): void {
  const secret = config.n8n.ragInternalSecret;
  if (!secret) {
    logger.warn('[RAG Search] RAG_INTERNAL_SECRET not configured — endpoint disabled');
    res.status(503).json({ error: 'RAG search endpoint not configured' });
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${secret}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  next();
}

router.post(
  '/search',
  verifyInternalAuth,
  [
    body('tenantId').isUUID().withMessage('tenantId must be a valid UUID'),
    body('query').isString().notEmpty().withMessage('query is required'),
    body('maxChunks').optional().isInt({ min: 1, max: 20 }).withMessage('maxChunks must be 1-20'),
    body('conversationHistory').optional().isArray().withMessage('conversationHistory must be an array'),
  ],
  async (req: Request, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ error: 'Validation failed', details: errors.array() });
      return;
    }

    const { tenantId, query, maxChunks, conversationHistory } = req.body;

    try {
      const result = await searchKnowledge(
        AppDataSource,
        tenantId,
        query,
        conversationHistory || [],
        maxChunks || 5
      );

      res.json(result);
    } catch (error) {
      logger.error('[RAG Search] Search failed', error);
      res.status(500).json({ error: 'Search failed' });
    }
  }
);

export default router;
