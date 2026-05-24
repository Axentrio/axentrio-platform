/**
 * Admin FAQ Editor
 * Super-admin surface for the platform-wide Help FAQ.
 *
 * Two-pane layout:
 *   - Sections list on the left (reorderable; "reserved" sections can't be deleted)
 *   - Items of the selected section on the right
 *
 * All edits hit the /api/v1/faq endpoints; reads share the same React Query
 * cache key as the public /help page and BotInstructionsHelpDrawer.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  GripVertical,
  HelpCircle,
  Loader2,
  Lock,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine';
import {
  attachClosestEdge,
  extractClosestEdge,
  type Edge,
} from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';
import { DropIndicator } from '@atlaskit/pragmatic-drag-and-drop-react-drop-indicator/box';
import { pickTranslation } from '@/pages/help/helpFaqData';
import {
  useFaq,
  useCreateFaqSection,
  useUpdateFaqSection,
  useDeleteFaqSection,
  useCreateFaqItem,
  useUpdateFaqItem,
  useDeleteFaqItem,
  useReorderFaq,
  type FaqItem,
  type FaqSection,
  type FaqTranslation,
} from '@/queries/useFaqQueries';
import { extractApiErrorMessage } from '@/services/apiClient';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

const LANGS = ['en', 'nl', 'fr'] as const;

const KEBAB_RE = /^[a-z]([a-z0-9-]*[a-z0-9])?$/;

const emptyTranslation: FaqTranslation = { en: '' };

function showApiError(error: unknown, fallback: string): void {
  const message = extractApiErrorMessage(error) ?? fallback;
  toast.error(message);
}

/* ---------------------------- Drag & drop -------------------------------- */

// Discriminated drag payloads. The `kind` keeps section-drags from landing on
// item rows and vice versa, and lets the global monitor route drops correctly.
const SECTION_KIND = 'faq-section' as const;
const ITEM_KIND = 'faq-item' as const;

interface SectionDragData extends Record<string | symbol, unknown> {
  kind: typeof SECTION_KIND;
  id: string;
}
interface ItemDragData extends Record<string | symbol, unknown> {
  kind: typeof ITEM_KIND;
  id: string;
  sectionId: string;
}

const isSectionDragData = (d: Record<string | symbol, unknown>): d is SectionDragData =>
  d.kind === SECTION_KIND;
const isItemDragData = (d: Record<string | symbol, unknown>): d is ItemDragData =>
  d.kind === ITEM_KIND;

/**
 * Wires a row element as both a draggable source and a drop target, with
 * closest-edge hitboxes ('top' / 'bottom'). Returns the state needed to
 * render the row (dim while dragging, highlight the active drop edge).
 */
function useSortableRow(
  data: SectionDragData | ItemDragData,
): {
  ref: (el: HTMLElement | null) => void;
  isDragging: boolean;
  closestEdge: Edge | null;
} {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [closestEdge, setClosestEdge] = useState<Edge | null>(null);

  useEffect(() => {
    if (!el) return;
    return combine(
      draggable({
        element: el,
        getInitialData: () => ({ ...data }),
        onDragStart: () => setIsDragging(true),
        onDrop: () => setIsDragging(false),
      }),
      dropTargetForElements({
        element: el,
        canDrop: ({ source }) =>
          source.data.kind === data.kind && source.data.id !== data.id,
        getData: ({ input, element }) =>
          attachClosestEdge(
            { ...data },
            { input, element, allowedEdges: ['top', 'bottom'] },
          ),
        getIsSticky: () => true,
        onDrag: ({ self, source }) => {
          if (source.data.id === data.id) return;
          setClosestEdge(extractClosestEdge(self.data));
        },
        onDragLeave: () => setClosestEdge(null),
        onDrop: () => setClosestEdge(null),
      }),
    );
  }, [el, data]);

  return { ref: setEl, isDragging, closestEdge };
}

/**
 * Apply a "move source to closest-edge of target" reorder against a flat
 * list. Returns a new array. Source and target must both exist; the move is
 * a no-op when the requested destination equals the source's current index.
 */
function reorderByEdge<T extends { id: string }>(
  list: T[],
  sourceId: string,
  targetId: string,
  edge: Edge,
): T[] | null {
  const srcIdx = list.findIndex((x) => x.id === sourceId);
  const tgtIdx = list.findIndex((x) => x.id === targetId);
  if (srcIdx < 0 || tgtIdx < 0 || srcIdx === tgtIdx) return null;
  let destIdx = tgtIdx + (edge === 'bottom' ? 1 : 0);
  if (srcIdx < destIdx) destIdx -= 1;
  if (destIdx === srcIdx) return null;
  const next = [...list];
  const [moved] = next.splice(srcIdx, 1);
  next.splice(destIdx, 0, moved);
  return next;
}

