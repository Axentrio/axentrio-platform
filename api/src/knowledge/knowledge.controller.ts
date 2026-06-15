import crypto from 'crypto';
import { Request, Response } from 'express';
import { KnowledgeService } from './knowledge.service';
import { AppDataSource } from '../database/data-source';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { createS3Client } from '../config/s3.config';
import { config } from '../config/environment';
import { encrypt } from '../utils/encryption';
import { logger } from '../utils/logger';
import { generateResponse } from '../llm/rag.service';
import {
  updateKnowledgeBaseSchema,
  createDocumentSchema,
  updateDocumentSchema,
  listDocumentsSchema,
} from '../schemas/knowledge.schema';
import { updateAiSettingsSchema, testChatSchema } from '../schemas/ai-settings.schema';
import { Tenant } from '../database/entities/Tenant';
import { buildSystemPrompt } from '../llm/prompt-builder';
import { resolveBoundTemplate, effectiveConfigFrom, withEffectiveConfig } from '../templates/template-resolver';
import { DEFAULT_PROVIDER, DEFAULT_MODEL } from '../llm/defaults';
import { sendSuccess, sendCreated, sendNoContent } from '../utils/response';
import { ApiError, BadRequestError, NotFoundError } from '../middleware/error-handler';
import { ERROR_CODES } from '../middleware/error-codes';
import {
  getAnchorBotConfig,
  replaceAnchorBotSettingsSection,
} from '../services/bot-config.service';

let knowledgeService: KnowledgeService;

function getService(): KnowledgeService {
  if (!knowledgeService) {
    knowledgeService = new KnowledgeService(AppDataSource);
  }
  return knowledgeService;
}

export async function getKnowledgeBase(req: Request, res: Response) {
  const tenantId = (req as any).tenantId;
  const kb = await getService().getOrCreateKnowledgeBase(tenantId);
  sendSuccess(res, kb);
}

export async function updateKnowledgeBase(req: Request, res: Response) {
  const tenantId = (req as any).tenantId;
  const data = updateKnowledgeBaseSchema.parse(req.body);
  const { kb, configChanged } = await getService().updateKnowledgeBase(tenantId, data);

  if (configChanged) {
    // reprocessAllDocuments already set all docs to pending and returned them
    const pendingDocs = await getService().reprocessAllDocuments(tenantId, kb.id);
    for (const doc of pendingDocs) {
      try {
        const { addJob } = await import('../queue/message-queue');
        await addJob('knowledge-processing', {
          documentId: doc.id,
          tenantId,
          processingVersion: doc.processingVersion,
        }, { jobId: `kb-${doc.id}-v${doc.processingVersion}` });
      } catch (err) {
        logger.warn(`Failed to queue reprocessing for doc ${doc.id}`, { error: err });
      }
    }
  }

  sendSuccess(res, kb);
}

export async function listDocuments(req: Request, res: Response) {
  const tenantId = (req as any).tenantId;
  const filters = listDocumentsSchema.parse(req.query);
  const result = await getService().listDocuments(tenantId, filters);
  sendSuccess(res, result);
}

export async function createDocument(req: Request, res: Response) {
  const tenantId = (req as any).tenantId;
  const data = createDocumentSchema.parse(req.body);
  const doc = await getService().createDocument(tenantId, data);

  try {
    const { addJob } = await import('../queue/message-queue');
    await addJob('knowledge-processing', {
      documentId: doc.id,
      tenantId,
      processingVersion: doc.processingVersion,
    }, { jobId: `kb-${doc.id}-v${doc.processingVersion}` });
  } catch (err) {
    logger.warn('Failed to queue ingestion job, document stays pending', { error: err });
  }

  sendCreated(res, doc);
}

export async function getDocument(req: Request, res: Response) {
  const tenantId = (req as any).tenantId;
  const doc = await getService().getDocument(tenantId, req.params.id);
  if (!doc) {
    throw new NotFoundError('Document not found');
  }
  sendSuccess(res, doc);
}

export async function updateDocument(req: Request, res: Response) {
  const tenantId = (req as any).tenantId;
  const data = updateDocumentSchema.parse(req.body);
  const doc = await getService().updateDocument(tenantId, req.params.id, data);

  try {
    const { addJob } = await import('../queue/message-queue');
    await addJob('knowledge-processing', {
      documentId: doc.id,
      tenantId,
      processingVersion: doc.processingVersion,
    }, { jobId: `kb-${doc.id}-v${doc.processingVersion}` });
  } catch (err) {
    logger.warn('Failed to queue reprocessing job', { error: err });
  }

  sendSuccess(res, doc);
}

export async function deleteDocument(req: Request, res: Response) {
  const tenantId = (req as any).tenantId;
  await getService().deleteDocument(tenantId, req.params.id);
  sendNoContent(res);
}

