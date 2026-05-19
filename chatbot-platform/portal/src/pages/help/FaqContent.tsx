import React, { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  faqSections,
  FAQ_DOC_PATH,
  FAQ_DOC_FILENAME,
  sectionTitleKey,
  itemQuestionKey,
  itemAnswerKey,
  type FaqItem,
  type FaqSection,
} from './helpFaqData';

export interface FaqContentProps {
  /** Currently-selected section id. */
  activeSectionId: string;
  onSectionChange: (id: string) => void;
  /** Search query. Empty string means "not searching". */
  query: string;
  onQueryChange: (q: string) => void;
  /** Whether to focus the search input when this component mounts. */
  autoFocusSearch?: boolean;
  /** Class names for the outer wrapper. */
  className?: string;
}

interface SearchHit {
  section: FaqSection;
  item: FaqItem;
  index: number;
  qText: string;
  aText: string;
}

const HIGHLIGHT_STYLE: React.CSSProperties = {
  backgroundColor: 'rgba(var(--color-primary-rgb, 99, 102, 241), 0.35)',
  color: 'inherit',
};

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const HighlightedText: React.FC<{ text: string; tokens: string[] }> = ({ text, tokens }) => {
  if (tokens.length === 0) return <>{text}</>;
  const pattern = new RegExp(`(${tokens.map(escapeRegex).join('|')})`, 'gi');
  const parts = text.split(pattern);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <span
            key={i}
            style={HIGHLIGHT_STYLE}
            className="rounded px-0.5 font-medium"
          >
            {part}
          </span>
        ) : (
          <React.Fragment key={i}>{part}</React.Fragment>
        ),
      )}
    </>
  );
};