const AdminFaqEditor: React.FC = () => {
  const { t } = useTranslation();
  const { data, isLoading, isError } = useFaq();
  const reorder = useReorderFaq();

  const sections = useMemo(() => data?.sections ?? [], [data]);
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null);

  useEffect(() => {
    if (sections.length === 0) {
      setActiveSectionId(null);
      return;
    }
    if (!sections.some((s) => s.id === activeSectionId)) {
      setActiveSectionId(sections[0].id);
    }
  }, [sections, activeSectionId]);

  const activeSection = sections.find((s) => s.id === activeSectionId) ?? null;

  /* ---------------------------- Section modals --------------------------- */
  const [sectionDialog, setSectionDialog] = useState<
    | { mode: 'create' }
    | { mode: 'edit'; section: FaqSection }
    | null
  >(null);
  const [sectionToDelete, setSectionToDelete] = useState<FaqSection | null>(null);

  /* ----------------------------- Item modals ----------------------------- */
  const [itemDialog, setItemDialog] = useState<
    | { mode: 'create'; sectionId: string }
    | { mode: 'edit'; item: FaqItem }
    | null
  >(null);
  const [itemToDelete, setItemToDelete] = useState<FaqItem | null>(null);

  /* ----------------------------- Reordering ------------------------------ */
  // Swap-pair only: send the two affected rows, not the whole list. With
  // optimistic updates in useReorderFaq the UI flips immediately and the
  // backend only does 2 UPDATEs per click instead of N.
  const moveSection = (sectionId: string, direction: -1 | 1) => {
    const idx = sections.findIndex((s) => s.id === sectionId);
    const targetIdx = idx + direction;
    if (idx < 0 || targetIdx < 0 || targetIdx >= sections.length) return;

    const a = sections[idx];
    const b = sections[targetIdx];
    reorder.mutate(
      {
        sections: [
          { id: a.id, position: b.position },
          { id: b.id, position: a.position },
        ],
      },
      { onError: (e) => showApiError(e, t('admin.faq.errors.reorder')) }
    );
  };

  const moveItem = (item: FaqItem, direction: -1 | 1) => {
    if (!activeSection) return;
    const items = activeSection.items;
    const idx = items.findIndex((i) => i.id === item.id);
    const targetIdx = idx + direction;
    if (idx < 0 || targetIdx < 0 || targetIdx >= items.length) return;

    const a = items[idx];
    const b = items[targetIdx];
    reorder.mutate(
      {
        items: [
          { id: a.id, sectionId: activeSection.id, position: b.position },
          { id: b.id, sectionId: activeSection.id, position: a.position },
        ],
      },
      { onError: (e) => showApiError(e, t('admin.faq.errors.reorder')) }
    );
  };

  // Latest values for the drop monitor — keeps the monitor armed once
  // without re-subscribing on every render.
  const sectionsRef = useRef(sections);
  const activeSectionRef = useRef(activeSection);
  useEffect(() => {
    sectionsRef.current = sections;
  }, [sections]);
  useEffect(() => {
    activeSectionRef.current = activeSection;
  }, [activeSection]);

  /* -------------------------- Drag-and-drop monitor ----------------------- */
  useEffect(() => {
    return monitorForElements({
      canMonitor: ({ source }) =>
        isSectionDragData(source.data) || isItemDragData(source.data),
      onDrop: ({ source, location }) => {
        const target = location.current.dropTargets[0];
        if (!target) return;
        const edge = extractClosestEdge(target.data);
        if (!edge) return;

        if (isSectionDragData(source.data) && isSectionDragData(target.data)) {
          const next = reorderByEdge(
            sectionsRef.current,
            source.data.id,
            target.data.id,
            edge,
          );
          if (!next) return;
          reorder.mutate(
            { sections: next.map((s, i) => ({ id: s.id, position: i })) },
            { onError: (e) => showApiError(e, t('admin.faq.errors.reorder')) },
          );
          return;
        }

        if (isItemDragData(source.data) && isItemDragData(target.data)) {
          const active = activeSectionRef.current;
          if (!active) return;
          // Only within-section reorder; cross-section moves go through Edit.
          if (
            source.data.sectionId !== active.id ||
            target.data.sectionId !== active.id
          ) {
            return;
          }
          const next = reorderByEdge(
            active.items,
            source.data.id,
            target.data.id,
            edge,
          );
          if (!next) return;
          reorder.mutate(
            {
              items: next.map((it, i) => ({
                id: it.id,
                sectionId: active.id,
                position: i,
              })),
            },
            { onError: (e) => showApiError(e, t('admin.faq.errors.reorder')) },
          );
        }
      },
    });
  }, [reorder, t]);

  /* -------------------------------- Render ------------------------------- */
  return (
    <div className="h-full flex flex-col bg-surface-1">
      <div className="px-6 pt-6 pb-4 flex items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-primary-500/10">
            <HelpCircle className="w-5 h-5 text-primary-400" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-text-primary">
              {t('admin.faq.title')}
            </h1>
            <p className="text-xs text-text-muted">{t('admin.faq.subtitle')}</p>
          </div>
        </div>
        <Button onClick={() => setSectionDialog({ mode: 'create' })} className="gap-1.5">
          <Plus className="w-3.5 h-3.5" />
          {t('admin.faq.newSection')}
        </Button>
      </div>

      {isLoading ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="w-5 h-5 animate-spin text-text-muted" />
        </div>
      ) : isError ? (
        <div className="flex-1 flex items-center justify-center text-sm text-text-muted">
          {t('admin.faq.errors.load')}
        </div>
      ) : (
        <div className="flex-1 min-h-0 mx-4 mb-4 grid grid-cols-1 md:grid-cols-[16rem_1fr] gap-4">
          <TooltipProvider>
            <SectionsList
              sections={sections}
              activeSectionId={activeSectionId}
              onSelect={setActiveSectionId}
              onEdit={(s) => setSectionDialog({ mode: 'edit', section: s })}
              onDelete={(s) => setSectionToDelete(s)}
              onMove={moveSection}
            />
            <ItemsPane
              section={activeSection}
              onNewItem={(sectionId) => setItemDialog({ mode: 'create', sectionId })}
              onEditSection={(s) => setSectionDialog({ mode: 'edit', section: s })}
              onEditItem={(i) => setItemDialog({ mode: 'edit', item: i })}
              onDeleteItem={(i) => setItemToDelete(i)}
              onMoveItem={moveItem}
            />
          </TooltipProvider>
        </div>
      )}

      {sectionDialog && (
        <SectionDialog
          state={sectionDialog}
          existingIds={sections.map((s) => s.id)}
          onClose={() => setSectionDialog(null)}
        />
      )}

      {itemDialog && (
        <ItemDialog
          state={itemDialog}
          existingSlugs={
            itemDialog.mode === 'create'
              ? sections.find((s) => s.id === itemDialog.sectionId)?.items.map((i) => i.slug) ?? []
              : sections.find((s) => s.id === itemDialog.item.sectionId)?.items
                  .filter((i) => i.id !== itemDialog.item.id)
                  .map((i) => i.slug) ?? []
          }
          onClose={() => setItemDialog(null)}
        />
      )}

      {sectionToDelete && (
        <DeleteSectionDialog
          section={sectionToDelete}
          onClose={() => setSectionToDelete(null)}
        />
      )}

      {itemToDelete && (
        <DeleteItemDialog
          item={itemToDelete}
          onClose={() => setItemToDelete(null)}
        />
      )}
    </div>
  );
};

