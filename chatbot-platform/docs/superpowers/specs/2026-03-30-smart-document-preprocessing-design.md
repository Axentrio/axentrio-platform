# Smart Document Preprocessing for Knowledge Base

**Date:** 2026-03-30
**Status:** Draft
**Goal:** Add an LLM-powered preprocessing layer to the knowledge base ingestion pipeline that classifies document content, transforms non-prose content (tables, structured data) into searchable prose, strips low-value boilerplate, and produces a quality report per document.

---

## Problem Statement

The current ingestion pipeline treats all extracted text identically: extract → chunk → embed. This fails for:

1. **Tabular/transactional data** — bank statements, invoices, spreadsheets get chunked into meaningless fragments like "TRANSFER FR A/C 800.00- 24,667.70" that have no semantic meaning for embedding search.
2. **Noise pollution** — repeated headers, footers, legal disclaimers, and promotional text get embedded and dilute retrieval quality.
3. **No visibility** — admins have no way to know whether an uploaded document will produce good AI responses.

## Design Principles

- **Prose documents should cost nothing extra** — classification is cheap, transformation only runs when needed.
- **Never lose original content** — raw extracted text stays in `sourceContent` for reference; only the chunking input changes.
- **Extensible to interactive preview** — the preprocessor output is decoupled from chunking, so a review gate can be inserted later without refactoring.

---

## Pipeline Architecture

### Current pipeline
```
Upload → Extract text → Chunk → Embed → Store
```

### New pipeline
```
Upload → Extract text → Classify (LLM) → Transform if needed (LLM) → Chunk → Embed → Store
                                                                          ↓
                                                                   Quality Report
```

### LLM choice
- **Model:** `gpt-4o-mini` via the platform-level `OPENAI_API_KEY` (already in env).
- **Why:** ~$0.15/1M input tokens, fast, independent of tenant AI config. Documents can be uploaded before a tenant configures their own AI provider.
- **Not the tenant's LLM** — preprocessing is a platform service, not a tenant cost.

### New service file
`content-preprocessor.service.ts` with a single public interface:

```typescript
interface PreprocessResult {
  contentType: 'prose' | 'tabular' | 'mixed' | 'structured_list' | 'low_value';
  transformedText: string;       // the text that goes to chunking
  qualityReport: QualityReport;  // stored on document entity
}

function preprocess(rawText: string): Promise<PreprocessResult>
```

This is the extensibility point. For future interactive preview (Option C), the ingestion worker calls `preprocess()`, stores the result as `pending_review`, and waits for user approval before calling `chunk()`.

---

## Content Classification

The classifier sends the first ~2000 characters of extracted text to `gpt-4o-mini` with a structured prompt that returns JSON.

### Classification output

```json
{
  "contentType": "prose | tabular | mixed | structured_list | low_value",
  "confidence": 0.92,
  "sections": [
    {
      "startChar": 0,
      "endChar": 1500,
      "type": "tabular",
      "description": "Bank transaction records"
    },
    {
      "startChar": 1500,
      "endChar": 3000,
      "type": "low_value",
      "description": "Repeated page headers and legal disclaimers"
    }
  ],
  "language": "en",
  "summary": "Maybank Islamic bank statement with 40+ transactions for Feb 2026"
}
```

### Classification details

- **Input:** first ~2000 characters of extracted text. Enough to determine document type without sending the entire document.
- **Cost:** near-zero (~0.001 cents per classification).
- **`sections` array:** maps the document into regions so the transformer knows which parts to transform and which to strip. Critical for mixed documents.
- **`summary` field:** stored and used as a document-level embedding — so even if chunk quality is mediocre, the document itself is findable by topic.

### Content type definitions

| Type | Description | Example |
|---|---|---|
| `prose` | Natural language paragraphs, articles, documentation | Help articles, FAQs, policies, product guides |
| `tabular` | Row/column data, transaction records, spreadsheet-like content | Bank statements, invoices, CSVs, price lists |
| `mixed` | Combination of prose and structured data | Product catalogs with specs tables + descriptions |
| `structured_list` | Ordered/unordered lists, feature comparisons, menus | Pricing tiers, feature matrices, restaurant menus |
| `low_value` | Boilerplate, repeated headers/footers, ads, legal notices | Page footers, disclaimers, promotional inserts |

---

## Content Transformation

Based on classification, the transformer applies different strategies per section.

### Strategy per content type

**`prose`** — pass through unchanged. Zero LLM cost.

**`tabular`** — sent to `gpt-4o-mini` with a prompt instructing it to:
- Convert rows into natural language descriptions
- Group related items (e.g., food purchases together)
- Preserve all amounts, dates, names, and reference numbers
- Output should be readable prose that embeddings can match against

Example input: raw transaction rows
Example output: "On February 3rd, food purchases were made at SS2 Chow Yang Kopitiam (RM6.70), Wake Me Up Cafe (RM13.00), and RM40.00 was transferred to Ng Yik Ling for drinks."

**`structured_list`** — reformatted as descriptive prose:
Example: "The Pro plan costs $49/month and includes 10 seats, unlimited projects, and priority support."

**`mixed`** — split into sections based on the classifier's section map. Each section gets its own strategy applied. Prose sections pass through, tabular sections get transformed, low-value sections get stripped.

**`low_value`** — stripped entirely. Not chunked, not embedded. Original text preserved in `sourceContent`.

### Transformation limits

| Limit | Value | Reason |
|---|---|---|
| Max chars per LLM call | 50,000 | Avoid context window issues |
| Total token budget per document | 100,000 tokens | Cost cap |
| Timeout per batch | 60 seconds | Prevent hung jobs |
| Timeout per document total | 5 minutes | Hard cap on processing time |

