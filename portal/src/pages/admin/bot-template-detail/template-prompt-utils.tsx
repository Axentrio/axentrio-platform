/**
 * Placeholder helpers for the Bot Template editor: the canonical {placeholder}
 * set, chip insertion, and prompt rendering. Leaf module: it never imports
 * AdminBotTemplateDetail.tsx.
 */
import React from 'react';
import { PLACEHOLDER_KEYS } from '@contracts/prompt-placeholders';

// Canonical {placeholder} set — derived from the ONE catalog the API composer and
// linter also use (api/src/contracts/prompt-placeholders.ts), so the editor can
// never flag a key the composer supports (or accept one it doesn't).
export const KNOWN_PLACEHOLDERS = PLACEHOLDER_KEYS;

/** Append a chip to a text value with a single separating space. */
export const appendChip = (text: string, chip: string) => text + (text && !text.endsWith(' ') ? ' ' : '') + chip;

/** A human label for a variable key, e.g. 'cancellationPolicy' → 'Cancellation policy'. */
export function prettifyKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

export function unknownPlaceholders(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(/\{(\w+)\}/g)) if (!KNOWN_PLACEHOLDERS.has(m[1])) out.add(m[1]);
  return [...out];
}

/** Render a prompt body with its {placeholders} highlighted as fill-in slots:
 *  known ones (resolved per business) in primary, unknown ones flagged amber. */
export function renderPromptWithVars(body: string): React.ReactNode {
  return body.split(/(\{\w+\})/g).map((part, i) => {
    const m = part.match(/^\{(\w+)\}$/);
    if (!m) return <span key={i}>{part}</span>;
    const known = KNOWN_PLACEHOLDERS.has(m[1]);
    return (
      <span
        key={i}
        title={known ? 'Filled in per business' : 'Unknown variable — will not resolve'}
        className={`rounded px-1 font-medium ${known ? 'bg-primary-500/10 text-primary-300' : 'bg-amber-500/10 text-amber-300'}`}
      >
        {part}
      </span>
    );
  });
}
