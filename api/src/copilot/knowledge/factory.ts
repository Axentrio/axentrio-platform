/**
 * Build a `CopilotKnowledgeSource` for the currently-configured
 * retrieval mode. Mode comes from `COPILOT_RETRIEVAL_MODE` env;
 * default is `lexical` which is the only mode lit up in v1.
 *
 * `vector` and `hybrid` modes throw — they're declared in the type
 * surface so callers can plan around the eventual config, but the
 * implementations land in a later milestone.
 */
import type { EntityManager } from 'typeorm';
import type { CopilotKnowledgeSource, RetrievalType } from './types';
import { LexicalCopilotKnowledgeSource } from './lexical';

const VALID_MODES: ReadonlySet<RetrievalType> = new Set(['lexical', 'vector', 'hybrid']);

export function resolveRetrievalMode(): RetrievalType {
  const raw = process.env.COPILOT_RETRIEVAL_MODE?.trim().toLowerCase();
  if (!raw) return 'lexical';
  if (!VALID_MODES.has(raw as RetrievalType)) {
    throw new Error(
      `COPILOT_RETRIEVAL_MODE='${raw}' is not one of: ${[...VALID_MODES].join(', ')}.`,
    );
  }
  return raw as RetrievalType;
}

export function createCopilotKnowledgeSource(manager: EntityManager): CopilotKnowledgeSource {
  const mode = resolveRetrievalMode();
  switch (mode) {
    case 'lexical':
      return new LexicalCopilotKnowledgeSource(manager);
    case 'vector':
    case 'hybrid':
      throw new Error(
        `COPILOT_RETRIEVAL_MODE='${mode}' is reserved for a future milestone; only 'lexical' is implemented in v1.`,
      );
  }
}
