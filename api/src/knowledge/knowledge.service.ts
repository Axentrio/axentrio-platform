import crypto from 'crypto';
import { DataSource, Repository, IsNull } from 'typeorm';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { createS3Client } from '../config/s3.config';
import { KnowledgeBase } from '../database/entities/KnowledgeBase';
import { KnowledgeDocument, DocumentType } from '../database/entities/KnowledgeDocument';
import { KnowledgeChunk } from '../database/entities/KnowledgeChunk';
import { Tenant } from '../database/entities/Tenant';
import { config } from '../config/environment';
import { logger } from '../utils/logger';

const uploadTokens = new Map<string, { tenantId: string; storagePath: string; expiresAt: Date }>();

// Periodically clean expired upload tokens (every 15 minutes)
setInterval(() => {
  const now = new Date();
  for (const [key, val] of uploadTokens) {
    if (val.expiresAt < now) uploadTokens.delete(key);
  }
}, 15 * 60 * 1000).unref();

const DOCUMENT_LIMITS: Record<string, number> = {
  free: 50,
  pro: 500,
  enterprise: Infinity,
};

let s3ClientInstance: ReturnType<typeof createS3Client> | null = null;
function getS3Client() {
  if (!s3ClientInstance) {
    s3ClientInstance = createS3Client();
  }
  return s3ClientInstance;
}

export class KnowledgeService {
  private kbRepo: Repository<KnowledgeBase>;
  private docRepo: Repository<KnowledgeDocument>;
  private chunkRepo: Repository<KnowledgeChunk>;
  private tenantRepo: Repository<Tenant>;

  constructor(dataSource: DataSource) {
    this.kbRepo = dataSource.getRepository(KnowledgeBase);
    this.docRepo = dataSource.getRepository(KnowledgeDocument);
    this.chunkRepo = dataSource.getRepository(KnowledgeChunk);
    this.tenantRepo = dataSource.getRepository(Tenant);
  }

  /**
   * Resolve the tenant-primary (bot-less) KnowledgeBase, creating it if absent.
   * Multi-bot: tenant-level knowledge operations target the primary KB
   * (botId IS NULL); per-bot dedicated KBs are managed via the bots API. The
   * partial-unique index still protects against a concurrent double-create.
   */
  async getOrCreateKnowledgeBase(tenantId: string): Promise<KnowledgeBase> {
    let kb = await this.kbRepo.findOne({ where: { tenantId, botId: IsNull() } });
    if (!kb) {
      try {
        kb = this.kbRepo.create({ tenantId, botId: null, status: 'inactive' });
        kb = await this.kbRepo.save(kb);
      } catch (err: any) {
        // Race condition: another request created it between our findOne and save
        if (err?.message?.includes('duplicate key') || err?.code === '23505') {
          kb = await this.kbRepo.findOne({ where: { tenantId, botId: IsNull() } });
          if (!kb) throw err; // genuinely broken
        } else {
          throw err;
        }
      }
    }
    return kb!;
  }

  async updateKnowledgeBase(
    tenantId: string,
    updates: Partial<Pick<KnowledgeBase, 'chunkSize' | 'chunkOverlap' | 'status'>>
  ): Promise<{ kb: KnowledgeBase; configChanged: boolean }> {
    const kb = await this.getOrCreateKnowledgeBase(tenantId);
    const configChanged =
      (updates.chunkSize !== undefined && updates.chunkSize !== kb.chunkSize) ||
      (updates.chunkOverlap !== undefined && updates.chunkOverlap !== kb.chunkOverlap);

    Object.assign(kb, updates);
    const saved = await this.kbRepo.save(kb);

    return { kb: saved, configChanged };
  }

