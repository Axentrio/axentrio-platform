import React, { useMemo, useState } from 'react';
import { Download, Search, X } from 'lucide-react';
import { Modal } from '@/components/Modal';
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
  type FaqItem,
  type FaqSection,
} from './helpFaqData';

interface HelpFaqDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** Section id to open the dialog on. Defaults to AI Bot Configuration. */
  defaultSectionId?: string;
}

interface SearchHit {
  section: FaqSection;
  item: FaqItem;
  index: number;
}

// Inline highlight style — uses rgba directly so we don't rely on Tailwind
// opacity modifiers against the hex-valued `--color-primary-500` CSS variable
// (which silently fail). `color: inherit` keeps the text readable in both
// light and dark mode and prevents the browser's `<mark>` default from
// bleeding through.
const HIGHLIGHT_STYLE: React.CSSProperties = {
  backgroundColor: 'rgba(var(--color-primary-rgb, 99, 102, 241), 0.35)',
  color: 'inherit',
};

const HighlightedText: React.FC<{ text: string; query: string }> = ({ text, query }) => {
  if (!query) return <>{text}</>;
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  const parts: React.ReactNode[] = [];
  let i = 0;
  while (i < text.length) {
    const hit = lower.indexOf(needle, i);
    if (hit === -1) {
      parts.push(text.slice(i));
      break;
    }
    if (hit > i) parts.push(text.slice(i, hit));
    parts.push(
      <span
        key={`${hit}-${parts.length}`}
        style={HIGHLIGHT_STYLE}
        className="rounded px-0.5 font-medium"
      >
        {text.slice(hit, hit + needle.length)}
      </span>,
    );
    i = hit + needle.length;
  }
  return <>{parts}</>;
};

export const HelpFaqDialog: React.FC<HelpFaqDialogProps> = ({
  isOpen,
  onClose,
  defaultSectionId = 'ai-bot',
}) => {
  const [activeId, setActiveId] = useState<string>(defaultSectionId);
  const [query, setQuery] = useState('');

  const trimmedQuery = query.trim();
  const isSearching = trimmedQuery.length > 0;
  const activeSection =
    faqSections.find((s) => s.id === activeId) ?? faqSections[0];

  const searchHits = useMemo<SearchHit[]>(() => {
    if (!isSearching) return [];
    const needle = trimmedQuery.toLowerCase();
    const hits: SearchHit[] = [];
    for (const section of faqSections) {
      section.items.forEach((item, index) => {
        if (
          item.q.toLowerCase().includes(needle) ||
          item.a.toLowerCase().includes(needle)
        ) {
          hits.push({ section, item, index });
        }
      });
    }
    return hits;
  }, [isSearching, trimmedQuery]);

  const matchesBySection = useMemo<Record<string, number>>(() => {
    if (!isSearching) return {};
    return searchHits.reduce<Record<string, number>>((acc, hit) => {
      acc[hit.section.id] = (acc[hit.section.id] ?? 0) + 1;
      return acc;
    }, {});
  }, [isSearching, searchHits]);

  const handlePickSection = (id: string) => {
    setQuery('');
    setActiveId(id);
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="HandsOff — Frequently Asked Questions" size="xl">
      <div className="flex flex-col -m-6">
        {/* Search + Download row */}
        <div className="flex items-center gap-3 px-6 py-3 border-b border-edge">
          <div className="relative flex-1">
            <Search
              className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted pointer-events-none"
              aria-hidden="true"
            />
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search all FAQs…"
              aria-label="Search FAQs"
              className="pl-9 pr-9"
            />
            {isSearching && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-text-muted hover:text-text-primary hover:bg-surface-3"
                aria-label="Clear search"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <Button asChild variant="outline" size="sm" className="shrink-0 gap-1.5">
            <a
              href={FAQ_DOC_PATH}
              download={FAQ_DOC_FILENAME}
              title="Download the full FAQ document (.docx)"
            >
              <Download className="w-3.5 h-3.5" />
              Download FAQ
            </a>
          </Button>
        </div>

        <div className="flex flex-col md:flex-row md:min-h-[55vh] md:max-h-[65vh]">
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
                        <span className="truncate text-left">{s.title}</span>
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
                <Select value={activeSection.id} onValueChange={setActiveId}>
                  <SelectTrigger aria-label="Choose a section">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {faqSections.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {isSearching ? (
              <SearchResultsPane hits={searchHits} query={trimmedQuery} />
            ) : (
              <SectionPane section={activeSection} />
            )}
          </main>
        </div>
      </div>
    </Modal>
  );
};

const SectionPane: React.FC<{ section: FaqSection }> = ({ section }) => (
  <>
    <div className="px-6 pt-5 pb-3 border-b border-edge">
      <h3 className="text-sm font-semibold text-text-primary truncate">
        {section.title}
      </h3>
      <p className="text-xs text-text-muted mt-0.5">
        {section.items.length} question{section.items.length === 1 ? '' : 's'}
      </p>
    </div>
    <div className="flex-1 overflow-y-auto px-6 py-4">
      <Accordion type="single" collapsible className="w-full">
        {section.items.map((item, i) => (
          <AccordionItem
            key={`${section.id}-${i}`}
            value={`${section.id}-${i}`}
            className="border-edge last:border-b-0"
          >
            <AccordionTrigger className="text-sm text-text-primary text-left hover:no-underline py-3">
              {item.q}
            </AccordionTrigger>
            <AccordionContent className="text-sm text-text-secondary leading-relaxed">
              {item.a}
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </div>
  </>
);

const SearchResultsPane: React.FC<{ hits: SearchHit[]; query: string }> = ({
  hits,
  query,
}) => (
  <>
    <div className="px-6 pt-5 pb-3 border-b border-edge">
      <h3 className="text-sm font-semibold text-text-primary truncate">
        Search results
      </h3>
      <p className="text-xs text-text-muted mt-0.5">
        {hits.length === 0
          ? `No matches for "${query}"`
          : `${hits.length} match${hits.length === 1 ? '' : 'es'} for "${query}"`}
      </p>
    </div>
    <div className="flex-1 overflow-y-auto px-6 py-4">
      {hits.length === 0 ? (
        <div className="text-sm text-text-muted py-8 text-center">
          Try a different keyword, or download the full FAQ document.
        </div>
      ) : (
        <Accordion type="multiple" className="w-full">
          {hits.map((hit, i) => (
            <AccordionItem
              key={`hit-${hit.section.id}-${hit.index}-${i}`}
              value={`hit-${hit.section.id}-${hit.index}-${i}`}
              className="border-edge last:border-b-0"
            >
              <AccordionTrigger className="text-sm text-left hover:no-underline py-3">
                <div className="flex-1 min-w-0 pr-3">
                  <div className="text-[10px] uppercase tracking-wide text-text-muted mb-0.5">
                    {hit.section.title}
                  </div>
                  <div className="text-text-primary">
                    <HighlightedText text={hit.item.q} query={query} />
                  </div>
                </div>
              </AccordionTrigger>
              <AccordionContent className="text-sm text-text-secondary leading-relaxed">
                <HighlightedText text={hit.item.a} query={query} />
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      )}
    </div>
  </>
);

export default HelpFaqDialog;
