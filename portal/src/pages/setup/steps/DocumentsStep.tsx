/**
 * Step 5 — knowledge.
 *
 * The one step that cannot be skipped for a reason the customer can feel: a workspace
 * with nothing to read has an assistant that cannot answer anything, so letting someone
 * finish setup without a document only defers the disappointment to their first real
 * conversation.
 *
 * Reuses the product's own Add-document modal rather than a setup-only uploader, so what
 * they learn here is what they will use afterwards.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { FileText, Loader2, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import AddDocumentModal from '@/pages/knowledge/AddDocumentModal';
import { useKnowledgeDocuments } from '@/queries/useKnowledgeQueries';
import type { StepProps } from './types';

interface KnowledgeDoc {
  id: string;
  title: string;
  status: string;
}

export function DocumentsStep({ submit }: StepProps) {
  const { t } = useTranslation();
  const [adding, setAdding] = React.useState(false);
  const { data, isLoading } = useKnowledgeDocuments();
  const docs = (Array.isArray(data) ? data : []) as KnowledgeDoc[];

  return (
    <div className="space-y-6">
      <div className="space-y-1.5">
        <h2 className="text-xl font-semibold text-text-primary">
          {t('setup.steps.documents.title')}
        </h2>
        <p className="text-sm text-text-secondary">{t('setup.steps.documents.body')}</p>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-6">
          <Loader2 className="h-5 w-5 animate-spin text-text-muted" />
        </div>
      ) : docs.length === 0 ? (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="flex w-full flex-col items-center gap-2 rounded-xl border border-dashed border-edge bg-surface-2 px-6 py-10 text-center transition-colors hover:border-primary-500/50"
        >
          <Plus className="h-6 w-6 text-primary-400" />
          <span className="font-medium text-text-primary">{t('setup.steps.documents.add')}</span>
          <span className="text-xs text-text-muted">{t('setup.steps.documents.examples')}</span>
        </button>
      ) : (
        <div className="space-y-3">
          <ul className="divide-y divide-edge overflow-hidden rounded-xl border border-edge">
            {docs.slice(0, 5).map((doc) => (
              <li key={doc.id} className="flex items-center gap-3 bg-surface-2 px-4 py-3">
                <FileText className="h-4 w-4 shrink-0 text-primary-400" />
                <span className="min-w-0 flex-1 truncate text-sm text-text-primary">{doc.title}</span>
                {/* Indexing continues in the background; setup does not wait on it. */}
                <span className="text-xs text-text-muted">
                  {t(`setup.steps.documents.status.${doc.status}`, { defaultValue: doc.status })}
                </span>
              </li>
            ))}
          </ul>
          <Button variant="ghost" size="sm" onClick={() => setAdding(true)}>
            <Plus className="mr-1.5 h-4 w-4" />
            {t('setup.steps.documents.addAnother')}
          </Button>
        </div>
      )}

      <div className="flex justify-end">
        <Button
          size="lg"
          disabled={docs.length === 0 || submit.isPending}
          onClick={() => submit.mutate({ step: 'documents' })}
        >
          {submit.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {t('setup.continue')}
        </Button>
      </div>

      <AddDocumentModal isOpen={adding} onClose={() => setAdding(false)} />
    </div>
  );
}