export async function retryDocument(req: Request, res: Response) {
  const tenantId = (req as any).tenantId;
  const doc = await getService().retryDocument(tenantId, req.params.id);

  try {
    const { addJob } = await import('../queue/message-queue');
    await addJob('knowledge-processing', {
      documentId: doc.id,
      tenantId,
      processingVersion: doc.processingVersion,
    }, { jobId: `kb-${doc.id}-v${doc.processingVersion}` });
  } catch (err) {
    logger.warn('Failed to queue retry job', { error: err });
  }

  sendSuccess(res, doc);
}

export async function uploadFile(req: Request, res: Response) {
  const tenantId = (req as any).tenantId;
  const file = (req as any).file;
  if (!file) {
    throw new BadRequestError('No file provided');
  }

  if (!config.s3?.bucket) {
    throw new ApiError('File storage is not configured', 503, ERROR_CODES.FILE_SERVICE_UNAVAILABLE);
  }

  const key = `knowledge/${tenantId}/${crypto.randomUUID()}/${file.originalname}`;

  const s3 = createS3Client();
  await s3.send(new PutObjectCommand({
    Bucket: config.s3.bucket,
    Key: key,
    Body: file.buffer,
    ContentType: file.mimetype,
  }));

  const token = getService().registerUploadToken(tenantId, key);
  sendSuccess(res, { uploadToken: token });
}

export async function getStats(req: Request, res: Response) {
  const tenantId = (req as any).tenantId;
  const stats = await getService().getStats(tenantId);
  sendSuccess(res, stats);
}

export async function getAiSettings(req: Request, res: Response) {
  const tenantId = (req as any).tenantId;
  // Multi-bot Phase 4 (#16d): behavioural AI config (brand voice, guardrails,
  // provider/model/supportEmail) lives on Bot.settings. The provider apiKey
  // stays on Tenant.settings.ai.apiKey and is merged in only to render the
  // `hasApiKey` boolean — the secret itself is never sent down the wire.
  const { settings: botSettings } = await getAnchorBotConfig(tenantId);
  const botAi = botSettings.ai;

  if (botAi) {
    const tenant = await AppDataSource.getRepository(Tenant).findOneOrFail({ where: { id: tenantId } });
    const tenantApiKey = tenant.settings?.ai?.apiKey;
    // Bot.settings.ai never carries apiKey — strip it defensively in case a
    // stale row from before the cutover still has it set.
    const { apiKey: _stale, ...rest } = botAi as { apiKey?: string } & typeof botAi;
    sendSuccess(res, { ...rest, hasApiKey: !!tenantApiKey });
  } else {
    // Portal-tolerance audit (plan §2.3): all `useGetAiSettings` callers in
    // portal/src use optional chaining (`aiSettings?.enabled`) or explicit
    // null checks (`if (!aiSettings) return`) — null unwrap is safe.
    sendSuccess(res, null);
  }
}

export async function updateAiSettings(req: Request, res: Response) {
  const tenantId = (req as any).tenantId;
  const data = updateAiSettingsSchema.parse(req.body);

  // Multi-bot Phase 4 (#16d): split the write surface.
  //   - Behavioural AI config (everything under `ai` EXCEPT `apiKey`) → Bot.settings
  //   - `ai.apiKey` (LLM provider secret) → stays on Tenant.settings.ai.apiKey
  // Bot.settings.ai never carries apiKey by architectural rule — see
  // bot-config.service.ts header.
  const { settings: botSettings } = await getAnchorBotConfig(tenantId);
  const existingBotAi: any = botSettings.ai || {};
  const updatedBotAi: any = { ...existingBotAi };
  // Strip any stale apiKey from a pre-cutover row.
  delete updatedBotAi.apiKey;

  if (data.enabled !== undefined) updatedBotAi.enabled = data.enabled;
  if (data.provider !== undefined) updatedBotAi.provider = data.provider ?? null;
  if (data.model !== undefined) updatedBotAi.model = data.model ?? null;
  if (data.supportEmail !== undefined) {
    updatedBotAi.supportEmail = data.supportEmail || null;
  }
  if (data.brandVoice) updatedBotAi.brandVoice = { ...existingBotAi.brandVoice, ...data.brandVoice };
  if (data.guardrails) updatedBotAi.guardrails = { ...existingBotAi.guardrails, ...data.guardrails };

  // Wholesale section replacement on `ai` (not a partial patch): the
  // controller builds the full new ai shape from existingBotAi + the input.
  // Replace-section also strips any stale apiKey defensively (per the service
  // header — bot.settings.ai never carries apiKey).
  await replaceAnchorBotSettingsSection(tenantId, 'ai', updatedBotAi);

  // Handle the apiKey + webhook auto-provision on the tenant row.
  const tenantRepo = AppDataSource.getRepository(Tenant);
  const tenant = await tenantRepo.findOneOrFail({ where: { id: tenantId } });

  let tenantTouched = false;
  if (data.apiKey !== undefined) {
    const existingTenantAi: any = tenant.settings?.ai || {};
    tenant.settings = {
      ...tenant.settings,
      ai: {
        ...existingTenantAi,
        apiKey: data.apiKey ? encrypt(data.apiKey) : null,
      },
    };
    tenantTouched = true;
  }

  // No webhook auto-provisioning: AI bots are answered by the platform agent,
  // not the (dead) default n8n webhook. A genuinely custom tenant.webhookUrl is
  // left untouched. See issue #3.

  if (tenantTouched) {
    await tenantRepo.save(tenant);
  }

  // Build the response — strip apiKey, surface hasApiKey from the tenant row.
  const tenantApiKey = tenant.settings?.ai?.apiKey;
  const { apiKey: _stripped, ...rest } = updatedBotAi;
  sendSuccess(res, { ...rest, hasApiKey: !!tenantApiKey });
}

