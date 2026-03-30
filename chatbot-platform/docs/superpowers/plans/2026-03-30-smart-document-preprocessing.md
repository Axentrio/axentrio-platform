# Smart Document Preprocessing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an LLM-powered preprocessing step to the knowledge base ingestion pipeline that classifies content, transforms non-prose data into searchable prose, strips boilerplate, and produces a quality report per document.

**Architecture:** A new `content-preprocessor.service.ts` is inserted between text extraction and chunking in the existing ingestion worker. It calls `gpt-4o-mini` via the platform OpenAI key to classify content type and transform structured/tabular data into prose. A `qualityReport` JSONB column is added to the documents table. The frontend DocumentCard shows a quality indicator.

**Tech Stack:** TypeScript, OpenAI API (`gpt-4o-mini`), TypeORM (migration + entity), React (DocumentCard update)

**Spec:** `docs/superpowers/specs/2026-03-30-smart-document-preprocessing-design.md`

---

## Verified Import Paths (reference for all tasks)

| What | Import Path |
|------|-------------|
| OpenAI client | `import OpenAI from 'openai'` |
| Config | `import { config } from '../config/environment'` |
| Logger | `import { logger } from '../utils/logger'` |
| KnowledgeDocument entity | `import { KnowledgeDocument } from '../database/entities/KnowledgeDocument'` |
| Chunk type | `import { Chunk } from './chunking.service'` |

---

## File Structure

### New files
```
api/src/knowledge/content-preprocessor.service.ts    — classify + transform logic
api/src/knowledge/content-preprocessor.prompts.ts     — LLM prompt templates
api/src/database/migrations/1775500000000-AddQualityReportColumn.ts — migration
```

### Files to modify
```
api/src/database/entities/KnowledgeDocument.ts        — add qualityReport column
api/src/knowledge/ingestion.worker.ts                 — call preprocessor between extract and chunk
portal/src/pages/knowledge/DocumentCard.tsx            — show quality indicator
```

---

## Task 1: Database migration for qualityReport column

**Files:**
- Create: `api/src/database/migrations/1775500000000-AddQualityReportColumn.ts`
- Modify: `api/src/database/entities/KnowledgeDocument.ts`

- [ ] **Step 1: Create the migration file**

Create `api/src/database/migrations/1775500000000-AddQualityReportColumn.ts`:

```typescript
import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddQualityReportColumn1775500000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "knowledge_documents"
      ADD COLUMN "qualityReport" jsonb DEFAULT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "knowledge_documents"
      DROP COLUMN IF EXISTS "qualityReport"
    `);
  }
}
```

- [ ] **Step 2: Add the column to the KnowledgeDocument entity**

Read `api/src/database/entities/KnowledgeDocument.ts`. Add the new column after the `metadata` column (around line 67):

```typescript
@Column({ type: 'jsonb', nullable: true, default: null })
qualityReport: {
  contentType: 'prose' | 'tabular' | 'mixed' | 'structured_list' | 'low_value';
  contentSummary: string;
  originalCharCount: number;
  processedCharCount: number;
  strippedCharCount: number;
  transformedSections: number;
  passthroughSections: number;
  strippedSections: number;
  qualityScore: 'excellent' | 'good' | 'fair' | 'poor';
  qualityReason: string;
  chunksCreated: number;
  estimatedTokenCost: number;
} | null;
```

- [ ] **Step 3: Run the migration**

Run: `cd chatbot-platform/api && npx typeorm migration:run -d src/database/data-source.ts`

If this doesn't work with ts-node, check how existing migrations are run. Look for a script in `package.json`:

Run: `cd chatbot-platform/api && grep -i "migration" package.json`

Use whatever command the project uses for migrations.

- [ ] **Step 4: Verify the column exists**

Connect to the database and check:
```sql
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'knowledge_documents' AND column_name = 'qualityReport';
```

- [ ] **Step 5: Commit**

```bash
git add api/src/database/migrations/1775500000000-AddQualityReportColumn.ts api/src/database/entities/KnowledgeDocument.ts
git commit -m "feat: add qualityReport column to knowledge_documents