export default AdminFaqEditor;

/* ========================================================================= */
/*  Sections list                                                            */
/* ========================================================================= */

interface SectionsListProps {
  sections: FaqSection[];
  activeSectionId: string | null;
  onSelect: (id: string) => void;
  onEdit: (s: FaqSection) => void;
  onDelete: (s: FaqSection) => void;
  onMove: (id: string, direction: -1 | 1) => void;
}

const SectionsList: React.FC<SectionsListProps> = ({
  sections,
  activeSectionId,
  onSelect,
  onEdit,
  onDelete,
  onMove,
}) => {
  const { t } = useTranslation();
  if (sections.length === 0) {
    return (
      <aside className="border border-edge rounded-2xl bg-surface-2 p-4 text-xs text-text-muted">
        {t('admin.faq.emptySections')}
      </aside>
    );
  }
  return (
    <aside className="border border-edge rounded-2xl bg-surface-2 overflow-hidden flex flex-col">
      <ul className="flex-1 overflow-y-auto p-2 space-y-0.5">
        {sections.map((s, idx) => (
          <SortableSectionRow
            key={s.id}
            section={s}
            isActive={s.id === activeSectionId}
            isFirst={idx === 0}
            isLast={idx === sections.length - 1}
            onSelect={onSelect}
            onEdit={onEdit}
            onDelete={onDelete}
            onMove={onMove}
          />
        ))}
      </ul>
    </aside>
  );
};