### Original text preservation

The transformed text replaces raw text **only for the chunking step**. The original raw text remains in `sourceContent` on the `KnowledgeDocument` entity (already stored today). Nothing is lost.

---

## Quality Report

After ingestion completes, a quality report is stored as JSON on the document entity.

### New database column

Add `qualityReport` JSONB column to `knowledge_documents` table (nullable, null for documents ingested before this feature).

### Report structure

```json
{
  "contentType": "tabular",
  "contentSummary": "Maybank Islamic bank statement with 40+ transactions for Feb 2026",
  "originalCharCount": 12500,
  "processedCharCount": 3200,
  "strippedCharCount": 6800,
  "transformedSections": 3,
  "passthroughSections": 1,
  "strippedSections": 5,
  "qualityScore": "excellent | good | fair | poor",
  "qualityReason": "Tabular data was successfully transformed into searchable prose. Boilerplate removed.",
  "chunksCreated": 12,
  "estimatedTokenCost": 4200
}
```

### Quality score tiers

| Score | Meaning | When |
|---|---|---|
| `excellent` | Pure prose, no transformation needed | FAQ docs, help articles, policies |
| `good` | Transformed successfully | Tables converted to prose, structured data reformatted |
| `fair` | Partially transformed, some content may not search well | Mixed docs where some sections couldn't be transformed |
| `poor` | Mostly low-value content, very little usable material | Documents that are almost entirely boilerplate or unsuitable |

### UI display

No new pages or modals. The existing document card in `DocumentCard.tsx` gets enriched:

- **Quality dot** next to the status badge:
  - Excellent/Good → green dot (no action needed)
  - Fair → amber dot + tooltip: "Some content may not produce good AI responses"
  - Poor → red dot + tooltip: "Most content was stripped as unsuitable. Consider removing this document."
- **Click to expand** — shows the full quality breakdown (content type, char counts, what was transformed/stripped)
- **Content summary** — shown as subtitle text on the card (from `contentSummary` field)

---

## Integration with Existing Ingestion Worker

### Current ingestion flow (`ingestion.worker.ts`)

```
1. Fetch document from DB
2. Set status = 'processing'
3. Extract text (based on type: text/faq direct, pdf/docx from S3)
4. Chunk text
5. Embed chunks in batches
6. Save chunks to DB
7. Set status = 'indexed'
```

### New ingestion flow

```
1. Fetch document from DB
2. Set status = 'processing'
3. Extract text (unchanged)
4. NEW: Preprocess text (classify + transform)
5. NEW: Store quality report on document entity
6. Chunk TRANSFORMED text (instead of raw text)
7. Embed chunks in batches (unchanged)
8. Save chunks to DB (unchanged)
9. Set status = 'indexed'
```

Steps 4-5 are the only additions. The preprocessor is called between extraction and chunking. If preprocessing fails (LLM error, timeout), fall back to the current behavior (chunk raw text) and set quality score to `fair` with a reason explaining the fallback.

### Graceful degradation

- If `OPENAI_API_KEY` is not set → skip preprocessing entirely, chunk raw text, no quality report.
- If LLM call fails → fall back to raw text chunking, quality score = `fair`, reason = "Preprocessing failed, raw text was used."
- If document is pure prose (classified with high confidence) → skip transformation, set quality score = `excellent`.

---

## Extensibility: Future Interactive Preview (Option C)

The design enables easy upgrade to interactive preview later:

### Current flow (Option B)
```
preprocess() → result → chunk() → embed() → store()
```

### Future flow (Option C)
```
preprocess() → result → store as "pending_review" → [user reviews] → chunk() → embed() → store()
```

### What Option C would require (not in scope now)
1. New `pending_review` document status
2. Ingestion worker pauses after preprocessing
3. UI screen showing transformed text with approve/edit/reject buttons
4. Resume endpoint that triggers chunking + embedding

### Why this works without refactoring
`preprocess()` outputs clean text + quality report. `chunk()` accepts clean text as input. They don't know about each other. Inserting a gate between them is a workflow change, not an architecture change.

---

## Files to Create/Modify

### New files
```
api/src/knowledge/content-preprocessor.service.ts   — classify + transform logic
api/src/knowledge/content-preprocessor.prompts.ts    — LLM prompt templates
```

### Modified files
```
api/src/knowledge/ingestion.worker.ts                — call preprocessor between extract and chunk
api/src/database/entities/KnowledgeDocument.ts       — add qualityReport column
api/src/database/migrations/XXXX-add-quality-report.ts — migration for new column
portal/src/pages/knowledge/DocumentCard.tsx           — show quality indicator + report
```

---

## Cost Estimates

| Document type | Classification cost | Transformation cost | Total |
|---|---|---|---|
| Prose (5 pages) | ~$0.0001 | $0 (passthrough) | ~$0.0001 |
| Bank statement (8 pages) | ~$0.0001 | ~$0.005 | ~$0.005 |
| Mixed catalog (20 pages) | ~$0.0001 | ~$0.01 | ~$0.01 |
| Large manual (100 pages) | ~$0.0001 | ~$0.03 | ~$0.03 |

For most documents, the cost is effectively zero. Transformation costs only apply to non-prose content.

---

## What is NOT in Scope

- Interactive preview / edit before indexing (Option C) — extensibility is designed in but not built
- Re-processing existing documents — new documents only; existing ones keep current chunks
- Custom classification rules per tenant — platform-level classification only
- Support for non-text content (images, diagrams in PDFs) — text extraction only, same as today
