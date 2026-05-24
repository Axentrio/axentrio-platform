import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowRight, Loader2, X } from 'lucide-react';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { cn } from '@/lib/utils';
import { useFaq } from '@/queries/useFaqQueries';
import { pickTranslation } from './helpFaqData';

interface BotInstructionsHelpDrawerProps {
  isOpen: boolean;
  onClose: () => void;
}

const SECTION_ID = 'ai-bot';

export const BotInstructionsHelpDrawer: React.FC<BotInstructionsHelpDrawerProps> = ({
  isOpen,
  onClose,
}) => {
  const { t, i18n } = useTranslation();
  const { data, isLoading, isError, refetch } = useFaq();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const section = data?.sections.find((s) => s.id === SECTION_ID);

  // ESC to close. Intentionally non-modal: no focus trap, no scroll lock, no
  // click-outside handler — the form behind the drawer stays fully usable so
  // the user can read an answer and adjust the field in one motion.
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (isOpen) closeButtonRef.current?.focus();
  }, [isOpen]);

  if (!isOpen) return null;

  return createPortal(
    <aside
      role="dialog"
      aria-modal="false"
      aria-label={t('help.drawer.ariaLabel')}
      className={cn(
        'fixed top-0 right-0 h-screen w-full sm:max-w-md z-40',
        'bg-surface-2 border-l border-edge shadow-2xl',
        'flex flex-col',
      )}
    >
      <header className="flex items-center justify-between px-5 py-4 border-b border-edge">
        <div>
          <h2 className="text-sm font-semibold text-text-primary">{t('help.drawer.title')}</h2>
          <p className="text-[11px] text-text-muted mt-0.5">{t('help.drawer.subtitle')}</p>
        </div>
        <button
          ref={closeButtonRef}
          type="button"
          onClick={onClose}
          className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-surface-3 focus:outline-none focus:ring-2 focus:ring-primary-500/40"
          aria-label={t('help.drawer.closeLabel')}
        >
          <X className="w-4 h-4" />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-5 py-3">
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-5 h-5 animate-spin text-text-muted" aria-hidden="true" />
            <span className="sr-only">{t('help.loading')}</span>
          </div>
        ) : isError ? (
          <div className="flex flex-col items-center gap-2 py-12 text-sm">
            <p className="text-text-muted">{t('help.error.load')}</p>
            <button
              type="button"
              onClick={() => refetch()}
              className="px-3 py-1.5 rounded-lg text-xs font-medium text-primary-400 hover:bg-primary-500/10"
            >
              {t('help.error.retry')}
            </button>
          </div>
        ) : !section || section.items.length === 0 ? (
          <div className="py-12 text-sm text-text-muted text-center">{t('help.empty')}</div>
        ) : (
          <Accordion type="single" collapsible className="w-full">
            {section.items.map((item) => (
              <AccordionItem
                key={item.id}
                value={item.id}
                className="border-edge last:border-b-0"
              >
                <AccordionTrigger className="text-sm text-text-primary text-left hover:no-underline py-3">
                  {pickTranslation(item.question, i18n.language)}
                </AccordionTrigger>
                <AccordionContent className="text-sm text-text-secondary leading-relaxed whitespace-pre-wrap">
                  {pickTranslation(item.answer, i18n.language)}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        )}
      </div>

      <footer className="px-5 py-4 border-t border-edge">
        <Link
          to="/help?section=ai-bot"
          onClick={onClose}
          className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-xs font-medium text-primary-400 hover:bg-primary-500/10 transition-colors"
        >
          <span>{t('help.drawer.browseAll')}</span>
          <ArrowRight className="w-3.5 h-3.5" />
        </Link>
      </footer>
    </aside>,
    document.body,
  );
};

export default BotInstructionsHelpDrawer;