interface SortableSectionRowProps {
  section: FaqSection;
  isActive: boolean;
  isFirst: boolean;
  isLast: boolean;
  onSelect: (id: string) => void;
  onEdit: (s: FaqSection) => void;
  onDelete: (s: FaqSection) => void;
  onMove: (id: string, direction: -1 | 1) => void;
}

const SortableSectionRow: React.FC<SortableSectionRowProps> = ({
  section: s,
  isActive,
  isFirst,
  isLast,
  onSelect,
  onEdit,
  onDelete,
  onMove,
}) => {
  const { t } = useTranslation();
  const dragData = useMemo<SectionDragData>(
    () => ({ kind: SECTION_KIND, id: s.id }),
    [s.id],
  );
  const { ref, isDragging, closestEdge } = useSortableRow(dragData);

  return (
    <li>
      <div
        ref={ref}
        className={cn(
          'relative group flex items-center gap-1 rounded-lg px-1.5 py-1.5 transition-opacity',
          isActive ? 'bg-primary-500/10' : 'hover:bg-surface-3',
          isDragging && 'opacity-40',
        )}
      >
        <span
          className="shrink-0 p-0.5 text-text-muted opacity-40 group-hover:opacity-100 cursor-grab active:cursor-grabbing"
          aria-hidden="true"
          title={t('admin.faq.dragHandle')}
        >
          <GripVertical className="w-3.5 h-3.5" />
        </span>
        <button
          type="button"
          onClick={() => onSelect(s.id)}
          className="flex-1 min-w-0 text-left"
        >
          <div className="flex items-center gap-1.5">
            <span
              className={cn(
                'text-xs font-medium truncate',
                isActive ? 'text-primary-400' : 'text-text-secondary',
              )}
            >
              {s.titles.en}
            </span>
            {s.isReserved && <Lock className="w-3 h-3 shrink-0 text-text-muted" />}
          </div>
          <div className="text-[10px] text-text-muted mt-0.5">
            {t('admin.faq.itemsCount', { count: s.items.length })}
          </div>
        </button>
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
          <IconButton
            aria-label={t('admin.faq.moveUp')}
            disabled={isFirst}
            onClick={() => onMove(s.id, -1)}
          >
            <ArrowUp className="w-3 h-3" />
          </IconButton>
          <IconButton
            aria-label={t('admin.faq.moveDown')}
            disabled={isLast}
            onClick={() => onMove(s.id, 1)}
          >
            <ArrowDown className="w-3 h-3" />
          </IconButton>
          <IconButton aria-label={t('admin.faq.edit')} onClick={() => onEdit(s)}>
            <Pencil className="w-3 h-3" />
          </IconButton>
          {s.isReserved ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <IconButton aria-label={t('admin.faq.delete')} disabled>
                    <Trash2 className="w-3 h-3" />
                  </IconButton>
                </span>
              </TooltipTrigger>
              <TooltipContent>{t('admin.faq.reservedTooltip')}</TooltipContent>
            </Tooltip>
          ) : (
            <IconButton aria-label={t('admin.faq.delete')} onClick={() => onDelete(s)}>
              <Trash2 className="w-3 h-3" />
            </IconButton>
          )}
        </div>
        {closestEdge && <DropIndicator edge={closestEdge} gap="2px" />}
      </div>
    </li>
  );
};

/* ========================================================================= */
/*  Items pane                                                               */
/* ========================================================================= */

interface ItemsPaneProps {
  section: FaqSection | null;
  onNewItem: (sectionId: string) => void;
  onEditSection: (s: FaqSection) => void;
  onEditItem: (i: FaqItem) => void;
  onDeleteItem: (i: FaqItem) => void;
  onMoveItem: (i: FaqItem, direction: -1 | 1) => void;
}

