# RAG Knowledge Base Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-tenant RAG knowledge base with pgvector, multi-LLM abstraction, and inline bot responses.

**Architecture:** pgvector extension in existing PostgreSQL for vector storage. New `knowledge/` and `llm/` modules. RAG hooks into `message-forwarding.service.ts`. Async document ingestion via Bull queue. Multi-provider LLM abstraction (OpenAI + Anthropic) with tenant BYOK support.

**Tech Stack:** pgvector, TypeORM (raw SQL for vectors), OpenAI SDK (embeddings + chat), Anthropic SDK, Bull queue, pdf-parse, mammoth, multer.

**Spec:** `docs/superpowers/specs/2026-03-27-rag-knowledge-base-design.md`

---

### Task 1: Infrastructure & pgvector Setup

**Files:**
- Modify: `docker-compose.yml`
- Create: `api/src/database/migrations/1775000000000-AddPgvectorExtension.ts`

- [ ] **Step 1: Update Docker image to pgvector-enabled postgres**

In `docker-compose.yml`, change the postgres image:

```yaml
# Change:
    image: postgres:16-alpine
# To:
    image: pgvector/pgvector:pg16
```

- [ ] **Step 2: Create migration to enable pgvector extension**

Create file `api/src/database/migrations/1775000000000-AddPgvectorExtension.ts`:

```typescript
import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPgvectorExtension1775000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS vector`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP EXTENSION IF EXISTS vector`);
  }
}
```

- [ ] **Step 3: Verify pgvector works locally**

```bash
docker compose down && docker compose up -d postgres
# Wait for postgres to start, then:
cd api && npx typeorm migration:run -d src/database/data-source.ts
```

Expected: Migration runs without error. `SELECT * FROM pg_extension WHERE extname = 'vector'` returns one row.

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml api/src/database/migrations/1775000000000-AddPgvectorExtension.ts
git commit -m "feat: add pgvector extension to PostgreSQL"
```

---

### Task 2: Knowledge Base Entities

**Files:**
- Create: `api/src/database/entities/KnowledgeBase.ts`
- Create: `api/src/database/entities/KnowledgeDocument.ts`
- Create: `api/src/database/entities/KnowledgeChunk.ts`
- Create: `api/src/database/migrations/1775100000000-CreateKnowledgeTables.ts`
- Modify: `api/src/database/data-source.ts` (add entity imports, lines 11-21 and 34-46)

- [ ] **Step 1: Create KnowledgeBase entity**

Create file `api/src/database/entities/KnowledgeBase.ts`:

```typescript
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  OneToMany,
} from 'typeorm';
import { Tenant } from './Tenant';
import { KnowledgeDocument } from './KnowledgeDocument';

@Entity('knowledge_bases')
export class KnowledgeBase {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid', { unique: true })
  tenantId!: string;

  @ManyToOne(() => Tenant)
  @JoinColumn({ name: 'tenantId' })
  tenant!: Tenant;

  @Column({
    type: 'enum',
    enum: ['active', 'inactive'],
    default: 'inactive',
  })
  status!: 'active' | 'inactive';

  @Column({ type: 'varchar', default: 'text-embedding-3-small' })
  embeddingModel!: string;

  @Column({ type: 'int', default: 1000 })
  chunkSize!: number;

  @Column({ type: 'int', default: 200 })
  chunkOverlap!: number;

  @Column({ type: 'timestamp', nullable: true })
  lastIndexedAt!: Date | null;

  @OneToMany(() => KnowledgeDocument, (doc) => doc.knowledgeBase)
  documents!: KnowledgeDocument[];

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
```

- [ ] **Step 2: Create KnowledgeDocument entity**

Create file `api/src/database/entities/KnowledgeDocument.ts`:

```typescript
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Tenant } from './Tenant';
import { KnowledgeBase } from './KnowledgeBase';

export type DocumentType = 'text' | 'faq' | 'pdf' | 'docx';
export type DocumentStatus = 'pending' | 'processing' | 'indexed' | 'failed';

@Entity('knowledge_documents')
export class KnowledgeDocument {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid')
  knowledgeBaseId!: string;

  @ManyToOne(() => KnowledgeBase, (kb) => kb.documents)
  @JoinColumn({ name: 'knowledgeBaseId' })
  knowledgeBase!: KnowledgeBase;

  @Column('uuid')
  tenantId!: string;

  @ManyToOne(() => Tenant)
  @JoinColumn({ name: 'tenantId' })
  tenant!: Tenant;

  @Column({
    type: 'enum',
    enum: ['text', 'faq', 'pdf', 'docx'],
  })
  type!: DocumentType;

  @Column({ type: 'varchar' })
  title!: string;

  @Column({ type: 'text', nullable: true })
  sourceContent!: string | null;

  @Column({ type: 'varchar', nullable: true })
  storagePath!: string | null;

  @Column({
    type: 'enum',
    enum: ['pending', 'processing', 'indexed', 'failed'],
    default: 'pending',
  })
  status!: DocumentStatus;

  @Column({ type: 'int', default: 1 })
  processingVersion!: number;

  @Column({ type: 'varchar', nullable: true })
  errorMessage!: string | null;

  @Column({ type: 'int', default: 0 })
  chunkCount!: number;

  @Column({ type: 'jsonb', default: {} })
  metadata!: Record<string, any>;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
```

- [ ] **Step 3: Create KnowledgeChunk entity**

Create file `api/src/database/entities/KnowledgeChunk.ts`:

```typescript
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Tenant } from './Tenant';
import { KnowledgeDocument } from './KnowledgeDocument';

@Entity('knowledge_chunks')
export class KnowledgeChunk {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid')
  documentId!: string;

  @ManyToOne(() => KnowledgeDocument, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'documentId' })
  document!: KnowledgeDocument;

  @Column('uuid')
  tenantId!: string;

  @ManyToOne(() => Tenant)
  @JoinColumn({ name: 'tenantId' })
  tenant!: Tenant;

  @Column({ type: 'text' })
  content!: string;

  // embedding column excluded — managed via raw SQL (vector(1536))

  @Column({ type: 'int' })
  chunkIndex!: number;

  @Column({ type: 'int' })
  charCount!: number;

  @Column({ type: 'jsonb', default: {} })
  metadata!: Record<string, any>;

  @CreateDateColumn()
  createdAt!: Date;
}
```

- [ ] **Step 4: Create migration for knowledge tables**

Create file `api/src/database/migrations/1775100000000-CreateKnowledgeTables.ts`:

```typescript
import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateKnowledgeTables1775100000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // KnowledgeBase table
    await queryRunner.query(`
      CREATE TABLE knowledge_bases (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" UUID NOT NULL UNIQUE REFERENCES tenants(id),
        status VARCHAR NOT NULL DEFAULT 'inactive',
        "embeddingModel" VARCHAR NOT NULL DEFAULT 'text-embedding-3-small',
        "chunkSize" INT NOT NULL DEFAULT 1000,
        "chunkOverlap" INT NOT NULL DEFAULT 200,
        "lastIndexedAt" TIMESTAMP,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now()
      )
    `);

    // KnowledgeDocument table
    await queryRunner.query(`
      CREATE TABLE knowledge_documents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "knowledgeBaseId" UUID NOT NULL REFERENCES knowledge_bases(id),
        "tenantId" UUID NOT NULL REFERENCES tenants(id),
        type VARCHAR NOT NULL,
        title VARCHAR NOT NULL,
        "sourceContent" TEXT,
        "storagePath" VARCHAR,
        status VARCHAR NOT NULL DEFAULT 'pending',
        "processingVersion" INT NOT NULL DEFAULT 1,
        "errorMessage" VARCHAR,
        "chunkCount" INT NOT NULL DEFAULT 0,
        metadata JSONB NOT NULL DEFAULT '{}',
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`CREATE INDEX idx_knowledge_documents_tenant ON knowledge_documents("tenantId")`);
    await queryRunner.query(`CREATE INDEX idx_knowledge_documents_kb_status ON knowledge_documents("knowledgeBaseId", status)`);

    // KnowledgeChunk table (without embedding — added separately)
    await queryRunner.query(`
      CREATE TABLE knowledge_chunks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "documentId" UUID NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
        "tenantId" UUID NOT NULL REFERENCES tenants(id),
        content TEXT NOT NULL,
        "chunkIndex" INT NOT NULL,
        "charCount" INT NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}',
        "createdAt" TIMESTAMP NOT NULL DEFAULT now()
      )
    `);

    // Add vector column via raw SQL (TypeORM doesn't support vector type)
    await queryRunner.query(`ALTER TABLE knowledge_chunks ADD COLUMN embedding vector(1536)`);

    // Indexes
    await queryRunner.query(`CREATE INDEX idx_knowledge_chunks_tenant ON knowledge_chunks("tenantId")`);
    await queryRunner.query(`CREATE INDEX idx_knowledge_chunks_doc_idx ON knowledge_chunks("documentId", "chunkIndex")`);
    await queryRunner.query(`CREATE INDEX idx_knowledge_chunks_embedding ON knowledge_chunks USING hnsw (embedding vector_cosine_ops)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS knowledge_chunks`);
    await queryRunner.query(`DROP TABLE IF EXISTS knowledge_documents`);
    await queryRunner.query(`DROP TABLE IF EXISTS knowledge_bases`);
  }
}
```

