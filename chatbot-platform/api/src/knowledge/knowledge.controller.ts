import crypto from 'crypto';
import { Request, Response } from 'express';
import { KnowledgeService } from './knowledge.service';
import { AppDataSource } from '../database/data-source';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
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
import { updateAiSettingsSchema, testAiSettingsSchema } from '../schemas/ai-settings.schema';
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

  const s3 = new S3Client({ region: config.s3.region });
  await s3.send(new PutObjectCommand({
    Bucket: config.s3.bucket,
    Key: key,
    Body: file.buffer,
    ContentType: file.mimetype,
    ServerSideEncryption: 'AES256',
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
  const { question } = testAiSettingsSchema.parse(req.body);
  const tenantRepo = AppDataSource.getRepository(Tenant);
  const tenant = await tenantRepo.findOneOrFail({ where: { id: tenantId } });

  const ai = tenant.settings?.ai;
  if (!ai?.enabled) {
    res.status(400).json({ error: 'AI is not enabled' });
    return;
  }

  // Simple LLM ping — just test that the API key and model work, no embeddings needed
  const { getProvider } = await import('../llm/provider-factory');
  const provider = getProvider(ai.provider, ai.apiKey);
  const response = await provider.chat(
    [
      { role: 'system', content: 'You are a helpful assistant. Reply briefly.' },
      { role: 'user', content: question },
    ],
    { model: ai.model, maxTokens: 200, temperature: 0.3 }
  );

  res.json({
    response: response.content,
    confidence: 1,
    chunks: [],
    provider: ai.provider,
    model: ai.model,
  });
}