const ItemsPane: React.FC<ItemsPaneProps> = ({
  section,
  onNewItem,
  onEditSection,
  onEditItem,
  onDeleteItem,
  onMoveItem,
}) => {
  const { t } = useTranslation();
  // Expansion state lives here so the "expand all" toggle can flip every row
  // at once, and so the chevron resets cleanly when the section changes.
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());

  // Reset expansion whenever the section changes — different items, fresh
  // collapsed state. Using section.id as the trigger.
  useEffect(() => {
    setExpandedIds(new Set());
  }, [section?.id]);

  if (!section) {
    return (
      <main className="border border-edge rounded-2xl bg-surface-2 flex items-center justify-center text-xs text-text-muted">
        {t('admin.faq.pickSection')}
      </main>
    );
  }
  const reservedSingleton = section.isReserved && section.items.length <= 1;
  const anyExpanded = expandedIds.size > 0;
  const toggleItem = (id: string) =>
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () =>
    setExpandedIds(anyExpanded ? new Set() : new Set(section.items.map((i) => i.id)));

  return (
    <main className="border border-edge rounded-2xl bg-surface-2 overflow-hidden flex flex-col">
      {/* Section header — visually distinct from the items list below. */}
      <div className="px-5 pt-5 pb-4 border-b-2 border-edge bg-gradient-to-b from-primary-500/[0.04] to-transparent flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wider font-semibold text-text-muted mb-1.5">
            {t('admin.faq.sectionEyebrow')}
          </div>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-text-primary truncate">
              {section.titles.en}
            </h2>
            {section.isReserved && (
              <Badge variant="outline" className="gap-1 text-[10px] shrink-0">
                <Lock className="w-2.5 h-2.5" />
                {t('admin.faq.reserved')}
              </Badge>
            )}
          </div>
          <div className="text-[11px] text-text-muted mt-2 flex items-center gap-2">
            <code className="px-1.5 py-0.5 rounded bg-surface-3 text-text-secondary">
              {section.id}
            </code>
            <span aria-hidden="true">·</span>
            <span>{t('admin.faq.itemsCount', { count: section.items.length })}</span>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onEditSection(section)}
            className="gap-1.5"
            title={t('admin.faq.editSection')}
          >
            <Pencil className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">{t('admin.faq.editSection')}</span>
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={toggleAll}
            disabled={section.items.length === 0}
            className="gap-1.5"
            title={anyExpanded ? t('admin.faq.collapseAll') : t('admin.faq.expandAll')}
          >
            {anyExpanded ? (
              <ChevronUp className="w-3.5 h-3.5" />
            ) : (
              <ChevronDown className="w-3.5 h-3.5" />
            )}
            <span className="hidden sm:inline">
              {anyExpanded ? t('admin.faq.collapseAll') : t('admin.faq.expandAll')}
            </span>
          </Button>
          <Button size="sm" onClick={() => onNewItem(section.id)} className="gap-1.5">
            <Plus className="w-3.5 h-3.5" />
            {t('admin.faq.newItem')}
          </Button>
        </div>
      </div>

      <ul className="flex-1 overflow-y-auto p-3 space-y-2">
        {section.items.length === 0 && (
          <li className="p-6 text-xs text-text-muted text-center">{t('admin.faq.emptyItems')}</li>
        )}
        {section.items.map((it, idx) => (
          <SortableItemRow
            key={it.id}
            item={it}
            sectionId={section.id}
            isFirst={idx === 0}
            isLast={idx === section.items.length - 1}
            reservedSingleton={reservedSingleton}
            isExpanded={expandedIds.has(it.id)}
            onToggleExpand={() => toggleItem(it.id)}
            onEdit={onEditItem}
            onDelete={onDeleteItem}
            onMove={onMoveItem}
          />
        ))}
      </ul>
    </main>
  );
};

interface SortableItemRowProps {
  item: FaqItem;
  sectionId: string;
  isFirst: boolean;
  isLast: boolean;
  reservedSingleton: boolean;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onEdit: (i: FaqItem) => void;
  onDelete: (i: FaqItem) => void;
  onMove: (i: FaqItem, direction: -1 | 1) => void;
}

