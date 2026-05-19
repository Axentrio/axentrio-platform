import React, { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Download, X } from 'lucide-react';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { cn } from '@/lib/utils';
import { faqSections, FAQ_DOC_PATH, FAQ_DOC_FILENAME } from './helpFaqData';

interface BotInstructionsHelpDrawerProps {
  isOpen: boolean;
  onClose: () => void;
}

const SECTION_ID = 'ai-bot';

export const BotInstructionsHelpDrawer: React.FC<BotInstructionsHelpDrawerProps> = ({
  isOpen,
  onClose,
}) => {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const section = faqSections.find((s) => s.id === SECTION_ID) ?? faqSections[0];

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

  // Move focus to the close button on mount so screen readers announce
  // the panel and keyboard users have a stable starting point.
  useEffect(() => {
    if (isOpen) closeButtonRef.current?.focus();
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <aside
      role="dialog"
      aria-modal="false"
      aria-label="AI Bot — Frequently Asked Questions"
      className={cn(
        'fixed top-0 right-0 h-full w-full sm:max-w-md z-40',
        'bg-surface-2 border-l border-edge shadow-2xl',
        'flex flex-col',
      )}
    >
      <header className="flex items-center justify-between px-5 py-4 border-b border-edge">
        <div>
          <h2 className="text-sm font-semibold text-text-primary">AI Bot — FAQ</h2>
          <p className="text-[11px] text-text-muted mt-0.5">
            Common questions about bot instructions and behaviour
          </p>
        </div>
        <button
          ref={closeButtonRef}
          type="button"
          onClick={onClose}
          className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-surface-3 focus:outline-none focus:ring-2 focus:ring-primary-500/40"
          aria-label="Close FAQ"
        >
          <X className="w-4 h-4" />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-5 py-3">
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

      <footer className="px-5 py-4 border-t border-edge space-y-2">
        <Link
          to="/help?section=ai-bot"
          onClick={onClose}
          className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-xs font-medium text-primary-400 hover:bg-primary-500/10 transition-colors"
        >
          <span>Browse all FAQs</span>
          <ArrowRight className="w-3.5 h-3.5" />
        </Link>
        <a
          href={FAQ_DOC_PATH}
          download={FAQ_DOC_FILENAME}
          className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-xs font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary transition-colors"
        >
          <span>Download full FAQ (.docx)</span>
          <Download className="w-3.5 h-3.5" />
        </a>
      </footer>
    </aside>
  );
};

export default BotInstructionsHelpDrawer;