- [ ] **Step 5: Register entities in data-source.ts**

In `api/src/database/data-source.ts`, add imports after line 21 and add to entities array:

```typescript
// Add imports:
import { KnowledgeBase } from './entities/KnowledgeBase';
import { KnowledgeDocument } from './entities/KnowledgeDocument';
import { KnowledgeChunk } from './entities/KnowledgeChunk';

// Add to entities array (after AuditLog):
  KnowledgeBase,
  KnowledgeDocument,
  KnowledgeChunk,
```

- [ ] **Step 6: Run migration and verify**

```bash
cd api && npx typeorm migration:run -d src/database/data-source.ts
```

Expected: Tables created. Verify with `\dt knowledge_*` in psql.

- [ ] **Step 7: Add pgvector test setup**

The test suite uses `synchronize: true` (not migrations), so the `vector` extension and `embedding` column won't exist in tests. Add to `api/src/__tests__/setup.ts` (or create a new test helper):

```typescript
// In test setup, after AppDataSource.initialize():
await AppDataSource.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
await AppDataSource.query('CREATE EXTENSION IF NOT EXISTS vector');
// After synchronize creates knowledge_chunks table:
await AppDataSource.query(`
  ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS embedding vector(1536)
`);
await AppDataSource.query(`
  CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON knowledge_chunks USING hnsw (embedding vector_cosine_ops)
`);
```

**Note:** The test database must also use the `pgvector/pgvector:pg16` image. Update test Docker config if separate.

- [ ] **Step 8: Commit**

```bash
git add api/src/database/entities/KnowledgeBase.ts api/src/database/entities/KnowledgeDocument.ts api/src/database/entities/KnowledgeChunk.ts api/src/database/migrations/1775100000000-CreateKnowledgeTables.ts api/src/database/data-source.ts api/src/__tests__/setup.ts
git commit -m "feat: add KnowledgeBase, KnowledgeDocument, KnowledgeChunk entities"
```

---

### Task 3: Tenant AI Settings Migration

**Files:**
- Modify: `api/src/database/entities/Tenant.ts` (line 61-83, settings type)
- Create: `api/src/database/migrations/1775200000000-AddAiSettingsToTenant.ts`
- Modify: `api/src/routes/widget.ts` (line 77-81)
- Modify: `api/src/routes/tenants.ts` (line 101-111)

- [ ] **Step 1: Update Tenant entity settings type**

In `api/src/database/entities/Tenant.ts`, update the `settings` type definition (around line 61-83) to add the `ai` field:

```typescript
@Column({ type: 'jsonb', default: {} })
settings!: {
  theme?: {
    primaryColor?: string;
    logoUrl?: string;
    customCss?: string;
  };
  features?: {
    fileUploadEnabled: boolean;
    handoffEnabled: boolean;
    // aiEnabled removed — replaced by settings.ai.enabled
  };
  businessHours?: {
    enabled: boolean;
    timezone: string;
    schedule: Array<{
      day: string;
      open: string;
      close: string;
      closed: boolean;
    }>;
  };
  ai?: {
    enabled: boolean;
    provider: 'openai' | 'anthropic';
    model: string;
    apiKey?: string;
    brandVoice: {
      name: string;
      tone: 'formal' | 'casual' | 'friendly' | 'professional';
      customInstructions: string;
    };
    guardrails: {
      topicsToAvoid: string[];
      escalationKeywords: string[];
      confidenceThreshold: number;
      maxResponseLength: number;
      greetingMessage: string;
      fallbackMessage: string;
      offHoursMessage: string;
    };
  };
};
```

- [ ] **Step 2: Create migration to move aiEnabled to settings.ai**

Create `api/src/database/migrations/1775200000000-AddAiSettingsToTenant.ts`:

```typescript
import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAiSettingsToTenant1775200000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Migrate settings.features.aiEnabled → settings.ai.enabled
    await queryRunner.query(`
      UPDATE tenants
      SET settings = jsonb_set(
        settings #- '{features,aiEnabled}',
        '{ai}',
        jsonb_build_object(
          'enabled', COALESCE((settings->'features'->>'aiEnabled')::boolean, false),
          'provider', 'openai',
          'model', 'gpt-4o-mini',
          'brandVoice', jsonb_build_object(
            'name', 'AI Assistant',
            'tone', 'friendly',
            'customInstructions', ''
          ),
          'guardrails', jsonb_build_object(
            'topicsToAvoid', '[]'::jsonb,
            'escalationKeywords', '[]'::jsonb,
            'confidenceThreshold', 0.7,
            'maxResponseLength', 500,
            'greetingMessage', 'Hello! How can I help you today?',
            'fallbackMessage', 'I''m not sure about that. Let me connect you with a human agent.',
            'offHoursMessage', 'We''re currently outside business hours. We''ll get back to you soon.'
          )
        )
      )
      WHERE settings->'features'->'aiEnabled' IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE tenants
      SET settings = jsonb_set(
        settings #- '{ai}',
        '{features,aiEnabled}',
        COALESCE(settings->'ai'->'enabled', 'false'::jsonb)
      )
      WHERE settings->'ai' IS NOT NULL
    `);
  }
}
```

- [ ] **Step 3: Update widget.ts to use settings.ai**

In `api/src/routes/widget.ts`, change the features response (around line 77-81):

```typescript
// Replace:
features: tenant.settings?.features || {
  fileUploadEnabled: false,
  handoffEnabled: true,
  aiEnabled: true,
},
// With:
features: {
  fileUploadEnabled: tenant.settings?.features?.fileUploadEnabled ?? false,
  handoffEnabled: tenant.settings?.features?.handoffEnabled ?? true,
  aiEnabled: tenant.settings?.ai?.enabled ?? false,
},
```

- [ ] **Step 4: Protect generic tenant PATCH from settings.ai writes**

In `api/src/routes/tenants.ts`, in the PATCH handler (around line 101-111), add a guard before the settings merge:

```typescript
// Add before the settings merge block:
if (settings?.ai !== undefined) {
  return res.status(400).json({
    error: 'AI settings cannot be updated via this endpoint. Use PATCH /tenants/me/ai-settings instead.',
  });
}
```

- [ ] **Step 5: Run migration**

```bash
cd api && npx typeorm migration:run -d src/database/data-source.ts
```

- [ ] **Step 6: Commit**

```bash
git add api/src/database/entities/Tenant.ts api/src/database/migrations/1775200000000-AddAiSettingsToTenant.ts api/src/routes/widget.ts api/src/routes/tenants.ts
git commit -m "feat: migrate tenant AI settings to settings.ai namespace"
```

---

### Task 4: Environment Variables & Dependencies

**Files:**
- Modify: `api/src/config/environment.ts`
- Modify: `api/package.json`

- [ ] **Step 1: Add new env vars to environment.ts**

In `api/src/config/environment.ts`, add to the `envSchema` (after the S3/AWS section, around line 102):

```typescript
// LLM / RAG
OPENAI_API_KEY: z.string().optional(),
ANTHROPIC_API_KEY: z.string().optional(),
RAG_DEFAULT_CHUNK_SIZE: z.string().default('1000').transform(Number),
RAG_DEFAULT_CHUNK_OVERLAP: z.string().default('200').transform(Number),
RAG_MAX_CONTEXT_CHUNKS: z.string().default('5').transform(Number),
RAG_MIN_SIMILARITY: z.string().default('0.5').transform(Number),
RAG_CONVERSATION_HISTORY_LIMIT: z.string().default('10').transform(Number),
RAG_EMBEDDING_BATCH_SIZE: z.string().default('100').transform(Number),
RAG_MAX_EXTRACTED_CHARS: z.string().default('500000').transform(Number),
RAG_MAX_CHUNKS_PER_DOC: z.string().default('1000').transform(Number),
```

Add to the `export const config` object:

```typescript
rag: {
  openaiApiKey: env.OPENAI_API_KEY,
  anthropicApiKey: env.ANTHROPIC_API_KEY,
  defaultChunkSize: env.RAG_DEFAULT_CHUNK_SIZE,
  defaultChunkOverlap: env.RAG_DEFAULT_CHUNK_OVERLAP,
  maxContextChunks: env.RAG_MAX_CONTEXT_CHUNKS,
  minSimilarity: env.RAG_MIN_SIMILARITY,
  conversationHistoryLimit: env.RAG_CONVERSATION_HISTORY_LIMIT,
  embeddingBatchSize: env.RAG_EMBEDDING_BATCH_SIZE,
  maxExtractedChars: env.RAG_MAX_EXTRACTED_CHARS,
  maxChunksPerDoc: env.RAG_MAX_CHUNKS_PER_DOC,
},
```

- [ ] **Step 2: Install new dependencies**

```bash
cd api && npm install openai @anthropic-ai/sdk pdf-parse mammoth pgvector multer && npm install -D @types/multer @types/pdf-parse
```

- [ ] **Step 3: Commit**

```bash
git add api/src/config/environment.ts api/package.json api/package-lock.json
git commit -m "feat: add RAG env vars and LLM/document dependencies"
```

---

### Task 5: Embedding Service

**Files:**
- Create: `api/src/knowledge/embedding.service.ts`

- [ ] **Step 1: Create embedding service**

Create `api/src/knowledge/embedding.service.ts`:

```typescript
import OpenAI from 'openai';
import { config } from '../config/environment';
import { logger } from '../utils/logger';

const EMBEDDING_MODEL = 'text-embedding-3-small';
const MAX_INPUT_CHARS = 32000; // ~8191 tokens × 4 chars/token

let openaiClient: OpenAI | null = null;

function getClient(): OpenAI {
  if (!openaiClient) {
    if (!config.rag.openaiApiKey) {
      throw new Error('OPENAI_API_KEY is required for embeddings');
    }
    openaiClient = new OpenAI({ apiKey: config.rag.openaiApiKey });
  }
  return openaiClient;
}

export async function embed(text: string): Promise<number[]> {
  const truncated = text.slice(0, MAX_INPUT_CHARS);
  const client = getClient();
  const response = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    input: truncated,
  });
  return response.data[0].embedding;
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  const client = getClient();
  const batchSize = config.rag.embeddingBatchSize;
  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize).map((t) => t.slice(0, MAX_INPUT_CHARS));
    const response = await client.embeddings.create({
      model: EMBEDDING_MODEL,
      input: batch,
    });
    for (const item of response.data) {
      results.push(item.embedding);
    }
    logger.debug(`Embedded batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(texts.length / batchSize)}`);
  }

  return results;
}
```

- [ ] **Step 2: Commit**

```bash
git add api/src/knowledge/embedding.service.ts
git commit -m "feat: add OpenAI embedding service"
```

---

### Task 6: Chunking Service

**Files:**
- Create: `api/src/knowledge/chunking.service.ts`

- [ ] **Step 1: Create recursive character splitter**

Create `api/src/knowledge/chunking.service.ts`:

```typescript
export interface Chunk {
  content: string;
  charCount: number;
  chunkIndex: number;
  metadata: Record<string, any>;
}

const SEPARATORS = ['\n\n', '\n', '. ', '? ', '! ', '; ', ', ', ' ', ''];

export function chunkText(
  text: string,
  chunkSize: number,
  chunkOverlap: number
): Chunk[] {
  const rawChunks = recursiveSplit(text, chunkSize, chunkOverlap, SEPARATORS);
  return rawChunks.map((content, index) => ({
    content,
    charCount: content.length,
    chunkIndex: index,
    metadata: {},
  }));
}

function recursiveSplit(
  text: string,
  chunkSize: number,
  chunkOverlap: number,
  separators: string[]
): string[] {
  if (text.length <= chunkSize) {
    return text.trim() ? [text.trim()] : [];
  }

  const separator = separators.find((sep) =>
    sep === '' ? true : text.includes(sep)
  );
  if (separator === undefined) return [text.trim()];

  const parts = separator === '' ? [...text] : text.split(separator);
  const chunks: string[] = [];
  let current = '';

  for (const part of parts) {
    const candidate = current ? current + separator + part : part;
    if (candidate.length > chunkSize && current) {
      chunks.push(current.trim());
      // Overlap: keep the end of the previous chunk
      const overlapText = current.slice(-chunkOverlap);
      current = overlapText + separator + part;
    } else {
      current = candidate;
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  // Recursively split any chunks that are still too large
  const result: string[] = [];
  const remainingSeparators = separators.slice(separators.indexOf(separator!) + 1);
  for (const chunk of chunks) {
    if (chunk.length > chunkSize && remainingSeparators.length > 0) {
      result.push(...recursiveSplit(chunk, chunkSize, chunkOverlap, remainingSeparators));
    } else {
      result.push(chunk);
    }
  }

  return result.filter((c) => c.trim().length > 0);
}
```

- [ ] **Step 2: Commit**

```bash
git add api/src/knowledge/chunking.service.ts
git commit -m "feat: add recursive character chunking service"
```

---

### Task 7: Document Extractors

**Files:**
- Create: `api/src/knowledge/document-extractors/text.extractor.ts`
- Create: `api/src/knowledge/document-extractors/pdf.extractor.ts`
- Create: `api/src/knowledge/document-extractors/docx.extractor.ts`

- [ ] **Step 1: Create text extractor (passthrough)**

Create `api/src/knowledge/document-extractors/text.extractor.ts`:

```typescript
export function extractText(sourceContent: string): string {
  return sourceContent;
}
```

- [ ] **Step 2: Create PDF extractor**

Create `api/src/knowledge/document-extractors/pdf.extractor.ts`:

```typescript
import pdfParse from 'pdf-parse';

export async function extractPdf(buffer: Buffer): Promise<string> {
  const result = await pdfParse(buffer);
  return result.text;
}
```

- [ ] **Step 3: Create DOCX extractor**

Create `api/src/knowledge/document-extractors/docx.extractor.ts`:

```typescript
import mammoth from 'mammoth';

export async function extractDocx(buffer: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}
```

- [ ] **Step 4: Commit**

```bash
git add api/src/knowledge/document-extractors/
git commit -m "feat: add PDF, DOCX, and text extractors"
```

---

### Task 8: LLM Provider Abstraction

**Files:**
- Create: `api/src/llm/llm.types.ts`
- Create: `api/src/llm/openai.provider.ts`
- Create: `api/src/llm/anthropic.provider.ts`
- Create: `api/src/llm/provider-factory.ts`

- [ ] **Step 1: Define LLM types**

Create `api/src/llm/llm.types.ts`:

```typescript
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMOptions {
  model: string;
  maxTokens: number;
  temperature: number;
  jsonMode: boolean;
}

export interface LLMResponse {
  content: string;
  usage: { promptTokens: number; completionTokens: number };
}

export interface LLMProvider {
  chat(messages: ChatMessage[], options: LLMOptions): Promise<LLMResponse>;
}
```

- [ ] **Step 2: Create OpenAI provider**

Create `api/src/llm/openai.provider.ts`:

```typescript
import OpenAI from 'openai';
import { LLMProvider, ChatMessage, LLMOptions, LLMResponse } from './llm.types';

export class OpenAIProvider implements LLMProvider {
  private client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey, timeout: 30000 });
  }

  async chat(messages: ChatMessage[], options: LLMOptions): Promise<LLMResponse> {
    const response = await this.client.chat.completions.create({
      model: options.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      max_tokens: options.maxTokens,
      temperature: options.temperature,
      response_format: options.jsonMode ? { type: 'json_object' } : undefined,
    });

    const choice = response.choices[0];
    return {
      content: choice.message.content || '',
      usage: {
        promptTokens: response.usage?.prompt_tokens || 0,
        completionTokens: response.usage?.completion_tokens || 0,
      },
    };
  }
}
```

- [ ] **Step 3: Create Anthropic provider**

