/**
 * Presentational atoms for the Bot Template editor. Every piece here is a pure
 * function of its props — no state of AdminBotTemplateDetail is captured, so this
 * stays a leaf module: it never imports AdminBotTemplateDetail.tsx.
 *
 * BlockKey, FieldHint and AuthorSection render <Tooltip>, so the parent tree must
 * still provide the single TooltipProvider ancestor.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Info, SlidersHorizontal } from 'lucide-react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { PLACEHOLDER_CATALOG } from '@contracts/prompt-placeholders';
import { getBlockInfo } from './template-constants';

// Tap-to-insert chips, straight off the catalog (label + description → tooltip).
const PLACEHOLDER_CHIPS = PLACEHOLDER_CATALOG.map((e) => `{${e.key}}`);
const PLACEHOLDER_HELP: Record<string, string> = Object.fromEntries(PLACEHOLDER_CATALOG.map((e) => [`{${e.key}}`, `${e.label} — ${e.description}`]));

/**
 * Tap-to-insert placeholder chips. In read-only mode it renders as a non-inserting
 * REFERENCE (so a viewer still sees which placeholders exist). Used under BOTH the
 * main prompt body and each module's prose editor — placeholders resolve in both.
 * `customChips` are the template's own custom variables ({placeholder}s the author
 * declared): rendered in amber (matching the Template-variables fields) to set them
 * apart from the built-ins, and clickable the same way.
 */
export function PlaceholderBar({
  readOnly,
  onInsert,
  customChips = [],
  onManage,
}: {
  readOnly: boolean;
  onInsert: (chip: string) => void;
  customChips?: string[];
  onManage?: () => void;
}) {
  const { t } = useTranslation();
  const builtinClass = readOnly
    ? 'cursor-default rounded-md border border-edge bg-surface-2 px-2 py-1 font-mono text-[11px] text-text-secondary'
    : 'rounded-md border border-edge bg-surface-2 px-2 py-1 font-mono text-[11px] text-text-secondary transition-colors hover:border-primary-400 hover:bg-primary-500/10 hover:text-primary-200';
  const customClass = readOnly
    ? 'cursor-default rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 font-mono text-[11px] text-amber-300'
    : 'rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 font-mono text-[11px] text-amber-300 transition-colors hover:border-amber-400 hover:bg-amber-500/20';
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-t border-edge/70 bg-surface-2/40 px-3 py-2">
      <span className="mr-1 text-[11px] font-medium text-text-muted">
        {t(readOnly ? 'admin.botTemplates.editor.availableLabel' : 'admin.botTemplates.editor.insertLabel')}
      </span>
      {PLACEHOLDER_CHIPS.map((p) => (
        <button
          key={p}
          type="button"
          disabled={readOnly}
          title={PLACEHOLDER_HELP[p]}
          className={builtinClass}
          onClick={readOnly ? undefined : () => onInsert(p)}
        >
          {p}
        </button>
      ))}
      {customChips.map((p) => (
        <button
          key={p}
          type="button"
          disabled={readOnly}
          title="Custom template variable"
          className={customClass}
          onClick={readOnly ? undefined : () => onInsert(p)}
        >
          {p}
        </button>
      ))}
      {!readOnly && onManage && customChips.length > 0 && (
        <button
          type="button"
          onClick={onManage}
          title="Set labels, defaults, and required for your custom variables"
          className="ml-0.5 inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-amber-300/90 transition-colors hover:bg-amber-500/10 hover:text-amber-200"
        >
          <SlidersHorizontal className="h-3 w-3" />Manage variables
        </button>
      )}
    </div>
  );
}

// A block key with a hover/focus tooltip explaining what it is.
export const BlockKey: React.FC<{ name: string }> = ({ name }) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <span className="cursor-help underline decoration-dotted decoration-text-tertiary/60 underline-offset-2">{name}</span>
    </TooltipTrigger>
    <TooltipContent className="max-w-[240px] font-sans text-xs">{getBlockInfo(name)}</TooltipContent>
  </Tooltip>
);

// A small field caption with an info tooltip — used to explain the template-variable
// fields (label / default / help / required), which aren't self-explanatory.
export const FieldHint: React.FC<{ label: string; tip: string }> = ({ label, tip }) => (
  <span className="mb-1 flex items-center gap-1 text-[11px] font-medium text-text-muted">
    {label}
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" tabIndex={-1} aria-label={`About ${label}`} className="cursor-help text-text-tertiary transition-colors hover:text-text-secondary">
          <Info className="h-3 w-3" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-[240px] font-sans text-xs">{tip}</TooltipContent>
    </Tooltip>
  </span>
);

// Section shell for the authoring canvas: a numbered icon-chip + title + optional
// helper and trailing action, with content indented under a connecting rail. Turns
// the long left column into legible, ordered steps instead of a flat stack of fields.
export const AuthorSection: React.FC<{
  step: number;
  icon: React.ElementType;
  title: string;
  hint?: React.ReactNode;
  action?: React.ReactNode;
  last?: boolean;
  children: React.ReactNode;
}> = ({ step, icon: Icon, title, hint, action, last, children }) => (
  <section className="relative grid grid-cols-[2rem_1fr] gap-x-4">
    <div className="flex flex-col items-center">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-primary-300 ring-1 ring-inset ring-edge">
        <Icon className="h-4 w-4" />
      </span>
      {!last && <span aria-hidden className="mt-1 w-px flex-1 bg-edge/70" />}
    </div>
    <div className={last ? '' : 'pb-8'}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-[11px] tabular-nums text-text-muted">{String(step).padStart(2, '0')}</span>
            <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
          </div>
          {hint && <p className="mt-1 max-w-prose text-xs leading-relaxed text-text-tertiary">{hint}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      <div className="mt-3">{children}</div>
    </div>
  </section>
);

// A compact grouping label for the live-preview rail (uppercase eyebrow + count).
export const RailLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="text-[10px] font-medium uppercase tracking-wider text-text-tertiary">{children}</div>
);