Adds JSONB column for storing content classification, transformation
stats, and quality score per document."
```

---

## Task 2: Create LLM prompt templates

**Files:**
- Create: `api/src/knowledge/content-preprocessor.prompts.ts`

- [ ] **Step 1: Create the prompts file**

Create `api/src/knowledge/content-preprocessor.prompts.ts`:

```typescript
/**
 * LLM prompt templates for content classification and transformation.
 * Used by content-preprocessor.service.ts with gpt-4o-mini.
 */

export const CLASSIFICATION_PROMPT = `You are a document content classifier. Analyze the following text sample and classify it.

Respond with ONLY valid JSON in this exact format:
{
  "contentType": "prose" | "tabular" | "mixed" | "structured_list" | "low_value",
  "confidence": <number 0.0-1.0>,
  "sections": [
    {
      "startChar": <number>,
      "endChar": <number>,
      "type": "prose" | "tabular" | "structured_list" | "low_value",
      "description": "<brief description>"
    }
  ],
  "language": "<ISO 639-1 code>",
  "summary": "<one sentence describing what this document is about>"
}

Content type definitions:
- "prose": Natural language paragraphs, articles, FAQs, documentation, help guides
- "tabular": Row/column data, transaction records, spreadsheet-like content, invoices, ledgers
- "mixed": Combination of prose and structured data in different sections
- "structured_list": Ordered/unordered lists, feature comparisons, pricing tiers, menus
- "low_value": Boilerplate, repeated headers/footers, legal disclaimers, advertisements, promotional text

Rules:
- The sections array should cover the entire text (no gaps)
- For short or simple documents, a single section covering the whole text is fine
- Be conservative: if unsure, classify as "prose" (it will pass through unchanged)
- The summary should be useful for search — include key topics, names, and subjects

TEXT SAMPLE:
`;

export const TRANSFORMATION_PROMPT = `You are a document content transformer. Convert the following structured/tabular content into natural language prose that would be useful for answering questions via semantic search.

Rules:
- Group related items together (e.g., food purchases, bill payments)
- Preserve ALL specific details: amounts, dates, names, reference numbers, descriptions
- Write in clear, descriptive sentences
- Use natural language that someone might search for
- Do NOT add commentary or opinions — just describe what the data contains
- Output should be 2-5 paragraphs depending on content volume

CONTENT TO TRANSFORM:
`;

export const STRUCTURED_LIST_PROMPT = `You are a document content transformer. Convert the following structured list or comparison data into descriptive prose paragraphs suitable for semantic search.

Rules:
- Convert each item/tier/option into a complete descriptive sentence
- Preserve ALL specific values: prices, features, limits, names
- Make the text naturally searchable — write how someone would describe these items
- Do NOT add commentary or opinions

CONTENT TO TRANSFORM:
`;
```

- [ ] **Step 2: Commit**

```bash
git add api/src/knowledge/content-preprocessor.prompts.ts
git commit -m "feat: add LLM prompt templates for content preprocessing

Classification prompt for document type detection and transformation
prompts for converting tabular/structured content to prose."
```

---

## Task 3: Create the content preprocessor service

**Files:**
- Create: `api/src/knowledge/content-preprocessor.service.ts`

- [ ] **Step 1: Create the preprocessor service**

Create `api/src/knowledge/content-preprocessor.service.ts`:

```typescript
/**
 * Content Preprocessor Service
 * Classifies document content and transforms non-prose sections into
 * searchable prose using gpt-4o-mini. Produces a quality report.
 */

import OpenAI from 'openai';
import { config } from '../config/environment';
import { logger } from '../utils/logger';
import {
  CLASSIFICATION_PROMPT,
  TRANSFORMATION_PROMPT,
  STRUCTURED_LIST_PROMPT,
} from './content-preprocessor.prompts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ContentType = 'prose' | 'tabular' | 'mixed' | 'structured_list' | 'low_value';
export type QualityScore = 'excellent' | 'good' | 'fair' | 'poor';

export interface ContentSection {
  startChar: number;
  endChar: number;
  type: ContentType;
  description: string;
}

export interface ClassificationResult {
  contentType: ContentType;
  confidence: number;
  sections: ContentSection[];
  language: string;
  summary: string;
}