Create `api/src/llm/anthropic.provider.ts`:

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { LLMProvider, ChatMessage, LLMOptions, LLMResponse } from './llm.types';

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey, timeout: 30000 });
  }

  async chat(messages: ChatMessage[], options: LLMOptions): Promise<LLMResponse> {
    const systemMessage = messages.find((m) => m.role === 'system');
    const nonSystemMessages = messages.filter((m) => m.role !== 'system');

    // For JSON mode, prefill with '{' to guide structured output
    const anthropicMessages = nonSystemMessages.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));
    if (options.jsonMode) {
      anthropicMessages.push({ role: 'assistant', content: '{' });
    }

    const response = await this.client.messages.create({
      model: options.model,
      max_tokens: options.maxTokens,
      temperature: options.temperature,
      system: systemMessage?.content || '',
      messages: anthropicMessages,
    });

    let content = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    // Prepend '{' back since we used it as prefill
    if (options.jsonMode) {
      content = '{' + content;
    }

    return {
      content,
      usage: {
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
      },
    };
  }
}
```

- [ ] **Step 4: Create provider factory**

Create `api/src/llm/provider-factory.ts`:

```typescript
import { LLMProvider } from './llm.types';
import { OpenAIProvider } from './openai.provider';
import { AnthropicProvider } from './anthropic.provider';
import { config } from '../config/environment';
import { decrypt } from '../utils/encryption';

const providerCache = new Map<string, LLMProvider>();

export function getProvider(
  provider: 'openai' | 'anthropic',
  encryptedApiKey?: string
): LLMProvider {
  let apiKey: string;

  if (encryptedApiKey) {
    apiKey = decrypt(encryptedApiKey);
  } else if (provider === 'openai') {
    if (!config.rag.openaiApiKey) throw new Error('OPENAI_API_KEY not configured');
    apiKey = config.rag.openaiApiKey;
  } else {
    if (!config.rag.anthropicApiKey) throw new Error('ANTHROPIC_API_KEY not configured');
    apiKey = config.rag.anthropicApiKey;
  }

  const cacheKey = `${provider}:${apiKey.slice(-8)}`;
  let cached = providerCache.get(cacheKey);
  if (cached) return cached;

  cached = provider === 'openai'
    ? new OpenAIProvider(apiKey)
    : new AnthropicProvider(apiKey);

  providerCache.set(cacheKey, cached);
  return cached;
}
```

- [ ] **Step 5: Commit**

```bash
git add api/src/llm/
git commit -m "feat: add LLM provider abstraction with OpenAI and Anthropic"
```

---

### Task 9: Knowledge Service (CRUD + Upload Tokens)

**Files:**
- Create: `api/src/knowledge/knowledge.service.ts`

- [ ] **Step 1: Create knowledge service**

Create `api/src/knowledge/knowledge.service.ts`:

```typescript
import crypto from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { KnowledgeBase } from '../database/entities/KnowledgeBase';
import { KnowledgeDocument, DocumentType } from '../database/entities/KnowledgeDocument';
import { KnowledgeChunk } from '../database/entities/KnowledgeChunk';
import { logger } from '../utils/logger';

// In-memory upload token store (replace with Redis if needed)
const uploadTokens = new Map<string, { tenantId: string; storagePath: string; expiresAt: Date }>();

export class KnowledgeService {
  private kbRepo: Repository<KnowledgeBase>;
  private docRepo: Repository<KnowledgeDocument>;
  private chunkRepo: Repository<KnowledgeChunk>;
  private dataSource: DataSource;

  constructor(dataSource: DataSource) {
    this.dataSource = dataSource;
    this.kbRepo = dataSource.getRepository(KnowledgeBase);
    this.docRepo = dataSource.getRepository(KnowledgeDocument);
    this.chunkRepo = dataSource.getRepository(KnowledgeChunk);
  }

  // --- Knowledge Base ---

  async getOrCreateKnowledgeBase(tenantId: string): Promise<KnowledgeBase> {
    let kb = await this.kbRepo.findOne({ where: { tenantId } });
    if (!kb) {
      kb = this.kbRepo.create({ tenantId, status: 'inactive' });
      kb = await this.kbRepo.save(kb);
    }
    return kb;
  }

  async updateKnowledgeBase(
    tenantId: string,
    updates: Partial<Pick<KnowledgeBase, 'chunkSize' | 'chunkOverlap' | 'status'>>
  ): Promise<KnowledgeBase> {
    const kb = await this.getOrCreateKnowledgeBase(tenantId);
    const configChanged =
      (updates.chunkSize !== undefined && updates.chunkSize !== kb.chunkSize) ||
      (updates.chunkOverlap !== undefined && updates.chunkOverlap !== kb.chunkOverlap);

    Object.assign(kb, updates);
    const saved = await this.kbRepo.save(kb);

    if (configChanged) {
      await this.reprocessAllDocuments(tenantId, kb.id);
    }

    return saved;
  }

  // --- Documents ---