export const FaqContent: React.FC<FaqContentProps> = ({
  activeSectionId,
  onSectionChange,
  query,
  onQueryChange,
  autoFocusSearch = false,
  className,
}) => {
  const { t } = useTranslation();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const trimmedQuery = query.trim();
  const tokens = useMemo(
    () =>
      trimmedQuery.length === 0
        ? []
        : trimmedQuery.toLowerCase().split(/\s+/).filter(Boolean),
    [trimmedQuery],
  );
  const isSearching = tokens.length > 0;
  const activeSection =
    faqSections.find((s) => s.id === activeSectionId) ?? faqSections[0];

  const searchHits = useMemo<SearchHit[]>(() => {
    if (!isSearching) return [];
    const hits: SearchHit[] = [];
    for (const section of faqSections) {
      section.items.forEach((item, index) => {
        const qText = t(itemQuestionKey(section.id, item.id));
        const aText = t(itemAnswerKey(section.id, item.id));
        const haystack = `${qText} ${aText}`.toLowerCase();
        if (tokens.every((tok) => haystack.includes(tok))) {
          hits.push({ section, item, index, qText, aText });
        }
      });
    }
    return hits;
  }, [isSearching, tokens, t]);

  const matchesBySection = useMemo<Record<string, number>>(() => {
    if (!isSearching) return {};
    return searchHits.reduce<Record<string, number>>((acc, hit) => {
      acc[hit.section.id] = (acc[hit.section.id] ?? 0) + 1;
      return acc;
    }, {});
  }, [isSearching, searchHits]);

  // Keys for all current hits — used to auto-expand the accordion so users
  // can scan answers without clicking through each result.
  const allHitKeys = useMemo(
    () => searchHits.map((h) => `hit-${h.section.id}-${h.index}`),
    [searchHits],
  );

  useEffect(() => {
    if (autoFocusSearch && searchInputRef.current) {
      // Defer so it runs after any dialog/portal mount transitions.
      const ms = window.setTimeout(() => searchInputRef.current?.focus(), 0);
      return () => window.clearTimeout(ms);
    }
  }, [autoFocusSearch]);

  const handlePickSection = (id: string) => {
    onQueryChange('');
    onSectionChange(id);
  };

  return (
    <div className={cn('flex flex-col', className)}>
      {/* Search + Download row */}
      <div className="flex items-center gap-3 px-6 py-3 border-b border-edge">
        <div className="relative flex-1">
          <Search
            className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted pointer-events-none"
            aria-hidden="true"
          />
          <Input
            ref={searchInputRef}
            type="search"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder={t('help.search.placeholder')}
            aria-label={t('help.search.ariaLabel')}
            className="pl-9 pr-9"
          />
          {isSearching && (
            <button
              type="button"
              onClick={() => onQueryChange('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-text-muted hover:text-text-primary hover:bg-surface-3"
              aria-label={t('help.search.clearAriaLabel')}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <Button asChild variant="outline" size="sm" className="shrink-0 gap-1.5">
          <a
            href={FAQ_DOC_PATH}
            download={FAQ_DOC_FILENAME}
            title={t('help.download.title')}
          >
            <Download className="w-3.5 h-3.5" />
            {t('help.download.button')}
          </a>
        </Button>
      </div>

      <div className="flex flex-col md:flex-row flex-1 min-h-0">
        {/* Sidebar (desktop) */}
        <aside className="hidden md:flex md:w-56 shrink-0 border-r border-edge flex-col">
          <nav className="flex-1 overflow-y-auto p-2">
            <ul className="space-y-0.5">
              {faqSections.map((s) => {
                const isActive = !isSearching && s.id === activeSection.id;
                const count = matchesBySection[s.id];
                const dim = isSearching && !count;
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => handlePickSection(s.id)}
                      className={cn(
                        'w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-colors',
                        isActive
                          ? 'bg-primary-500/10 text-primary-400'
                          : 'text-text-secondary hover:bg-surface-3 hover:text-text-primary',
                        dim && 'opacity-50',
                      )}
                    >
                      <span className="truncate text-left">{t(sectionTitleKey(s.id))}</span>
                      {isSearching && count ? (
                        <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-primary-500/15 text-primary-400">
                          {count}
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>
        </aside>

        {/* Content pane */}
        <main className="flex-1 flex flex-col min-w-0">
          {/* Mobile section picker (hidden while searching to avoid confusion) */}
          {!isSearching && (
            <div className="md:hidden p-4 border-b border-edge">
              <Select value={activeSection.id} onValueChange={onSectionChange}>
                <SelectTrigger aria-label={t('help.mobile.chooseSection')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {faqSections.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {t(sectionTitleKey(s.id))}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {isSearching ? (
            <SearchResultsPane
              hits={searchHits}
              tokens={tokens}
              query={trimmedQuery}
              expandedKeys={allHitKeys}
            />
          ) : (
            <SectionPane section={activeSection} />
          )}
        </main>
      </div>
    </div>
  );
};

const SectionPane: React.FC<{ section: FaqSection }> = ({ section }) => {
  const { t } = useTranslation();
  return (
    <>
      <div className="px-6 pt-5 pb-3 border-b border-edge">
        <h3 className="text-sm font-semibold text-text-primary truncate">
          {t(sectionTitleKey(section.id))}
        </h3>
        <p className="text-xs text-text-muted mt-0.5">
          {t('help.section.questionCount', { count: section.items.length })}
        </p>
      </div>
      <div className="flex-1 overflow-y-auto px-6 py-4">
        <Accordion type="single" collapsible className="w-full">
          {section.items.map((item) => (
            <AccordionItem
              key={`${section.id}-${item.id}`}
              value={`${section.id}-${item.id}`}
              className="border-edge last:border-b-0"
            >
              <AccordionTrigger className="text-sm text-text-primary text-left hover:no-underline py-3">
                {t(itemQuestionKey(section.id, item.id))}
              </AccordionTrigger>
              <AccordionContent className="text-sm text-text-secondary leading-relaxed">
                {t(itemAnswerKey(section.id, item.id))}
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </>
  );
};

interface SearchResultsPaneProps {
  hits: SearchHit[];
  tokens: string[];
  query: string;
  expandedKeys: string[];
}

const SearchResultsPane: React.FC<SearchResultsPaneProps> = ({
  hits,
  tokens,
  query,
  expandedKeys,
}) => {
  const { t } = useTranslation();
  return (
    <>
      <div className="px-6 pt-5 pb-3 border-b border-edge">
        <h3 className="text-sm font-semibold text-text-primary truncate">
          {t('help.search.title')}
        </h3>
        <p className="text-xs text-text-muted mt-0.5">
          {hits.length === 0
            ? t('help.search.noMatches', { query })
            : t('help.search.matches', { count: hits.length, query })}
        </p>
      </div>
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {hits.length === 0 ? (
          <div className="text-sm text-text-muted py-8 text-center">
            {t('help.search.tryDifferent')}
          </div>
        ) : (
          <Accordion
            key={query}
            type="multiple"
            defaultValue={expandedKeys}
            className="w-full"
          >
            {hits.map((hit, i) => (
              <AccordionItem
                key={`hit-${hit.section.id}-${hit.index}-${i}`}
                value={`hit-${hit.section.id}-${hit.index}`}
                className="border-edge last:border-b-0"
              >
                <AccordionTrigger className="text-sm text-left hover:no-underline py-3">
                  <div className="flex-1 min-w-0 pr-3">
                    <div className="text-[10px] uppercase tracking-wide text-text-muted mb-0.5">
                      {t(sectionTitleKey(hit.section.id))}
                    </div>
                    <div className="text-text-primary">
                      <HighlightedText text={hit.qText} tokens={tokens} />
                    </div>
                  </div>
                </AccordionTrigger>
                <AccordionContent className="text-sm text-text-secondary leading-relaxed">
                  <HighlightedText text={hit.aText} tokens={tokens} />
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        )}
      </div>
    </>
  );
};

export default FaqContent;
