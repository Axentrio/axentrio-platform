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
      "startChar": 0,
      "endChar": 1500,
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