  async listDocuments(
    tenantId: string,
    filters?: { status?: string; type?: string; page?: number; limit?: number }
  ) {
    const kb = await this.getOrCreateKnowledgeBase(tenantId);
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
    }
  ): Promise<KnowledgeDocument> {
    const kb = await this.getOrCreateKnowledgeBase(tenantId);

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
    return this.docRepo.findOne({
      where: { id: documentId, tenantId },
    });
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
    return this.docRepo.save(doc);
  }

  async deleteDocument(tenantId: string, documentId: string): Promise<void> {
    const doc = await this.docRepo.findOneOrFail({ where: { id: documentId, tenantId } });
    // Chunks cascade-deleted by FK
    await this.docRepo.remove(doc);
    // TODO: Delete S3 object if doc.storagePath is set
  }

  async retryDocument(tenantId: string, documentId: string): Promise<KnowledgeDocument> {
    const doc = await this.docRepo.findOneOrFail({ where: { id: documentId, tenantId } });
    if (doc.status !== 'failed') throw new Error('Only failed documents can be retried');
    doc.processingVersion += 1;
    doc.status = 'pending';
    doc.errorMessage = null;
    return this.docRepo.save(doc);
  }

  // --- Upload Tokens ---

  registerUploadToken(tenantId: string, storagePath: string): string {
    const token = crypto.randomUUID();
    uploadTokens.set(token, {
      tenantId,
      storagePath,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1 hour
    });
    return token;
  }

  // --- Stats ---

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

  // --- Helpers ---

  private async reprocessAllDocuments(tenantId: string, kbId: string): Promise<void> {
    const docs = await this.docRepo.find({
      where: { knowledgeBaseId: kbId, tenantId },
    });
    for (const doc of docs) {
      doc.processingVersion += 1;
      doc.status = 'pending';
    }
    await this.docRepo.save(docs);
    logger.info(`Reprocessing ${docs.length} documents for tenant ${tenantId}`);
    // Jobs will be queued by the controller after calling this
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add api/src/knowledge/knowledge.service.ts
git commit -m "feat: add knowledge service with CRUD and upload tokens"
```

---

### Task 10: Ingestion Worker

**Files:**
- Create: `api/src/knowledge/ingestion.worker.ts`

- [ ] **Step 1: Create ingestion worker**

Create `api/src/knowledge/ingestion.worker.ts`:

```typescript
import { DataSource } from 'typeorm';
import { KnowledgeDocument } from '../database/entities/KnowledgeDocument';
import { KnowledgeBase } from '../database/entities/KnowledgeBase';
import { extractText } from './document-extractors/text.extractor';
import { extractPdf } from './document-extractors/pdf.extractor';
import { extractDocx } from './document-extractors/docx.extractor';
import { chunkText } from './chunking.service';
import { embedBatch } from './embedding.service';
import { config } from '../config/environment';
import { logger } from '../utils/logger';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

interface IngestionJobData {
  documentId: string;
  tenantId: string;
  processingVersion: number;
}

export function createIngestionProcessor(dataSource: DataSource, s3Client: S3Client | null) {
  const docRepo = dataSource.getRepository(KnowledgeDocument);
  const kbRepo = dataSource.getRepository(KnowledgeBase);

  return async (job: { data: IngestionJobData }) => {
    const { documentId, tenantId, processingVersion } = job.data;
    logger.info(`Processing document ${documentId} v${processingVersion}`);

    // Step 0: Version check
    const doc = await docRepo.findOne({ where: { id: documentId, tenantId } });
    if (!doc || doc.processingVersion !== processingVersion) {
      logger.info(`Stale job for document ${documentId}, discarding`);
      return;
    }

    try {
      // Step 1: Set processing
      doc.status = 'processing';
      await docRepo.save(doc);

      // Step 2: Extract text
      let text: string;
      if (doc.type === 'text' || doc.type === 'faq') {
        text = extractText(doc.sourceContent || '');
      } else if (doc.storagePath) {
        if (!s3Client || !config.s3?.bucket) {
          throw new Error('S3 is not configured but document requires file download');
        }
        const command = new GetObjectCommand({
          Bucket: config.s3.bucket,
          Key: doc.storagePath,
        });
        const response = await s3Client.send(command);
        const buffer = Buffer.from(await response.Body!.transformToByteArray());

        if (doc.type === 'pdf') {
          text = await extractPdf(buffer);
        } else {
          text = await extractDocx(buffer);
        }
      } else {
        throw new Error(`No content available for document type ${doc.type}`);
      }

      if (!text.trim()) {
        throw new Error('No text content found');
      }

      // Truncate if too large
      if (text.length > config.rag.maxExtractedChars) {
        text = text.slice(0, config.rag.maxExtractedChars);
        logger.warn(`Document ${documentId} text truncated to ${config.rag.maxExtractedChars} chars`);
      }

      // Step 3: Chunk
      const kb = await kbRepo.findOneOrFail({ where: { tenantId } });
      let chunks = chunkText(text, kb.chunkSize, kb.chunkOverlap);

      // Cap chunks
      if (chunks.length > config.rag.maxChunksPerDoc) {
        logger.warn(`Document ${documentId} capped at ${config.rag.maxChunksPerDoc} chunks (had ${chunks.length})`);
        chunks = chunks.slice(0, config.rag.maxChunksPerDoc);
      }

      // Step 4: Embed
      const embeddings = await embedBatch(chunks.map((c) => c.content));

      // Step 5: Pre-write version check
      const freshDoc = await docRepo.findOne({ where: { id: documentId, tenantId } });
      if (!freshDoc || freshDoc.processingVersion !== processingVersion) {
        logger.info(`Document ${documentId} version changed during embedding, discarding`);
        return;
      }

      // Step 6: Atomic chunk swap in transaction
      await dataSource.transaction(async (manager) => {
        // Delete old chunks
        await manager.query(`DELETE FROM knowledge_chunks WHERE "documentId" = $1`, [documentId]);

        // Bulk insert new chunks
        for (let i = 0; i < chunks.length; i++) {
          await manager.query(
            `INSERT INTO knowledge_chunks (id, "documentId", "tenantId", content, embedding, "chunkIndex", "charCount", metadata, "createdAt")
             VALUES (gen_random_uuid(), $1, $2, $3, $4::vector, $5, $6, $7, NOW())`,
            [
              documentId,
              tenantId,
              chunks[i].content,
              `[${embeddings[i].join(',')}]`,
              chunks[i].chunkIndex,
              chunks[i].charCount,
              JSON.stringify(chunks[i].metadata),
            ]
          );
        }
      });

      // Step 7: Update document
      doc.status = 'indexed';
      doc.chunkCount = chunks.length;
      doc.errorMessage = null;
      await docRepo.save(doc);

      // Step 8: Update KB
      kb.lastIndexedAt = new Date();
      await kbRepo.save(kb);

      logger.info(`Document ${documentId} indexed: ${chunks.length} chunks`);
    } catch (error: any) {
      logger.error(`Failed to process document ${documentId}:`, error);
      doc.status = 'failed';
      doc.errorMessage = error.message || 'Unknown error';
      await docRepo.save(doc);
      throw error; // Let Bull handle retry
    }
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add api/src/knowledge/ingestion.worker.ts
git commit -m "feat: add document ingestion worker with extract/chunk/embed pipeline"
```

---

### Task 11: RAG Service

**Files:**
- Create: `api/src/llm/rag.service.ts`

- [ ] **Step 1: Create RAG orchestration service**

Create `api/src/llm/rag.service.ts`:

```typescript
import { DataSource } from 'typeorm';
import { embed } from '../knowledge/embedding.service';
import { getProvider } from './provider-factory';
import { ChatMessage } from './llm.types';
import { config } from '../config/environment';
import { logger } from '../utils/logger';

interface TenantAiSettings {
  provider: 'openai' | 'anthropic';
  model: string;
  apiKey?: string;
  brandVoice: {
    name: string;
    tone: string;
    customInstructions: string;
  };
  guardrails: {
    topicsToAvoid: string[];
    confidenceThreshold: number;
    maxResponseLength: number;
    fallbackMessage: string;
  };
}

interface RetrievedChunk {
  id: string;
  content: string;
  title: string;
  similarity: number;
  metadata: Record<string, any>;
}

export interface RagResult {
  response: string;
  confidence: number;
  shouldHandoff: boolean;
  handoffReason?: string;
  chunks: RetrievedChunk[];
}

export async function generateResponse(
  dataSource: DataSource,
  tenantId: string,
  aiSettings: TenantAiSettings,
  customerMessage: string,
  conversationHistory: { role: 'user' | 'assistant'; content: string }[]
): Promise<RagResult> {
  // Step 1: Embed the customer message
  const queryEmbedding = await embed(customerMessage);
  const embeddingStr = `[${queryEmbedding.join(',')}]`;

  // Step 2: Vector similarity search
  const chunks: RetrievedChunk[] = await dataSource.query(
    `SELECT kc.id, kc.content, kc.metadata, kd.title,
            1 - (kc.embedding <=> $1::vector) AS similarity
     FROM knowledge_chunks kc
     JOIN knowledge_documents kd ON kd.id = kc."documentId"
     WHERE kc."tenantId" = $2
       AND kd.status = 'indexed'
       AND 1 - (kc.embedding <=> $1::vector) >= $3
     ORDER BY kc.embedding <=> $1::vector
     LIMIT $4`,
    [embeddingStr, tenantId, config.rag.minSimilarity, config.rag.maxContextChunks]
  );

  // Step 3: Check if we have relevant chunks
  if (chunks.length === 0) {
    return {
      response: aiSettings.guardrails.fallbackMessage,
      confidence: 0,
      shouldHandoff: true,
      handoffReason: 'bot_no_knowledge',
      chunks: [],
    };
  }

  // Step 4: Build the LLM prompt
  const knowledgeContext = chunks
    .map((c) => `[Source: ${c.title}] ${c.content}`)
    .join('\n\n');

  const historyText = conversationHistory
    .slice(-config.rag.conversationHistoryLimit)
    .map((m) => `${m.role === 'user' ? 'Customer' : 'Assistant'}: ${m.content}`)
    .join('\n');

  const systemPrompt = `You are ${aiSettings.brandVoice.name}.
Tone: ${aiSettings.brandVoice.tone}
${aiSettings.brandVoice.customInstructions}

Rules:
- Only answer using the provided knowledge context
- Never discuss: ${aiSettings.guardrails.topicsToAvoid.join(', ') || 'N/A'}
- Max response: ${aiSettings.guardrails.maxResponseLength} characters
- If unsure, say so honestly

You MUST respond in this exact JSON format:
{ "response": "your answer here", "confidence": 0.85 }
where confidence is 0.0-1.0

KNOWLEDGE CONTEXT:
${knowledgeContext}`;

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
  ];

  if (historyText) {
    messages.push({ role: 'user', content: `Previous conversation:\n${historyText}` });
    messages.push({ role: 'assistant', content: 'Understood, I have the conversation context.' });
  }

  messages.push({ role: 'user', content: customerMessage });

  // Step 5: Call LLM
  const provider = getProvider(aiSettings.provider, aiSettings.apiKey);
  const llmResponse = await provider.chat(messages, {
    model: aiSettings.model,
    maxTokens: 1000,
    temperature: 0.3,
    jsonMode: true,
  });

  // Step 6: Parse structured response
  let response: string;
  let confidence: number;

  try {
    const parsed = JSON.parse(llmResponse.content);
    response = parsed.response || '';
    confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0;
  } catch {
    logger.warn('Failed to parse LLM JSON response, treating as low confidence');
    response = llmResponse.content;
    confidence = 0;
  }

  // Step 7: Evaluate confidence
  const shouldHandoff = confidence < aiSettings.guardrails.confidenceThreshold;

  return {
    response: shouldHandoff ? aiSettings.guardrails.fallbackMessage : response,
    confidence,
    shouldHandoff,
    handoffReason: shouldHandoff ? 'bot_confidence_low' : undefined,
    chunks,
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add api/src/llm/rag.service.ts
git commit -m "feat: add RAG service with vector search, prompt assembly, and confidence evaluation"
```

---

### Task 12: Zod Schemas

**Files:**
- Create: `api/src/schemas/knowledge.schema.ts`
- Create: `api/src/schemas/ai-settings.schema.ts`

- [ ] **Step 1: Create knowledge schemas**

Create `api/src/schemas/knowledge.schema.ts`:

```typescript
import { z } from 'zod';

export const updateKnowledgeBaseSchema = z.object({
  chunkSize: z.number().min(100).max(5000).optional(),
  chunkOverlap: z.number().min(0).max(1000).optional(),
  status: z.enum(['active', 'inactive']).optional(),
});

export const createDocumentSchema = z.object({
  type: z.enum(['text', 'faq', 'pdf', 'docx']),
  title: z.string().min(1).max(255),
  sourceContent: z.string().max(500000).optional(),
  uploadToken: z.string().uuid().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const updateDocumentSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  sourceContent: z.string().max(500000).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const listDocumentsSchema = z.object({
  status: z.enum(['pending', 'processing', 'indexed', 'failed']).optional(),
  type: z.enum(['text', 'faq', 'pdf', 'docx']).optional(),
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
});
```

- [ ] **Step 2: Create AI settings schemas**

Create `api/src/schemas/ai-settings.schema.ts`:

```typescript
import { z } from 'zod';

export const updateAiSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  provider: z.enum(['openai', 'anthropic']).optional(),
  model: z.string().min(1).optional(),
  apiKey: z.string().min(1).optional().nullable(),
  brandVoice: z.object({
    name: z.string().min(1).max(100),
    tone: z.enum(['formal', 'casual', 'friendly', 'professional']),
    customInstructions: z.string().max(2000),
  }).optional(),
  guardrails: z.object({
    topicsToAvoid: z.array(z.string()).max(50),
    escalationKeywords: z.array(z.string()).max(100),
    confidenceThreshold: z.number().min(0).max(1),
    maxResponseLength: z.number().min(50).max(5000),
    greetingMessage: z.string().max(1000),
    fallbackMessage: z.string().max(1000),
    offHoursMessage: z.string().max(1000),
  }).optional(),
});

export const testAiSettingsSchema = z.object({
  question: z.string().min(1).max(1000),
});
```

- [ ] **Step 3: Commit**

```bash
git add api/src/schemas/knowledge.schema.ts api/src/schemas/ai-settings.schema.ts
git commit -m "feat: add Zod schemas for knowledge and AI settings"
```

---

### Task 13: Knowledge Routes & Controller

**Files:**
- Create: `api/src/knowledge/knowledge.routes.ts`
- Create: `api/src/knowledge/knowledge.controller.ts`
- Modify: `api/src/server.ts` (line 127-142, register routes)

- [ ] **Step 1: Create knowledge controller**

Create `api/src/knowledge/knowledge.controller.ts`:

```typescript
import crypto from 'crypto';
import { Request, Response } from 'express';
import { KnowledgeService } from './knowledge.service';
import { AppDataSource } from '../database/data-source';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { config } from '../config/environment';
import { encrypt } from '../utils/encryption';
import { logger } from '../utils/logger';
import { generateResponse } from '../llm/rag.service';
import { embed } from './embedding.service';
import {
  updateKnowledgeBaseSchema,
  createDocumentSchema,
  updateDocumentSchema,
  listDocumentsSchema,
} from '../schemas/knowledge.schema';
import { updateAiSettingsSchema, testAiSettingsSchema } from '../schemas/ai-settings.schema';

let knowledgeService: KnowledgeService;

function getService(): KnowledgeService {
  if (!knowledgeService) {
    knowledgeService = new KnowledgeService(AppDataSource);
  }
  return knowledgeService;
}

// --- Knowledge Base ---

export async function getKnowledgeBase(req: Request, res: Response) {
  const tenantId = (req as any).tenantId;
  const kb = await getService().getOrCreateKnowledgeBase(tenantId);
  res.json(kb);
}

export async function updateKnowledgeBase(req: Request, res: Response) {
  const tenantId = (req as any).tenantId;
  const data = updateKnowledgeBaseSchema.parse(req.body);

  const configChanged =
    data.chunkSize !== undefined || data.chunkOverlap !== undefined;

  const kb = await getService().updateKnowledgeBase(tenantId, data);

  // If config changed, reprocessAllDocuments set docs to pending — now queue them
  if (configChanged) {
    const { documents } = await getService().listDocuments(tenantId, { status: 'pending', limit: 1000 });
    for (const doc of documents) {
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

// --- Documents ---

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

  // Queue ingestion job
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
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  res.json(doc);
}

export async function updateDocument(req: Request, res: Response) {
  const tenantId = (req as any).tenantId;
  const data = updateDocumentSchema.parse(req.body);
  const doc = await getService().updateDocument(tenantId, req.params.id, data);

  // Queue re-processing
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
  if (!file) return res.status(400).json({ error: 'No file provided' });

  if (!config.s3?.bucket) {
    return res.status(503).json({ error: 'File storage is not configured' });
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

// --- Stats ---

export async function getStats(req: Request, res: Response) {
  const tenantId = (req as any).tenantId;
  const stats = await getService().getStats(tenantId);
  res.json(stats);
}

// --- AI Settings ---

export async function getAiSettings(req: Request, res: Response) {
  const tenantId = (req as any).tenantId;
  const tenant = await AppDataSource.getRepository('Tenant').findOneOrFail({ where: { id: tenantId } });
  const ai = (tenant as any).settings?.ai || null;

  if (ai) {
    // Never return apiKey, return hasApiKey flag instead
    const { apiKey, ...rest } = ai;
    res.json({ ...rest, hasApiKey: !!apiKey });
  } else {
    res.json(null);
  }
}

export async function updateAiSettings(req: Request, res: Response) {
  const tenantId = (req as any).tenantId;
  const data = updateAiSettingsSchema.parse(req.body);
  const tenantRepo = AppDataSource.getRepository('Tenant');
  const tenant = await tenantRepo.findOneOrFail({ where: { id: tenantId } }) as any;

  const existingAi = tenant.settings?.ai || {};
  const updatedAi = { ...existingAi };

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
  const tenantRepo = AppDataSource.getRepository('Tenant');
  const tenant = await tenantRepo.findOneOrFail({ where: { id: tenantId } }) as any;

  const ai = tenant.settings?.ai;
  if (!ai?.enabled) return res.status(400).json({ error: 'AI is not enabled' });

  const result = await generateResponse(AppDataSource, tenantId, ai, question, []);
  res.json({
    response: result.response,
    confidence: result.confidence,
    chunks: result.chunks,
    provider: ai.provider,
    model: ai.model,
  });
}
```

- [ ] **Step 2: Create knowledge routes**

Create `api/src/knowledge/knowledge.routes.ts`:

```typescript
import { Router } from 'express';
import multer from 'multer';
import * as ctrl from './knowledge.controller';
import { requireClerkAuth } from '../middleware/auth.middleware';
import { autoProvision } from '../middleware/auto-provision.middleware';
import { validateTenant } from '../middleware/tenant.middleware';
import { asyncHandler } from '../middleware/error-handler';

const router = Router();

// All knowledge routes require auth + tenant context
router.use(requireClerkAuth, autoProvision, validateTenant);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    cb(null, allowed.includes(file.mimetype));
  },
});

// Knowledge Base
router.get('/base', asyncHandler(ctrl.getKnowledgeBase));
router.patch('/base', asyncHandler(ctrl.updateKnowledgeBase));

// Documents
router.post('/documents/upload', upload.single('file'), asyncHandler(ctrl.uploadFile));
router.get('/documents', asyncHandler(ctrl.listDocuments));
router.post('/documents', asyncHandler(ctrl.createDocument));
router.get('/documents/:id', asyncHandler(ctrl.getDocument));
router.put('/documents/:id', asyncHandler(ctrl.updateDocument));
router.delete('/documents/:id', asyncHandler(ctrl.deleteDocument));
router.post('/documents/:id/retry', asyncHandler(ctrl.retryDocument));

// Stats
router.get('/stats', asyncHandler(ctrl.getStats));

export default router;
```

**Note:** Check the actual middleware export names by reading the middleware files — the names above (`requireClerkAuth`, `autoProvision`, `validateTenant`, `asyncHandler`) should match the existing exports. Adjust imports if they differ.

- [ ] **Step 3: Create AI settings routes (extend tenants)**

Create `api/src/knowledge/ai-settings.routes.ts`:

```typescript
import { Router } from 'express';
import * as ctrl from './knowledge.controller';
import { requireClerkAuth } from '../middleware/auth.middleware';
import { autoProvision } from '../middleware/auto-provision.middleware';
import { validateTenant } from '../middleware/tenant.middleware';
import { asyncHandler } from '../middleware/error-handler';

const router = Router();

router.use(requireClerkAuth, autoProvision, validateTenant);

router.get('/ai-settings', asyncHandler(ctrl.getAiSettings));
router.patch('/ai-settings', asyncHandler(ctrl.updateAiSettings));
router.post('/ai-settings/test', asyncHandler(ctrl.testAiSettings));

export default router;
```

- [ ] **Step 4: Register routes in server.ts**

In `api/src/server.ts`, add imports and register routes (around line 127-142):

```typescript
// Add imports:
import knowledgeRoutes from './knowledge/knowledge.routes';
import aiSettingsRoutes from './knowledge/ai-settings.routes';

// Add to apiRouter (after fileRoutes):
apiRouter.use('/knowledge', knowledgeRoutes);
apiRouter.use('/tenants/me', aiSettingsRoutes);
```

- [ ] **Step 5: Commit**

```bash
git add api/src/knowledge/knowledge.controller.ts api/src/knowledge/knowledge.routes.ts api/src/knowledge/ai-settings.routes.ts api/src/server.ts
git commit -m "feat: add knowledge and AI settings API routes"
```

---

### Task 14: Queue Integration

**Files:**
- Modify: `api/src/queue/message-queue.ts` (add knowledge queue)
- Modify: `api/src/server.ts` (register ingestion processor)

- [ ] **Step 1: Add knowledge queue to message-queue.ts**

In `api/src/queue/message-queue.ts`:

1. Add variable after line 16:
```typescript
let knowledgeQueue: Queue | null = null;
```

2. In `initializeQueues()`, add after the dead-letter queue initialization, using the same `createQueueOptions()` pattern used by other queues:
```typescript
knowledgeQueue = new Bull('knowledge-processing', createQueueOptions());
```

3. Add the new queue to the shared event-handler array and shutdown/cleanup array (look for where other queues are pushed into arrays for graceful shutdown).

4. In the `registerProcessor()` switch statement, add a case:
```typescript
case 'knowledge-processing':
  queue = knowledgeQueue;
  break;
```

5. In `getQueue()`, add a case:
```typescript
case 'knowledge-processing':
  return knowledgeQueue;
```

6. Add a public `addJob` export (or use existing pattern):
```typescript
export async function addJob(
  queueName: string,
  data: any,
  options?: { jobId?: string }
): Promise<void> {
  const queue = getQueue(queueName);
  if (!queue) throw new Error(`Queue ${queueName} not available`);
  await queue.add(data, {
    jobId: options?.jobId,
    attempts: config.queue.maxAttempts,
    backoff: { type: 'exponential', delay: config.queue.backoffDelay },
  });
}
```

**Important:** Read `message-queue.ts` carefully before editing. Match the exact `createQueueOptions()` call pattern and add the new queue to all relevant arrays (event handlers, shutdown cleanup).

- [ ] **Step 2: Register ingestion processor in server.ts**

In `api/src/server.ts`, after the queue initialization block (around line 178), add:

```typescript
// Register knowledge ingestion processor
try {
  const { registerProcessor } = await import('./queue/message-queue');
  const { createIngestionProcessor } = await import('./knowledge/ingestion.worker');
  const s3Client = config.s3?.bucket
    ? new (await import('@aws-sdk/client-s3')).S3Client({ region: config.s3.region })
    : null;
  registerProcessor('knowledge-processing', createIngestionProcessor(AppDataSource, s3Client));
  logger.info('Knowledge ingestion processor registered');
} catch (err) {
  logger.warn('Knowledge ingestion processor registration failed', { error: err });
}
```

- [ ] **Step 3: Commit**

```bash
git add api/src/queue/message-queue.ts api/src/server.ts
git commit -m "feat: add knowledge-processing queue and ingestion processor"
```

---

### Task 15: Chat Integration (Message Forwarding, Session Creation, Handoff Return)

**Files:**
- Modify: `api/src/services/message-forwarding.service.ts` (line 72-75, RAG hook)
- Modify: `api/src/routes/widget.ts` (session creation, bot status)
- Modify: `api/src/routes/handsoff.routes.ts` (line 273-276, return to bot)
- Create: `api/src/database/migrations/1775300000000-AddBotHandoffReasons.ts`

- [ ] **Step 1: Add new handoff reason values migration**

Create `api/src/database/migrations/1775300000000-AddBotHandoffReasons.ts`:

```typescript
import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddBotHandoffReasons1775300000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Alter the enum to add new bot-specific reason values
    await queryRunner.query(`
      ALTER TYPE handoff_requests_reason_enum RENAME TO handoff_requests_reason_enum_old
    `);
    await queryRunner.query(`
      CREATE TYPE handoff_requests_reason_enum AS ENUM (
        'user_request', 'bot_confidence_low', 'escalation_trigger', 'business_hours',
        'bot_escalation_keyword', 'bot_no_knowledge', 'bot_error'
      )
    `);
    await queryRunner.query(`
      ALTER TABLE handoff_requests
      ALTER COLUMN reason TYPE handoff_requests_reason_enum
      USING reason::text::handoff_requests_reason_enum
    `);
    await queryRunner.query(`DROP TYPE handoff_requests_reason_enum_old`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TYPE handoff_requests_reason_enum RENAME TO handoff_requests_reason_enum_new
    `);
    await queryRunner.query(`
      CREATE TYPE handoff_requests_reason_enum AS ENUM (
        'user_request', 'bot_confidence_low', 'escalation_trigger', 'business_hours'
      )
    `);
    await queryRunner.query(`
      ALTER TABLE handoff_requests
      ALTER COLUMN reason TYPE handoff_requests_reason_enum
      USING reason::text::handoff_requests_reason_enum
    `);
    await queryRunner.query(`DROP TYPE handoff_requests_reason_enum_new`);
  }
}
```

- [ ] **Step 2: Update HandoffRequest entity**

In `api/src/database/entities/HandoffRequest.ts`, update the reason type and enum:

```typescript
export type HandoffReason =
  | 'user_request'
  | 'bot_confidence_low'
  | 'escalation_trigger'
  | 'business_hours'
  | 'bot_escalation_keyword'
  | 'bot_no_knowledge'
  | 'bot_error';

// And update the @Column enum array to include the new values:
@Column({
  type: 'enum',
  enum: ['user_request', 'bot_confidence_low', 'escalation_trigger', 'business_hours', 'bot_escalation_keyword', 'bot_no_knowledge', 'bot_error'],
})
reason!: HandoffReason;
```

- [ ] **Step 3: Hook RAG into message-forwarding.service.ts**

In `api/src/services/message-forwarding.service.ts`, modify the function starting around line 72. Add RAG check before the existing n8n forwarding:

```typescript
// Add at top of file:
import { generateResponse } from '../llm/rag.service';
import { AppDataSource } from '../database/data-source';
import { Participant } from '../database/entities/Participant';
import { Message } from '../database/entities/Message';
import { ChatSession } from '../database/entities/ChatSession';
import { HandoffRequest } from '../database/entities/HandoffRequest';
import { Tenant } from '../database/entities/Tenant';

// Inside forwardMessageToN8n(), before the outbound payload construction (around line 90):
// Check if RAG should handle this message
const tenant = await AppDataSource.getRepository(Tenant).findOne({ where: { id: session.tenantId } });
const aiSettings = (tenant as any)?.settings?.ai;

if (session.status === 'bot' && aiSettings?.enabled && savedMessage.type === 'text') {
  try {
    // Check escalation keywords first
    const message = savedMessage.contentEncrypted
      ? decrypt(savedMessage.content)
      : savedMessage.content;
    const keywords = aiSettings.guardrails?.escalationKeywords || [];
    const hasEscalationKeyword = keywords.some((kw: string) =>
      message.toLowerCase().includes(kw.toLowerCase())
    );

    // Ensure bot participant exists before any handoff path
    const botParticipant = await ensureBotParticipant(session, aiSettings);

    if (hasEscalationKeyword) {
      // Immediate handoff — skip AI
      if ((tenant as any)?.settings?.features?.handoffEnabled !== false) {
        await handleBotHandoff(session, botParticipant.id, 'bot_escalation_keyword');
      }
      return true; // Match existing return type (Promise<boolean>)
    }

    // Generate RAG response
    const history = await getConversationHistory(session.id);
    const result = await generateResponse(
      AppDataSource,
      session.tenantId,
      aiSettings,
      message,
      history
    );

    // Send bot message with WebSocket emit
    await sendBotMessage(session, botParticipant.id, result.response);

    if (result.shouldHandoff && (tenant as any)?.settings?.features?.handoffEnabled !== false) {
      await handleBotHandoff(session, botParticipant.id, result.handoffReason || 'bot_confidence_low');
    }

    return true; // RAG handled it, don't forward to n8n
  } catch (error) {
    logger.error('RAG failed, falling back to handoff', { error });
    const botParticipant = await ensureBotParticipant(session, aiSettings);
    const fallback = aiSettings.guardrails?.fallbackMessage || 'Let me connect you with an agent.';
    await sendBotMessage(session, botParticipant.id, fallback);
    if ((tenant as any)?.settings?.features?.handoffEnabled !== false) {
      await handleBotHandoff(session, botParticipant.id, 'bot_error');
    }
    return true;
  }
}

// ... existing n8n forwarding code continues below
```

Add helper functions at the bottom of the file:

```typescript
async function ensureBotParticipant(session: any, aiSettings: any) {
  const participantRepo = AppDataSource.getRepository(Participant);
  let botParticipant = await participantRepo.findOne({
    where: { sessionId: session.id, type: 'bot' },
  });
  if (!botParticipant) {
    botParticipant = participantRepo.create({
      sessionId: session.id,
      type: 'bot',
      name: aiSettings?.brandVoice?.name || 'AI Assistant',
      joinedAt: new Date(),
    });
    botParticipant = await participantRepo.save(botParticipant);
  }
  return botParticipant;
}

async function getConversationHistory(sessionId: string) {
  // Join with Participant to determine message role
  const messages = await AppDataSource.getRepository(Message)
    .createQueryBuilder('msg')
    .leftJoinAndSelect('msg.participant', 'participant')
    .where('msg.sessionId = :sessionId', { sessionId })
    .orderBy('msg.createdAt', 'DESC')
    .take(10)
    .getMany();

  return messages.reverse().map((m: any) => ({
    role: (m.participant?.type === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
    content: m.contentEncrypted ? decrypt(m.content) : m.content,
  }));
}

async function sendBotMessage(session: any, botParticipantId: string, content: string) {
  const msgRepo = AppDataSource.getRepository(Message);
  const msg = msgRepo.create({
    sessionId: session.id,
    tenantId: session.tenantId,
    participantId: botParticipantId,
    type: 'text',
    content,
    status: 'sent',
  });
  const saved = await msgRepo.save(msg);

  // Emit via WebSocket — follow the same pattern as webhook.service.ts
  // Look for the existing `emitToSession` or `io.to(sessionId).emit(...)` pattern
  // in webhook.service.ts and replicate it here. Example:
  // io.to(`session:${session.id}`).emit('message:new', { message: saved });
  // The exact emit pattern must match what the codebase already uses.
  // READ webhook.service.ts lines ~110-120 for the exact emit call.
}

async function handleBotHandoff(session: any, botParticipantId: string, reason: string) {
  const sessionRepo = AppDataSource.getRepository(ChatSession);
  session.status = 'handoff';
  await sessionRepo.save(session);

  const hrRepo = AppDataSource.getRepository(HandoffRequest);
  const handoff = hrRepo.create({
    sessionId: session.id,
    tenantId: session.tenantId,
    requestedBy: botParticipantId, // guaranteed non-null
    reason,
    status: 'requested',
    priority: 'medium',
    context: { source: 'rag', reason },
  });
  await hrRepo.save(handoff);
}
```

**Important notes for implementation:**
- `return true` matches the existing `forwardMessageToN8n(): Promise<boolean>` return type
- `getConversationHistory` joins `Participant` table to determine role (Message entity has no `participantType` field)
- `sendBotMessage` MUST emit a WebSocket event — read `webhook.service.ts` for the exact `io.to()` pattern and replicate it
- `handleBotHandoff` takes `botParticipantId` as a required param to avoid null `requestedBy`
- `ensureBotParticipant` is called before any handoff path to guarantee the participant exists

- [ ] **Step 4: Modify session creation in widget.ts for bot status**

In `api/src/routes/widget.ts`, in the session creation handler (where status is set to `'waiting'`), add AI check:

```typescript
// Add import at top of widget.ts:
import { KnowledgeBase } from '../database/entities/KnowledgeBase';

// Before session creation, determine initial status:
const aiEnabled = tenant.settings?.ai?.enabled;
const kbRepo = AppDataSource.getRepository(KnowledgeBase);
const kb = aiEnabled ? await kbRepo.findOne({ where: { tenantId: tenant.id, status: 'active' } }) : null;
const initialStatus = (aiEnabled && kb) ? 'bot' : 'waiting';

// Use initialStatus when creating the session:
session.status = initialStatus;
```

And after session creation, send greeting if bot:

```typescript
if (initialStatus === 'bot' && tenant.settings?.ai?.guardrails?.greetingMessage) {
  // Create bot participant and send greeting
  const botParticipant = participantRepository.create({
    sessionId: session.id,
    type: 'bot',
    name: tenant.settings.ai.brandVoice?.name || 'AI Assistant',
    joinedAt: new Date(),
  });
  await participantRepository.save(botParticipant);

  const greetingMsg = messageRepository.create({
    sessionId: session.id,
    tenantId: tenant.id,
    participantId: botParticipant.id,
    type: 'text',
    content: tenant.settings.ai.guardrails.greetingMessage,
    status: 'sent',
  });
  await messageRepository.save(greetingMsg);
}
```

- [ ] **Step 5: Modify handoff return to use bot status when AI enabled**

In `api/src/routes/handsoff.routes.ts`, change line 273-276:

```typescript
// Add imports at top of handsoff.routes.ts:
import { KnowledgeBase } from '../database/entities/KnowledgeBase';
import { Tenant } from '../database/entities/Tenant';

// Replace the status assignment (around line 274):
// Old: session.status = 'waiting';
// New:
const tenantForAi = await AppDataSource.getRepository(Tenant).findOne({ where: { id: session.tenantId } });
const aiEnabled = (tenantForAi as any)?.settings?.ai?.enabled;
const kbRepo = AppDataSource.getRepository(KnowledgeBase);
const kb = aiEnabled ? await kbRepo.findOne({ where: { tenantId: session.tenantId, status: 'active' } }) : null;
session.status = (aiEnabled && kb) ? 'bot' : 'waiting';
```

- [ ] **Step 6: Run migration**

```bash
cd api && npx typeorm migration:run -d src/database/data-source.ts
```

- [ ] **Step 7: Commit**

```bash
git add api/src/services/message-forwarding.service.ts api/src/routes/widget.ts api/src/routes/handsoff.routes.ts api/src/database/entities/HandoffRequest.ts api/src/database/migrations/1775300000000-AddBotHandoffReasons.ts
git commit -m "feat: integrate RAG into chat flow with bot sessions and handoff"
```

---

### Task 16: Manual Verification

- [ ] **Step 1: Start the platform locally**

```bash
docker compose up -d && cd api && npm run dev
```

- [ ] **Step 2: Create a test tenant with AI settings**

Use the API to set up AI settings on a tenant:

```bash
# Set AI settings (replace TENANT_ID and auth token)
curl -X PATCH http://localhost:3000/api/v1/tenants/me/ai-settings \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TOKEN" \
  -d '{
    "enabled": true,
    "provider": "openai",
    "model": "gpt-4o-mini",
    "brandVoice": { "name": "TestBot", "tone": "friendly", "customInstructions": "" },
    "guardrails": {
      "topicsToAvoid": [],
      "escalationKeywords": ["speak to human"],
      "confidenceThreshold": 0.7,
      "maxResponseLength": 500,
      "greetingMessage": "Hello! How can I help?",
      "fallbackMessage": "Let me connect you with a human agent.",
      "offHoursMessage": "We are currently closed."
    }
  }'
```

- [ ] **Step 3: Upload a test document**

```bash
# Create a text document
curl -X POST http://localhost:3000/api/v1/knowledge/documents \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TOKEN" \
  -d '{
    "type": "text",
    "title": "FAQ",
    "sourceContent": "Our refund policy allows returns within 30 days of purchase. Contact support@example.com for refund requests."
  }'

# Activate knowledge base
curl -X PATCH http://localhost:3000/api/v1/knowledge/base \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TOKEN" \
  -d '{ "status": "active" }'
```

- [ ] **Step 4: Test RAG via the test endpoint**

```bash
curl -X POST http://localhost:3000/api/v1/tenants/me/ai-settings/test \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TOKEN" \
  -d '{ "question": "What is your refund policy?" }'
```

Expected: JSON response with `response`, `confidence`, and `chunks` array.

- [ ] **Step 5: Check stats**

```bash
curl http://localhost:3000/api/v1/knowledge/stats \
  -H "Authorization: Bearer TOKEN"
```

Expected: Document count and chunk count > 0.

- [ ] **Step 6: Final commit (if any fixes needed)**

```bash
git add -A && git commit -m "fix: address issues found during manual verification"
```
