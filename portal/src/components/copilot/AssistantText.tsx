/**
 * Assistant replies, with the links live.
 *
 * Copilot is told to point at screens as markdown links (`[Settings → Features]
 * (/settings/features)`) because naming a screen without a link makes the customer hunt
 * for it. Rendered as plain text, that instruction produces the opposite of the intent:
 * literal brackets and a path they have to retype.
 *
 * This renders LINKS ONLY, not markdown. The rest of the reply stays exactly as written,
 * whitespace and all. A full markdown renderer would reformat every existing answer, and
 * would mean sanitising model-authored HTML — a much larger surface for one feature that
 * needs one syntax.
 *
 * Two safety rules, both about where a link can send someone:
 *   - internal paths become in-app navigation, so the drawer keeps its conversation
 *   - anything else must be plain `http(s)`, opened in a new tab with `noopener`. A
 *     `javascript:` or `data:` target authored by a model is not a link, and is left as
 *     text rather than rendered.
 */
import React from 'react';
import { Link } from 'react-router-dom';

/**
 * `[label](target)` — label may not contain brackets, target may not contain spaces.
 *
 * Padding INSIDE the parentheses is tolerated and stripped. A model writes
 * `[AI & Content]( /ai)` often enough, and the strict form left that rendering as
 * literal brackets and a path the customer has to retype — the precise failure
 * this component exists to prevent. The target itself is still space-free, so
 * nothing about what counts as a valid destination changes; the safety checks
 * below see the same trimmed string either way.
 */
const LINK = /\[([^\]]+)\]\(\s*([^\s)]+)\s*\)/g;

const isInternal = (target: string) => target.startsWith('/') && !target.startsWith('//');
const isSafeExternal = (target: string) => /^https?:\/\//i.test(target);

export function AssistantText({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let key = 0;

  for (const match of text.matchAll(LINK)) {
    const [whole, label, target] = match;
    const start = match.index ?? 0;

    if (start > cursor) parts.push(text.slice(cursor, start));
    cursor = start + whole.length;

    if (isInternal(target)) {
      parts.push(
        <Link
          key={key++}
          to={target}
          className="font-medium text-primary-400 underline underline-offset-2 hover:text-primary-300"
        >
          {label}
        </Link>,
      );
    } else if (isSafeExternal(target)) {
      parts.push(
        <a
          key={key++}
          href={target}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-primary-400 underline underline-offset-2 hover:text-primary-300"
        >
          {label}
        </a>,
      );
    } else {
      // Not a link we are willing to render. Show what was written, unchanged.
      parts.push(whole);
    }
  }

  if (cursor < text.length) parts.push(text.slice(cursor));

  return <>{parts}</>;
}