const SortableItemRow: React.FC<SortableItemRowProps> = ({
  item: it,
  sectionId,
  isFirst,
  isLast,
  reservedSingleton,
  isExpanded,
  onToggleExpand,
  onEdit,
  onDelete,
  onMove,
}) => {
  const { t, i18n } = useTranslation();
  const dragData = useMemo<ItemDragData>(
    () => ({ kind: ITEM_KIND, id: it.id, sectionId }),
    [it.id, sectionId],
  );
  const { ref, isDragging, closestEdge } = useSortableRow(dragData);
  const answerText = pickTranslation(it.answer, i18n.language);

  return (
    <li
      ref={ref}
      className={cn(
        'relative group flex items-start gap-2 px-3 py-2.5 rounded-lg border border-edge bg-surface-3/40 hover:bg-surface-3 transition-opacity transition-colors',
        isDragging && 'opacity-40',
      )}
    >
      <span
        className="shrink-0 mt-0.5 p-0.5 text-text-muted opacity-40 group-hover:opacity-100 cursor-grab active:cursor-grabbing"
        aria-hidden="true"
        title={t('admin.faq.dragHandle')}
      >
        <GripVertical className="w-3.5 h-3.5" />
      </span>
      <button
        type="button"
        onClick={onToggleExpand}
        aria-expanded={isExpanded}
        aria-label={isExpanded ? t('admin.faq.collapseAnswer') : t('admin.faq.expandAnswer')}
        className="shrink-0 mt-0.5 p-0.5 rounded text-text-muted hover:text-text-primary hover:bg-surface-3"
      >
        {isExpanded ? (
          <ChevronDown className="w-3.5 h-3.5" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5" />
        )}
      </button>
      <div className="flex-1 min-w-0">
        <div className="text-sm text-text-primary truncate">{it.question.en}</div>
        <div className="flex items-center gap-2 mt-0.5">
          <div className="text-[10px] text-text-muted font-mono truncate">{it.slug}</div>
          <TranslationStatus question={it.question} answer={it.answer} />
        </div>
        {isExpanded && (
          <div className="mt-2 pt-2 border-t border-edge text-xs text-text-secondary leading-relaxed whitespace-pre-wrap">
            {answerText}
          </div>
        )}
      </div>
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
        <IconButton
          aria-label={t('admin.faq.moveUp')}
          disabled={isFirst}
          onClick={() => onMove(it, -1)}
        >
          <ArrowUp className="w-3 h-3" />
        </IconButton>
        <IconButton
          aria-label={t('admin.faq.moveDown')}
          disabled={isLast}
          onClick={() => onMove(it, 1)}
        >
          <ArrowDown className="w-3 h-3" />
        </IconButton>
        <IconButton aria-label={t('admin.faq.edit')} onClick={() => onEdit(it)}>
          <Pencil className="w-3 h-3" />
        </IconButton>
        {reservedSingleton ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <IconButton aria-label={t('admin.faq.delete')} disabled>
                  <Trash2 className="w-3 h-3" />
                </IconButton>
              </span>
            </TooltipTrigger>
            <TooltipContent>{t('admin.faq.reservedSingletonTooltip')}</TooltipContent>
          </Tooltip>
        ) : (
          <IconButton aria-label={t('admin.faq.delete')} onClick={() => onDelete(it)}>
            <Trash2 className="w-3 h-3" />
          </IconButton>
        )}
      </div>
      {closestEdge && <DropIndicator edge={closestEdge} gap="8px" />}
    </li>
  );
};

/* ========================================================================= */
/*  Reusable button                                                          */
/* ========================================================================= */

const IconButton: React.FC<
  React.ButtonHTMLAttributes<HTMLButtonElement> & { children: React.ReactNode }
> = ({ className, children, ...rest }) => (
  <button
    type="button"
    className={cn(
      'p-1 rounded text-text-muted hover:text-text-primary hover:bg-surface-3 disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-not-allowed',
      className
    )}
    {...rest}
  >
    {children}
  </button>
);

/**
 * Three small lang chips (EN · NL · FR) showing per-language Q+A completeness.
 * EN is always full opacity (backend enforces non-empty `en`); NL/FR dim when
 * either question or answer is missing/empty in that language. Hover for an
 * explanatory tooltip.
 */