  async listDocuments(
    tenantId: string,
    filters?: { status?: string; type?: string; page?: number; limit?: number },
    kbId?: string,
  ) {
    // Target a specific KB (e.g. a bot's dedicated KB) when given; otherwise the
    // tenant's shared primary KB.
    const kb = kbId
      ? await this.kbRepo.findOneOrFail({ where: { id: kbId, tenantId } })
      : await this.getOrCreateKnowledgeBase(tenantId);
    const qb = this.docRepo
      .createQueryBuilder('doc')
      .where('doc.knowledgeBaseId = :kbId', { kbId: kb.id });

    if (filters?.status) qb.andWhere('doc.status = :status', { status: filters.status });
    if (filters?.type) qb.andWhere('doc.type = :type', { type: filters.type });

    const page = filters?.page || 1;
    const limit = filters?.limit || 20;
    qb.orderBy('doc.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [documents, total] = await qb.getManyAndCount();
    return { documents, total, page, limit };
  }

  async createDocument(
    tenantId: string,
    data: {
      type: DocumentType;
      title: string;
      sourceContent?: string;
      uploadToken?: string;
      metadata?: Record<string, any>;
    },
    kbId?: string,
  ): Promise<KnowledgeDocument> {
    // Target a specific KB (e.g. a bot's dedicated KB) when given; otherwise the
    // tenant's shared primary KB.
    const kb = kbId
      ? await this.kbRepo.findOneOrFail({ where: { id: kbId, tenantId } })
      : await this.getOrCreateKnowledgeBase(tenantId);

    // Enforce tier-based document limits
    const tenant = await this.tenantRepo.findOneOrFail({ where: { id: tenantId } });
    const limit = DOCUMENT_LIMITS[tenant.tier] ?? DOCUMENT_LIMITS.free;
    if (limit !== Infinity) {
      const docCount = await this.docRepo.count({ where: { knowledgeBaseId: kb.id } });
      if (docCount >= limit) {
        throw new Error(`Document limit reached for ${tenant.tier} tier (${limit} documents). Upgrade to add more.`);
      }
    }

    let storagePath: string | null = null;
    if (data.uploadToken) {
      const token = uploadTokens.get(data.uploadToken);
      if (!token || token.tenantId !== tenantId || token.expiresAt < new Date()) {
        throw new Error('Invalid or expired upload token');
      }
      storagePath = token.storagePath;
      uploadTokens.delete(data.uploadToken);
    }

    const doc = this.docRepo.create({
      knowledgeBaseId: kb.id,
      tenantId,
      type: data.type,
      title: data.title,
      sourceContent: data.sourceContent || null,
      storagePath,
      status: 'pending',
      processingVersion: 1,
      metadata: data.metadata || {},
    });

    return this.docRepo.save(doc);
  }

  async getDocument(tenantId: string, documentId: string): Promise<KnowledgeDocument | null> {
    return this.docRepo.findOne({ where: { id: documentId, tenantId } });
  }

  async updateDocument(
    tenantId: string,
    documentId: string,
    data: { title?: string; sourceContent?: string; metadata?: Record<string, any> }
  ): Promise<KnowledgeDocument> {
    const doc = await this.docRepo.findOneOrFail({ where: { id: documentId, tenantId } });
    if (data.title) doc.title = data.title;
    if (data.sourceContent) doc.sourceContent = data.sourceContent;
    if (data.metadata) doc.metadata = { ...doc.metadata, ...data.metadata };
    doc.processingVersion += 1;
    doc.status = 'pending';
    doc.qualityReport = null;
    return this.docRepo.save(doc);
  }

  async deleteDocument(tenantId: string, documentId: string): Promise<void> {
    const doc = await this.docRepo.findOneOrFail({ where: { id: documentId, tenantId } });

    // Delete S3 object if file-based document
    if (doc.storagePath && config.s3?.bucket) {
      try {
        await getS3Client().send(new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: doc.storagePath }));
      } catch (err) {
        logger.warn(`Failed to delete S3 object ${doc.storagePath}`, { error: err });
      }
    }

    await this.docRepo.remove(doc);
  }

  async retryDocument(tenantId: string, documentId: string): Promise<KnowledgeDocument> {
    const doc = await this.docRepo.findOneOrFail({ where: { id: documentId, tenantId } });
    if (doc.status !== 'failed') throw new Error('Only failed documents can be retried');
    doc.processingVersion += 1;
    doc.status = 'pending';
    doc.errorMessage = null;
    doc.qualityReport = null;
    return this.docRepo.save(doc);
  }

  registerUploadToken(tenantId: string, storagePath: string): string {
    const token = crypto.randomUUID();
    uploadTokens.set(token, {
      tenantId,
      storagePath,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    return token;
  }

  async getStats(tenantId: string) {
    const kb = await this.getOrCreateKnowledgeBase(tenantId);

    const docCounts = await this.docRepo
      .createQueryBuilder('doc')
      .select('doc.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('doc.knowledgeBaseId = :kbId', { kbId: kb.id })
      .groupBy('doc.status')
      .getRawMany();

    const [{ count: totalChunks }] = await this.chunkRepo
      .createQueryBuilder('chunk')
      .select('COUNT(*)', 'count')
      .where('chunk.tenantId = :tenantId', { tenantId })
      .getRawMany();

    return {
      knowledgeBaseId: kb.id,
      status: kb.status,
      lastIndexedAt: kb.lastIndexedAt,
      documents: Object.fromEntries(docCounts.map((r: any) => [r.status, parseInt(r.count)])),
      totalChunks: parseInt(totalChunks),
    };
  }

  async reprocessAllDocuments(tenantId: string, kbId: string): Promise<KnowledgeDocument[]> {
    const docs = await this.docRepo.find({ where: { knowledgeBaseId: kbId, tenantId } });
    for (const doc of docs) {
      doc.processingVersion += 1;
      doc.status = 'pending';
    }
    const saved = await this.docRepo.save(docs);
    logger.info(`Reprocessing ${docs.length} documents for tenant ${tenantId}`);
    return saved;
  }
}
