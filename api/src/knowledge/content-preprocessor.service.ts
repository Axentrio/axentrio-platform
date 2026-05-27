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
const MIN_CHARS_FOR_PREPROCESSING = 200;  // Skip classification for very short docs
const MAX_CHARS_PER_LLM_CALL = 50000;

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

  // Skip preprocessing for very short documents — not worth the LLM call
  if (originalCharCount < MIN_CHARS_FOR_PREPROCESSING) {
    logger.info(`[Preprocessor] Document too short (${originalCharCount} chars), skipping`);
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
        qualityScore: 'excellent',
        qualityReason: 'Short document, passed through without preprocessing.',
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
  _classification: ClassificationResult,
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