const TranslationStatus: React.FC<{ question: FaqTranslation; answer: FaqTranslation }> = ({
  question,
  answer,
}) => {
  const { t } = useTranslation();
  const isComplete = (lang: 'en' | 'nl' | 'fr') =>
    Boolean(question[lang]?.trim()) && Boolean(answer[lang]?.trim());
  return (
    <div className="flex items-center gap-1 shrink-0" aria-label={t('admin.faq.translationStatus')}>
      {(['en', 'nl', 'fr'] as const).map((lang) => {
        const complete = isComplete(lang);
        const label = complete
          ? t('admin.faq.translation.complete', { lang: lang.toUpperCase() })
          : t('admin.faq.translation.missing', { lang: lang.toUpperCase() });
        return (
          <Tooltip key={lang}>
            <TooltipTrigger asChild>
              <span
                className={cn(
                  'text-[9px] font-mono font-semibold uppercase px-1 py-0.5 rounded',
                  complete
                    ? 'bg-primary-500/15 text-primary-400'
                    : 'bg-surface-3 text-text-muted line-through opacity-60',
                )}
              >
                {lang}
              </span>
            </TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
};

/* ========================================================================= */
/*  Section dialog                                                           */
/* ========================================================================= */

interface SectionDialogProps {
  state: { mode: 'create' } | { mode: 'edit'; section: FaqSection };
  existingIds: string[];
  onClose: () => void;
}

const SectionDialog: React.FC<SectionDialogProps> = ({ state, existingIds, onClose }) => {
  const { t } = useTranslation();
  const createMutation = useCreateFaqSection();
  const updateMutation = useUpdateFaqSection();

  const isCreate = state.mode === 'create';
  const original = isCreate ? null : state.section;

  const [id, setId] = useState(original?.id ?? '');
  const [titles, setTitles] = useState<FaqTranslation>(original?.titles ?? emptyTranslation);
  const [idError, setIdError] = useState<string | null>(null);

  const validateId = (value: string): string | null => {
    if (!value) return t('admin.faq.errors.idRequired');
    if (value.length > 64) return t('admin.faq.errors.idTooLong');
    if (!KEBAB_RE.test(value)) return t('admin.faq.errors.idKebab');
    if (existingIds.includes(value)) return t('admin.faq.errors.idExists');
    return null;
  };

  const handleSubmit = () => {
    if (!titles.en?.trim()) {
      toast.error(t('admin.faq.errors.enTitleRequired'));
      return;
    }
    if (isCreate) {
      const err = validateId(id);
      if (err) {
        setIdError(err);
        return;
      }
      createMutation.mutate(
        { id, titles },
        {
          onSuccess: () => {
            toast.success(t('admin.faq.created.section'));
            onClose();
          },
          onError: (e) => showApiError(e, t('admin.faq.errors.save')),
        }
      );
    } else {
      updateMutation.mutate(
        { id: original!.id, titles },
        {
          onSuccess: () => {
            toast.success(t('admin.faq.saved'));
            onClose();
          },
          onError: (e) => showApiError(e, t('admin.faq.errors.save')),
        }
      );
    }
  };

  const isSaving = createMutation.isPending || updateMutation.isPending;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {isCreate ? t('admin.faq.dialog.newSection') : t('admin.faq.dialog.editSection')}
          </DialogTitle>
          <DialogDescription>
            {isCreate
              ? t('admin.faq.dialog.newSectionDescription')
              : t('admin.faq.dialog.editSectionDescription')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {isCreate && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-text-secondary">
                {t('admin.faq.fields.id')}
              </label>
              <Input
                value={id}
                onChange={(e) => {
                  setId(e.target.value);
                  if (idError) setIdError(null);
                }}
                placeholder="getting-started"
                aria-invalid={!!idError}
              />
              <p className={cn('text-[10px]', idError ? 'text-red-400' : 'text-text-muted')}>
                {idError ?? t('admin.faq.fields.idHelp')}
              </p>
            </div>
          )}

          <TranslationTabs
            label={t('admin.faq.fields.title')}
            value={titles}
            onChange={setTitles}
            inputType="input"
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isSaving}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={isSaving}>
            {isSaving && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/* ========================================================================= */
/*  Item dialog                                                              */
/* ========================================================================= */

interface ItemDialogProps {
  state: { mode: 'create'; sectionId: string } | { mode: 'edit'; item: FaqItem };
  existingSlugs: string[];
  onClose: () => void;
}

const ItemDialog: React.FC<ItemDialogProps> = ({ state, existingSlugs, onClose }) => {
  const { t } = useTranslation();
  const createMutation = useCreateFaqItem();
  const updateMutation = useUpdateFaqItem();

  const isCreate = state.mode === 'create';
  const original = isCreate ? null : state.item;

  const [slug, setSlug] = useState(original?.slug ?? '');
  const [question, setQuestion] = useState<FaqTranslation>(
    original?.question ?? emptyTranslation
  );
  const [answer, setAnswer] = useState<FaqTranslation>(original?.answer ?? emptyTranslation);
  const [slugError, setSlugError] = useState<string | null>(null);

  const validateSlug = (value: string): string | null => {
    if (!value) return t('admin.faq.errors.slugRequired');
    if (value.length > 80) return t('admin.faq.errors.slugTooLong');
    if (!KEBAB_RE.test(value)) return t('admin.faq.errors.slugKebab');
    if (existingSlugs.includes(value)) return t('admin.faq.errors.slugExists');
    return null;
  };

  const handleSubmit = () => {
    if (!question.en?.trim()) {
      toast.error(t('admin.faq.errors.enQuestionRequired'));
      return;
    }
    if (!answer.en?.trim()) {
      toast.error(t('admin.faq.errors.enAnswerRequired'));
      return;
    }
    const err = validateSlug(slug);
    if (err) {
      setSlugError(err);
      return;
    }
    if (isCreate) {
      createMutation.mutate(
        { sectionId: state.sectionId, slug, question, answer },
        {
          onSuccess: () => {
            toast.success(t('admin.faq.created.item'));
            onClose();
          },
          onError: (e) => showApiError(e, t('admin.faq.errors.save')),
        }
      );
    } else {
      updateMutation.mutate(
        { id: original!.id, slug, question, answer },
        {
          onSuccess: () => {
            toast.success(t('admin.faq.saved'));
            onClose();
          },
          onError: (e) => showApiError(e, t('admin.faq.errors.save')),
        }
      );
    }
  };

  const isSaving = createMutation.isPending || updateMutation.isPending;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {isCreate ? t('admin.faq.dialog.newItem') : t('admin.faq.dialog.editItem')}
          </DialogTitle>
          <DialogDescription>{t('admin.faq.dialog.itemDescription')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-text-secondary">
              {t('admin.faq.fields.slug')}
            </label>
            <Input
              value={slug}
              onChange={(e) => {
                setSlug(e.target.value);
                if (slugError) setSlugError(null);
              }}
              placeholder="what-is-handsoff"
              aria-invalid={!!slugError}
            />
            <p className={cn('text-[10px]', slugError ? 'text-red-400' : 'text-text-muted')}>
              {slugError ?? t('admin.faq.fields.slugHelp')}
            </p>
          </div>

          <TranslationTabs
            label={t('admin.faq.fields.question')}
            value={question}
            onChange={setQuestion}
            inputType="input"
          />

          <TranslationTabs
            label={t('admin.faq.fields.answer')}
            value={answer}
            onChange={setAnswer}
            inputType="textarea"
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isSaving}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={isSaving}>
            {isSaving && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/* ========================================================================= */
/*  Translation tabs (shared)                                                */
/* ========================================================================= */

interface TranslationTabsProps {
  label: string;
  value: FaqTranslation;
  onChange: (next: FaqTranslation) => void;
  inputType: 'input' | 'textarea';
}

const TranslationTabs: React.FC<TranslationTabsProps> = ({
  label,
  value,
  onChange,
  inputType,
}) => {
  const { t } = useTranslation();
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-text-secondary">{label}</label>
      <Tabs defaultValue="en">
        <TabsList>
          {LANGS.map((lang) => (
            <TabsTrigger key={lang} value={lang}>
              {t(`admin.faq.langs.${lang}`)}
              {lang === 'en' && <span className="ml-1 text-red-400">*</span>}
            </TabsTrigger>
          ))}
        </TabsList>
        {LANGS.map((lang) => (
          <TabsContent key={lang} value={lang} className="mt-2">
            {inputType === 'input' ? (
              <Input
                value={value[lang] ?? ''}
                onChange={(e) => onChange({ ...value, [lang]: e.target.value })}
                placeholder={
                  lang !== 'en' ? t('admin.faq.fields.optionalPlaceholder') : undefined
                }
              />
            ) : (
              <Textarea
                value={value[lang] ?? ''}
                onChange={(e) => onChange({ ...value, [lang]: e.target.value })}
                rows={6}
                placeholder={
                  lang !== 'en' ? t('admin.faq.fields.optionalPlaceholder') : undefined
                }
              />
            )}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
};

/* ========================================================================= */
/*  Delete confirm dialogs                                                   */
/* ========================================================================= */

const DeleteSectionDialog: React.FC<{ section: FaqSection; onClose: () => void }> = ({
  section,
  onClose,
}) => {
  const { t } = useTranslation();
  const mutation = useDeleteFaqSection();
  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('admin.faq.dialog.deleteSectionTitle')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('admin.faq.dialog.deleteSectionDescription', { title: section.titles.en })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={mutation.isPending}>
            {t('common.cancel')}
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={mutation.isPending}
            className="bg-red-600 hover:bg-red-700"
            onClick={(e) => {
              e.preventDefault();
              mutation.mutate(section.id, {
                onSuccess: () => {
                  toast.success(t('admin.faq.deleted.section'));
                  onClose();
                },
                onError: (err) => showApiError(err, t('admin.faq.errors.delete')),
              });
            }}
          >
            {mutation.isPending && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
            {t('common.delete')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

const DeleteItemDialog: React.FC<{ item: FaqItem; onClose: () => void }> = ({
  item,
  onClose,
}) => {
  const { t } = useTranslation();
  const mutation = useDeleteFaqItem();
  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('admin.faq.dialog.deleteItemTitle')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('admin.faq.dialog.deleteItemDescription', { question: item.question.en })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={mutation.isPending}>
            {t('common.cancel')}
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={mutation.isPending}
            className="bg-red-600 hover:bg-red-700"
            onClick={(e) => {
              e.preventDefault();
              mutation.mutate(item.id, {
                onSuccess: () => {
                  toast.success(t('admin.faq.deleted.item'));
                  onClose();
                },
                onError: (err) => showApiError(err, t('admin.faq.errors.delete')),
              });
            }}
          >
            {mutation.isPending && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
            {t('common.delete')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
