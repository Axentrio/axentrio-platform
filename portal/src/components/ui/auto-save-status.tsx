import React from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Check, AlertTriangle } from 'lucide-react';
import type { AutoSaveStatus } from '@/hooks/useAutoSave';

interface AutoSaveStatusIndicatorProps {
  status: AutoSaveStatus;
  onRetry?: () => void;
  className?: string;
}

export const AutoSaveStatusIndicator: React.FC<AutoSaveStatusIndicatorProps> = ({
  status,
  onRetry,
  className = '',
}) => {
  const { t } = useTranslation();

  if (status === 'idle') {
    // Keep the row height stable so neighbouring layout doesn't jump
    // when the indicator transitions in/out.
    return <div className={`h-5 ${className}`} aria-hidden="true" />;
  }

  return (
    <output
      className={`flex items-center gap-1.5 text-xs h-5 ${className}`}
      aria-live="polite"
    >
      {status === 'saving' && (
        <>
          <Loader2 className="w-3.5 h-3.5 animate-spin text-text-muted" />
          <span className="text-text-muted">{t('autoSave.saving')}</span>
        </>
      )}
      {status === 'saved' && (
        <>
          <Check className="w-3.5 h-3.5 text-emerald-400" />
          <span className="text-text-muted">{t('autoSave.saved')}</span>
        </>
      )}
      {status === 'error' && (
        <>
          <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
          <span className="text-text-secondary">{t('autoSave.failed')}</span>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="text-primary-400 hover:text-primary-300 underline underline-offset-2"
            >
              {t('autoSave.retry')}
            </button>
          )}
        </>
      )}
    </output>
  );
};