export interface QualityReport {
  contentType: ContentType;
  contentSummary: string;
  originalCharCount: number;
  processedCharCount: number;
  strippedCharCount: number;
  transformedSections: number;
  passthroughSections: number;
  strippedSections: number;
  qualityScore: QualityScore;
  qualityReason: string;
  chunksCreated: number;
  estimatedTokenCost: number;
}

export interface PreprocessResult {
  transformedText: string;
  qualityReport: Omit<QualityReport, 'chunksCreated'>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MODEL = 'gpt-4o-mini';
const CLASSIFICATION_SAMPLE_CHARS = 2000;
const MAX_CHARS_PER_LLM_CALL = 50000;
const TRANSFORM_TIMEOUT_MS = 60000;
const TOTAL_TIMEOUT_MS = 300000;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

let openaiClient: OpenAI | null = null;

function getClient(): OpenAI {
  if (!openaiClient) {
    const apiKey = config.rag.openaiApiKey;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is required for content preprocessing');
    }
    openaiClient = new OpenAI({ apiKey });
  }
  return openaiClient;
}

/**
 * Preprocess extracted document text.
 * Classifies content type and transforms non-prose sections into searchable prose.
 * Returns transformed text and a quality report (minus chunksCreated, which is set later).
 */
export async function preprocess(rawText: string): Promise<PreprocessResult> {
  const originalCharCount = rawText.length;

  // If no OpenAI key, skip preprocessing entirely
  if (!config.rag.openaiApiKey) {
    logger.info('[Preprocessor] No OPENAI_API_KEY, skipping preprocessing');
    return {
      transformedText: rawText,
      qualityReport: {
        contentType: 'prose',
        contentSummary: '',
        originalCharCount,
        processedCharCount: originalCharCount,
        strippedCharCount: 0,
        transformedSections: 0,
        passthroughSections: 1,
        strippedSections: 0,
        qualityScore: 'fair',
        qualityReason: 'Preprocessing skipped — OPENAI_API_KEY not configured.',
        estimatedTokenCost: 0,
      },
    };
  }

  try {
    // Step 1: Classify
    const classification = await classify(rawText);
    logger.info(`[Preprocessor] Classified as "${classification.contentType}" (confidence: ${classification.confidence})`);

    // Step 2: Transform based on classification
    const { transformedText, stats } = await transform(rawText, classification);

    // Step 3: Build quality report
    const processedCharCount = transformedText.length;
    const strippedCharCount = originalCharCount - processedCharCount - (stats.transformedInputChars - stats.transformedOutputChars);
    const qualityScore = determineQualityScore(classification, stats);

    const qualityReport: Omit<QualityReport, 'chunksCreated'> = {
      contentType: classification.contentType,
      contentSummary: classification.summary,
      originalCharCount,
      processedCharCount,
      strippedCharCount: Math.max(0, strippedCharCount),
      transformedSections: stats.transformedSections,
      passthroughSections: stats.passthroughSections,
      strippedSections: stats.strippedSections,
      qualityScore,
      qualityReason: buildQualityReason(classification, stats, qualityScore),
      estimatedTokenCost: stats.estimatedTokens,
    };

    logger.info(`[Preprocessor] Done — score: ${qualityScore}, ${processedCharCount} chars processed, ${Math.max(0, strippedCharCount)} stripped`);

    return { transformedText, qualityReport };
  } catch (err) {
    logger.error('[Preprocessor] Failed, falling back to raw text', err);
    return {
      transformedText: rawText,
      qualityReport: {
        contentType: 'prose',
        contentSummary: '',
        originalCharCount,
        processedCharCount: originalCharCount,
        strippedCharCount: 0,
        transformedSections: 0,
        passthroughSections: 1,
        strippedSections: 0,
        qualityScore: 'fair',
        qualityReason: 'Preprocessing failed, raw text was used.',
        estimatedTokenCost: 0,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

async function classify(rawText: string): Promise<ClassificationResult> {
  const sample = rawText.slice(0, CLASSIFICATION_SAMPLE_CHARS);
  const client = getClient();

  const response = await client.chat.completions.create({
    model: MODEL,
    messages: [
      { role: 'system', content: 'You are a document classifier. Respond with ONLY valid JSON.' },
      { role: 'user', content: CLASSIFICATION_PROMPT + sample },
    ],
    temperature: 0.1,
    max_tokens: 1000,
    response_format: { type: 'json_object' },
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error('Empty classification response from LLM');
  }

  const parsed = JSON.parse(content) as ClassificationResult;

  // Validate required fields
  if (!parsed.contentType || !parsed.sections || !parsed.summary) {
    throw new Error('Invalid classification response: missing required fields');
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Transformation
// ---------------------------------------------------------------------------

interface TransformStats {
  transformedSections: number;
  passthroughSections: number;
  strippedSections: number;
  transformedInputChars: number;
  transformedOutputChars: number;
  estimatedTokens: number;
}

async function transform(
  rawText: string,
  classification: ClassificationResult
): Promise<{ transformedText: string; stats: TransformStats }> {
  // Pure prose — pass through entirely
  if (classification.contentType === 'prose' && classification.confidence > 0.8) {
    return {
      transformedText: rawText,
      stats: {
        transformedSections: 0,
        passthroughSections: 1,
        strippedSections: 0,
        transformedInputChars: 0,
        transformedOutputChars: 0,
        estimatedTokens: 0,
      },
    };
  }

  // Pure low-value — strip almost everything, keep summary
  if (classification.contentType === 'low_value') {
    return {
      transformedText: classification.summary,
      stats: {
        transformedSections: 0,
        passthroughSections: 0,
        strippedSections: classification.sections.length,
        transformedInputChars: 0,
        transformedOutputChars: 0,
        estimatedTokens: 0,
      },
    };
  }

  // Mixed / tabular / structured_list — process per section
  const parts: string[] = [];
  const stats: TransformStats = {
    transformedSections: 0,
    passthroughSections: 0,
    strippedSections: 0,
    transformedInputChars: 0,
    transformedOutputChars: 0,
    estimatedTokens: 0,
  };

  for (const section of classification.sections) {
    const sectionText = rawText.slice(section.startChar, section.endChar).trim();
    if (!sectionText) continue;

    switch (section.type) {
      case 'prose': {
        parts.push(sectionText);
        stats.passthroughSections++;
        break;
      }

      case 'tabular':
      case 'structured_list': {
        const prompt = section.type === 'tabular' ? TRANSFORMATION_PROMPT : STRUCTURED_LIST_PROMPT;
        // Split into batches if section is too large
        const batches = splitIntoBatches(sectionText, MAX_CHARS_PER_LLM_CALL);
        for (const batch of batches) {
          const transformed = await callLLM(prompt + batch);
          parts.push(transformed);
          stats.transformedInputChars += batch.length;
          stats.transformedOutputChars += transformed.length;
          stats.estimatedTokens += Math.ceil(batch.length / 4) + Math.ceil(transformed.length / 4);
        }
        stats.transformedSections++;
        break;
      }

      case 'low_value': {
        stats.strippedSections++;
        // Intentionally not added to parts — stripped
        break;
      }

      default: {
        // Unknown type — pass through as safety
        parts.push(sectionText);
        stats.passthroughSections++;
        break;
      }
    }
  }

  return {
    transformedText: parts.filter(Boolean).join('\n\n'),
    stats,
  };
}

async function callLLM(prompt: string): Promise<string> {
  const client = getClient();

  const response = await client.chat.completions.create({
    model: MODEL,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
    max_tokens: 4000,
  });

  return response.choices[0]?.message?.content?.trim() || '';
}

function splitIntoBatches(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];

  const batches: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);
    // Try to split at a newline boundary
    if (end < text.length) {
      const lastNewline = text.lastIndexOf('\n', end);
      if (lastNewline > start + maxChars * 0.5) {
        end = lastNewline + 1;
      }
    }
    batches.push(text.slice(start, end));
    start = end;
  }
  return batches;
}

// ---------------------------------------------------------------------------
// Quality Scoring
// ---------------------------------------------------------------------------

function determineQualityScore(
  classification: ClassificationResult,
  stats: TransformStats
): QualityScore {
  if (classification.contentType === 'prose' && classification.confidence > 0.8) {
    return 'excellent';
  }
  if (classification.contentType === 'low_value') {
    return 'poor';
  }
  if (stats.transformedSections > 0 && stats.strippedSections <= stats.transformedSections) {
    return 'good';
  }
  if (stats.strippedSections > stats.passthroughSections + stats.transformedSections) {
    return 'poor';
  }
  return 'fair';
}

function buildQualityReason(
  classification: ClassificationResult,
  stats: TransformStats,
  score: QualityScore
): string {
  switch (score) {
    case 'excellent':
      return 'Document contains well-structured prose suitable for knowledge base search.';
    case 'good':
      return `${stats.transformedSections} section(s) of structured data were transformed into searchable prose.${stats.strippedSections > 0 ? ` ${stats.strippedSections} section(s) of boilerplate were removed.` : ''}`;
    case 'fair':
      return 'Some content may not produce good AI responses. Consider reviewing the document.';
    case 'poor':
      return 'Most content was stripped as unsuitable for knowledge base search. Consider removing this document.';
  }
}
```

- [ ] **Step 2: Verify TypeScript compilation**

Run: `cd chatbot-platform/api && npx tsc --noEmit 2>&1 | head -20`

Fix any import path issues.

- [ ] **Step 3: Commit**

```bash
git add api/src/knowledge/content-preprocessor.service.ts
git commit -m "feat: create content preprocessor service

Classifies document content type using gpt-4o-mini, transforms
tabular/structured data into searchable prose, strips boilerplate,
and produces quality reports."
```

---

## Task 4: Integrate preprocessor into ingestion worker

**Files:**
- Modify: `api/src/knowledge/ingestion.worker.ts`

- [ ] **Step 1: Read the current ingestion worker**

Read `api/src/knowledge/ingestion.worker.ts` to get exact line numbers and structure.

- [ ] **Step 2: Add the preprocessor import**

Add to imports at the top of the file:

```typescript
import { preprocess } from './content-preprocessor.service';
```

- [ ] **Step 3: Insert preprocessing between text extraction and chunking**

Find the section after text extraction (after the text variable is set, around line 58) and before chunking (around line 70). Insert the preprocessing call:

After the text truncation block (around line 67) and before the `const kb = ...` line, add:

```typescript
      // Preprocess: classify and transform content
      const preprocessResult = await preprocess(text);
      const processedText = preprocessResult.transformedText;
      logger.info(`[Ingestion] Document ${documentId} preprocessed: ${preprocessResult.qualityReport.contentType} (${preprocessResult.qualityReport.qualityScore})`);
```

- [ ] **Step 4: Update chunking to use preprocessed text**

Change the chunking line from:
```typescript
      let chunks = chunkText(text, kb.chunkSize, kb.chunkOverlap);
```
to:
```typescript
      let chunks = chunkText(processedText, kb.chunkSize, kb.chunkOverlap);
```

- [ ] **Step 5: Store the quality report on the document**

Find where the document status is set to 'indexed' (around line 105). Before saving, add the quality report:

```typescript
      doc.qualityReport = {
        ...preprocessResult.qualityReport,
        chunksCreated: chunks.length,
      };
```

This should go right before or alongside where `doc.chunkCount = chunks.length` is set.

- [ ] **Step 6: Verify TypeScript compilation**

Run: `cd chatbot-platform/api && npx tsc --noEmit 2>&1 | head -20`

- [ ] **Step 7: Commit**

```bash
git add api/src/knowledge/ingestion.worker.ts
git commit -m "feat: integrate content preprocessor into ingestion pipeline

Calls preprocess() between text extraction and chunking.
Stores quality report on the document entity after indexing."
```

---

## Task 5: Update DocumentCard to show quality indicator

**Files:**
- Modify: `portal/src/pages/knowledge/DocumentCard.tsx`

- [ ] **Step 1: Read the current DocumentCard**

Read `portal/src/pages/knowledge/DocumentCard.tsx` to get the exact props interface and JSX structure.

- [ ] **Step 2: Extend the document prop type**

Add `qualityReport` to the document prop interface:

```typescript
interface DocumentCardProps {
  document: {
    id: string;
    type: 'text' | 'faq' | 'pdf' | 'docx';
    title: string;
    status: 'pending' | 'processing' | 'indexed' | 'failed';
    chunkCount: number;
    errorMessage?: string | null;
    updatedAt: string;
    qualityReport?: {
      contentType: string;
      contentSummary: string;
      qualityScore: 'excellent' | 'good' | 'fair' | 'poor';
      qualityReason: string;
      originalCharCount: number;
      processedCharCount: number;
      strippedCharCount: number;
      transformedSections: number;
      chunksCreated: number;
    } | null;
  };
  onEdit: () => void;
  onRetry: () => void;
  onDelete: () => void;
}
```

- [ ] **Step 3: Add quality score config**

Add a config object alongside the existing `statusConfig`:

```typescript
const qualityConfig: Record<string, { color: string; label: string }> = {
  excellent: { color: 'bg-emerald-400', label: 'Excellent quality' },
  good: { color: 'bg-emerald-400', label: 'Good quality' },
  fair: { color: 'bg-amber-400', label: 'Fair quality' },
  poor: { color: 'bg-red-400', label: 'Poor quality' },
};
```

- [ ] **Step 4: Add quality indicator to the card**

Find the metadata section of the card (where chunk count and time ago are shown). Add a quality dot with tooltip after the status badge:

```tsx
{document.qualityReport && document.status === 'indexed' && (
  <div className="flex items-center gap-1.5" title={document.qualityReport.qualityReason}>
    <span className={`w-1.5 h-1.5 rounded-full ${qualityConfig[document.qualityReport.qualityScore]?.color || 'bg-gray-400'}`} />
    <span className="text-[10px] text-text-muted">
      {document.qualityReport.contentSummary
        ? document.qualityReport.contentSummary.slice(0, 60) + (document.qualityReport.contentSummary.length > 60 ? '...' : '')
        : qualityConfig[document.qualityReport.qualityScore]?.label}
    </span>
  </div>
)}
```

Place this right after the existing metadata line (type, chunk count, time) to keep it compact.

- [ ] **Step 5: Add quality details on hover/expand**

If the card has a poor/fair quality score, show the reason as a small warning below the metadata:

```tsx
{document.qualityReport && ['poor', 'fair'].includes(document.qualityReport.qualityScore) && document.status === 'indexed' && (
  <p className="text-[10px] text-amber-400/80 mt-1">
    {document.qualityReport.qualityReason}
  </p>
)}
```

- [ ] **Step 6: Verify TypeScript compilation**

Run: `cd chatbot-platform/portal && npx tsc --noEmit 2>&1 | head -20`

- [ ] **Step 7: Commit**

```bash
git add portal/src/pages/knowledge/DocumentCard.tsx
git commit -m "feat: show document quality indicator on DocumentCard

Displays quality dot (green/amber/red) with content summary
and warning message for fair/poor quality documents."
```

---

## Task 6: Smoke test the full pipeline

**Files:**
- No new files

- [ ] **Step 1: Start the API server**

Run: `cd chatbot-platform/api && npm run dev`

Check for startup errors, especially around the migration and entity changes.

- [ ] **Step 2: Upload a prose document (text type)**

Create a text document via the portal with content like:
```
Our return policy allows customers to return items within 30 days of purchase.
Items must be in original condition with tags attached.
Refunds are processed within 5-7 business days.
```

Check the server logs for:
- `[Preprocessor] Classified as "prose"`
- `[Preprocessor] Done — score: excellent`
- `[Ingestion] Document ... preprocessed: prose (excellent)`

Verify the document card shows a green quality dot.

- [ ] **Step 3: Upload a PDF with tabular content**

Upload a PDF with tables or transaction data. Check logs for:
- `[Preprocessor] Classified as "tabular"` or `"mixed"`
- Transformation happening
- `[Preprocessor] Done — score: good`

Verify the document card shows appropriate quality indicator and content summary.

- [ ] **Step 4: Test the RAG query against transformed content**

Use the Test Chat panel to ask questions about the uploaded content. Verify that queries which previously failed (like asking about specific transactions) now return relevant results.

- [ ] **Step 5: Verify graceful degradation**

Temporarily remove `OPENAI_API_KEY` from `.env` and restart. Upload a document. Verify:
- No crash
- Document is indexed normally (raw text chunking)
- Quality report is null or shows "skipped"

Restore the API key after testing.

- [ ] **Step 6: Commit any fixes**

```bash
git add -A
git commit -m "fix: resolve integration issues from preprocessing pipeline"
```
