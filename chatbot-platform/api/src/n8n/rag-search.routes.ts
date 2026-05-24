/**
 * Internal RAG Search Endpoint
 * Called by n8n to search tenant knowledge bases.
 * Auth: Bearer token using RAG_INTERNAL_SECRET (platform-level, not per-tenant).
 */

import crypto from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import { body, validationResult } from 'express-validator';
import { rateLimit } from 'express-rate-limit';
import { config } from '../config/environment';
import { logger } from '../utils/logger';
import { AppDataSource } from '../database/data-source';
import { searchKnowledge } from '../llm/rag.service';
import { getBotKnowledgeBaseIds } from '../knowledge/bot-knowledge-bases';

const router = Router();

// Rate limit: 60 requests per minute for internal endpoints
const internalRateLimiter = rateLimit({
  windowMs: 60000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});
router.use(internalRateLimiter);

function verifyInternalAuth(req: Request, res: Response, next: NextFunction): void {
  const secret = config.n8n.ragInternalSecret;
  if (!secret) {
    logger.warn('[RAG Search] RAG_INTERNAL_SECRET not configured — endpoint disabled');
    res.status(503).json({ error: 'RAG search endpoint not configured' });
    return;
  }

  const authHeader = req.headers.authorization || '';
  const expected = `Bearer ${secret}`;
  if (authHeader.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected))) {
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
    body('botId').optional().isUUID().withMessage('botId must be a valid UUID'),
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

    const { tenantId, botId, query, maxChunks, conversationHistory } = req.body;

    try {
      // Multi-bot: when n8n sends botId, scope retrieval to that bot's attached
      // KBs (empty → no knowledge per I12). Omitted botId → tenant-wide (legacy),
      // pending the n8n workflow update that begins sending botId.
      const botKbIds = botId ? await getBotKnowledgeBaseIds(AppDataSource, botId) : undefined;
      const result = await searchKnowledge(
        AppDataSource,
        tenantId,
        query,
        conversationHistory || [],
        maxChunks || 5,
        botKbIds
      );

      res.json(result);
    } catch (error) {
      logger.error('[RAG Search] Search failed', error);
      res.status(500).json({ error: 'Search failed' });
    }
  }
);

export default router;