export async function testChat(req: Request, res: Response) {
  const tenantId = (req as any).tenantId;
  const { message, history, useKnowledgeBase } = testChatSchema.parse(req.body);
  const tenantRepo = AppDataSource.getRepository(Tenant);
  const tenant = await tenantRepo.findOneOrFail({ where: { id: tenantId } });

  // Multi-bot Phase 4 (#16d): behavioural AI from anchor Bot; provider apiKey
  // from Tenant (secret stays tenant-scoped).
  const { bot, settings: botSettings } = await getAnchorBotConfig(tenantId);
  const botAi = botSettings.ai;
  if (!botAi?.enabled) {
    throw new BadRequestError('AI is not enabled. Save your AI settings first.');
  }
  if (!botAi.brandVoice?.name) {
    throw new BadRequestError('Incomplete AI settings. Set a chatbot name first.');
  }

  const tenantApiKey = tenant.settings?.ai?.apiKey;
  // Merge for downstream consumers that still expect a single `aiSettings`
  // object (e.g. `generateResponse`). The apiKey is read-only here — we are
  // NOT writing this merged shape anywhere.
  type TenantAi = NonNullable<NonNullable<Tenant['settings']>['ai']>;
  const ai: TenantAi = { ...botAi, apiKey: tenantApiKey ?? null } as TenantAi;

  // Platform-standardised model/provider (not per-bot/tenant).
  const provider = DEFAULT_PROVIDER;
  const model = DEFAULT_MODEL;

  // Resolve the bound template once → body (layer 2) + effective tone/guardrails,
  // so the preview matches the live composed prompt exactly.
  const resolved = await resolveBoundTemplate(bot);
  const templateBody = resolved.body;
  const aiEff = withEffectiveConfig(ai, effectiveConfigFrom(resolved));

  if (useKnowledgeBase) {
    let result;
    try {
      // TODO(multi-bot Phase 3 UI): when the test/preview chat targets a
      // specific bot, pass that bot's attached KB ids here. For now this
      // tenant-level preview stays tenant-wide (knowledgeBaseIds omitted).
      result = await generateResponse(AppDataSource, tenantId, aiEff, message, history, undefined, templateBody);
    } catch (err: any) {
      const msg = err?.message || '';
      if (msg.includes('OPENAI_API_KEY')) {
        throw new BadRequestError(
          'Knowledge base requires OPENAI_API_KEY environment variable for embeddings.',
        );
      }
      logger.error('Test chat RAG failed', err);
      throw new ApiError(
        'RAG pipeline failed. Check server logs.',
        500,
        ERROR_CODES.UPSTREAM_FAILED,
      );
    }
    sendSuccess(res, {
      response:
        result.response ||
        aiEff.guardrails?.fallbackMessage ||
        'I could not find an answer in the knowledge base.',
      provider,
      model,
      confidence: result.confidence,
      chunksUsed: result.chunks.length,
    });
  } else {
    const { getProvider } = await import('../llm/provider-factory');
    // Secret apiKey path — still sourced from tenant (per architectural rule).
    const llm = getProvider(provider, tenantApiKey ?? undefined);

    const systemPrompt = buildSystemPrompt(aiEff, { businessName: tenant.name, templateBody });

    const messages = [
      { role: 'system' as const, content: systemPrompt },
      ...history.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      { role: 'user' as const, content: message },
    ];

    let response;
    try {
      response = await llm.chat(messages, {
        model,
        maxTokens: 1000,
        temperature: 0.3,
        jsonMode: false,
      });
    } catch (err) {
      logger.error('Test chat LLM call failed', err);
      throw new ApiError(
        'LLM call failed. Check your API key and model.',
        500,
        ERROR_CODES.UPSTREAM_FAILED,
      );
    }
    sendSuccess(res, {
      response: response.content,
      provider,
      model,
    });
  }
}
