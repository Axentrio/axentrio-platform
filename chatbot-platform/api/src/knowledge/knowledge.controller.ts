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
import { updateAiSettingsSchema, testAiSettingsSchema, testChatSchema } from '../schemas/ai-settings.schema';
import { Tenant } from '../database/entities/Tenant';

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
  res.json(kb);
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

  res.json(kb);
}

export async function listDocuments(req: Request, res: Response) {
  const tenantId = (req as any).tenantId;
  const filters = listDocumentsSchema.parse(req.query);
  const result = await getService().listDocuments(tenantId, filters);
  res.json(result);
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

  res.status(201).json(doc);
}

export async function getDocument(req: Request, res: Response) {
  const tenantId = (req as any).tenantId;
  const doc = await getService().getDocument(tenantId, req.params.id);
  if (!doc) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }
  res.json(doc);
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

  res.json(doc);
}

export async function deleteDocument(req: Request, res: Response) {
  const tenantId = (req as any).tenantId;
  await getService().deleteDocument(tenantId, req.params.id);
  res.status(204).send();
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

  res.json(doc);
}

export async function uploadFile(req: Request, res: Response) {
  const tenantId = (req as any).tenantId;
  const file = (req as any).file;
  if (!file) {
    res.status(400).json({ error: 'No file provided' });
    return;
  }

  if (!config.s3?.bucket) {
    res.status(503).json({ error: 'File storage is not configured' });
    return;
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
  res.json({ uploadToken: token });
}

export async function getStats(req: Request, res: Response) {
  const tenantId = (req as any).tenantId;
  const stats = await getService().getStats(tenantId);
  res.json(stats);
}

export async function getAiSettings(req: Request, res: Response) {
  const tenantId = (req as any).tenantId;
  const tenant = await AppDataSource.getRepository(Tenant).findOneOrFail({ where: { id: tenantId } });
  const ai = tenant.settings?.ai || null;

  if (ai) {
    const { apiKey, ...rest } = ai;
    res.json({ ...rest, hasApiKey: !!apiKey });
  } else {
    res.json(null);
  }
}

export async function updateAiSettings(req: Request, res: Response) {
  const tenantId = (req as any).tenantId;
  const data = updateAiSettingsSchema.parse(req.body);
  const tenantRepo = AppDataSource.getRepository(Tenant);
  const tenant = await tenantRepo.findOneOrFail({ where: { id: tenantId } });

  const existingAi: any = tenant.settings?.ai || {};
  const updatedAi: any = { ...existingAi };

  if (data.enabled !== undefined) updatedAi.enabled = data.enabled;
  if (data.provider) updatedAi.provider = data.provider;
  if (data.model) updatedAi.model = data.model;
  if (data.apiKey !== undefined) {
    updatedAi.apiKey = data.apiKey ? encrypt(data.apiKey) : null;
  }
  if (data.brandVoice) updatedAi.brandVoice = { ...existingAi.brandVoice, ...data.brandVoice };
  if (data.guardrails) updatedAi.guardrails = { ...existingAi.guardrails, ...data.guardrails };

  tenant.settings = { ...tenant.settings, ai: updatedAi };
  await tenantRepo.save(tenant);

  const { apiKey, ...rest } = updatedAi;
  res.json({ ...rest, hasApiKey: !!apiKey });
}

export async function testAiSettings(req: Request, res: Response) {
  const tenantId = (req as any).tenantId;
  const { question, provider: inlineProvider, model: inlineModel, apiKey: inlineApiKey } = testAiSettingsSchema.parse(req.body);
  const tenantRepo = AppDataSource.getRepository(Tenant);
  const tenant = await tenantRepo.findOneOrFail({ where: { id: tenantId } });

  const ai = tenant.settings?.ai;

  // Use inline values from the form, fall back to saved settings
  const testProvider = inlineProvider || ai?.provider;
  const testModel = inlineModel || ai?.model;
  const testApiKey = inlineApiKey || ai?.apiKey;

  if (!testProvider || !testModel) {
    res.status(400).json({ error: 'Provider and model are required' });
    return;
  }

  // Simple LLM ping — just test that the API key and model work
  const { getProvider } = await import('../llm/provider-factory');
  // If an inline (unencrypted) API key is provided, pass it directly; otherwise use saved encrypted key
  const provider = inlineApiKey
    ? getProvider(testProvider, undefined, inlineApiKey)
    : getProvider(testProvider, testApiKey);
  const response = await provider.chat(
    [
      { role: 'system', content: 'You are a helpful assistant. Reply briefly.' },
      { role: 'user', content: question },
    ],
    { model: testModel, maxTokens: 200, temperature: 0.3, jsonMode: false }
  );

  res.json({
    response: response.content,
    provider: testProvider,
    model: testModel,
  });
}

export async function testChat(req: Request, res: Response) {
  const tenantId = (req as any).tenantId;
  const { message, history, useKnowledgeBase } = testChatSchema.parse(req.body);
  const tenantRepo = AppDataSource.getRepository(Tenant);
  const tenant = await tenantRepo.findOneOrFail({ where: { id: tenantId } });

  const ai = tenant.settings?.ai;
  if (!ai?.enabled) {
    res.status(400).json({ error: 'AI is not enabled. Save your AI settings first.' });
    return;
  }
  if (!ai.provider || !ai.model || !ai.brandVoice?.name) {
    res.status(400).json({ error: 'Incomplete AI settings. Configure provider, model, and brand voice first.' });
    return;
  }

  if (useKnowledgeBase) {
    try {
      const result = await generateResponse(AppDataSource, tenantId, ai, message, history);
      res.json({
        response: result.response || ai.guardrails?.fallbackMessage || 'I could not find an answer in the knowledge base.',
        provider: ai.provider,
        model: ai.model,
        confidence: result.confidence,
        chunksUsed: result.chunks.length,
      });
    } catch (err: any) {
      const msg = err?.message || '';
      if (msg.includes('OPENAI_API_KEY')) {
        res.status(400).json({ error: 'Knowledge base requires OPENAI_API_KEY environment variable for embeddings.' });
      } else {
        logger.error('Test chat RAG failed', err);
        res.status(500).json({ error: 'RAG pipeline failed. Check server logs.' });
      }
    }
  } else {
    const { getProvider } = await import('../llm/provider-factory');
    const provider = getProvider(ai.provider, ai.apiKey);

    const systemPrompt = `You are ${ai.brandVoice.name}.
Tone: ${ai.brandVoice.tone}
${ai.brandVoice.customInstructions}

Rules:
- Never discuss: ${ai.guardrails.topicsToAvoid.join(', ') || 'N/A'}
- Max response: ${ai.guardrails.maxResponseLength} characters
- If you cannot help, say: "${ai.guardrails.fallbackMessage}"`;

    const messages = [
      { role: 'system' as const, content: systemPrompt },
      ...history.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      { role: 'user' as const, content: message },
    ];

    try {
      const response = await provider.chat(messages, {
        model: ai.model,
        maxTokens: 1000,
        temperature: 0.3,
        jsonMode: false,
      });

      res.json({
        response: response.content,
        provider: ai.provider,
        model: ai.model,
      });
    } catch (err) {
      logger.error('Test chat LLM call failed', err);
      res.status(500).json({ error: 'LLM call failed. Check your API key and model.' });
    }
  }
}
