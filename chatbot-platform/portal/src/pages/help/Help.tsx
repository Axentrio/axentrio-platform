import React from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { HelpCircle } from 'lucide-react';
import FaqContent from './FaqContent';

const Help: React.FC = () => {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();

  // Section id from URL — FaqContent falls back to the first available
  // section if this is empty or doesn't match any known section.
  const activeSectionId = searchParams.get('section') ?? '';
  const query = searchParams.get('q') ?? '';

  const updateParams = (next: { section?: string; q?: string }) => {
    const params = new URLSearchParams(searchParams);
    if (next.section !== undefined) {
      if (next.section) params.set('section', next.section);
      else params.delete('section');
    }
    if (next.q !== undefined) {
      if (next.q) params.set('q', next.q);
      else params.delete('q');
    }
    setSearchParams(params, { replace: true });
  };

  return (
    <div className="h-full flex flex-col bg-surface-1">
      <div className="px-6 pt-6 pb-4 flex items-center gap-3 shrink-0">
        <div className="p-2 rounded-xl bg-primary-500/10">
          <HelpCircle className="w-5 h-5 text-primary-400" />
        </div>
        <div>
          <h1 className="text-lg font-semibold text-text-primary">{t('help.page.title')}</h1>
          <p className="text-xs text-text-muted">{t('help.page.subtitle')}</p>
        </div>
      </div>

      <div className="flex-1 min-h-0 mx-4 mb-4 border border-edge rounded-2xl bg-surface-2 overflow-hidden">
        <FaqContent
          className="h-full"
          activeSectionId={activeSectionId}
          onSectionChange={(id) => updateParams({ section: id })}
          query={query}
          onQueryChange={(q) => updateParams({ q })}
        />
      </div>
    </div>
  );
};

export default Help;
