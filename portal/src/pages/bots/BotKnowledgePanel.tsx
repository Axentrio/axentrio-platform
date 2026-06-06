/**
 * Per-bot knowledge management (multi-bot, "dedicated replaces shared").
 *
 * Shared mode: the bot uses the org-wide knowledge base (managed in the
 * Knowledge tab) — shows a CTA to give the bot its own knowledge.
 * Dedicated mode: the bot answers only from its own documents — add/list/delete
 * them here, or switch back to shared.
 */
import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BookOpen, Plus, Trash2, ArrowLeftRight, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { extractApiErrorMessage } from '@services/apiClient';
import {
  useBotKnowledge,
  useEnableDedicatedKb,
  useDisableDedicatedKb,
  useAddBotDocument,
  useDeleteBotDocument,
  type BotKnowledgeState,
} from '@/queries/useBotsQueries';
import { useUploadFile } from '@/queries/useKnowledgeQueries';

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive'> = {
  indexed: 'default',
  pending: 'secondary',
  processing: 'secondary',
  failed: 'destructive',
};

const BotKnowledgePanel: React.FC<{ botId: string; readOnly: boolean }> = ({ botId, readOnly }) => {
  const { t } = useTranslation();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, isLoading } = useBotKnowledge(botId) as { data: BotKnowledgeState | undefined; isLoading: boolean };
  const enable = useEnableDedicatedKb(botId);
  const disable = useDisableDedicatedKb(botId);
  const addDoc = useAddBotDocument(botId);
  const delDoc = useDeleteBotDocument(botId);
  const uploadFile = useUploadFile();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');

  const fail = (err: unknown, fallback: string) => toast.error(extractApiErrorMessage(err) ?? fallback);

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (e.target) e.target.value = ''; // allow re-selecting the same file
    if (!file) return;
    const lower = file.name.toLowerCase();
    const type = lower.endsWith('.pdf') ? 'pdf' : lower.endsWith('.docx') ? 'docx' : null;
    if (!type) {
      toast.error(t('bots.knowledge.errors.fileType'));
      return;
    }
    try {
      const res = (await uploadFile.mutateAsync(file)) as { uploadToken?: string };
      const token = res?.uploadToken;
      if (!token) throw new Error('no token');
      addDoc.mutate(
        { type, title: file.name, uploadToken: token },
        { onSuccess: () => toast.success(t('bots.knowledge.toast.added')), onError: (er) => fail(er, t('bots.knowledge.errors.addFailed')) },
      );
    } catch (er) {
      fail(er, t('bots.knowledge.errors.addFailed'));
    }
  };

  if (isLoading || !data) return <PageSkeleton variant="list" rows={3} />;

  if (data.mode === 'shared') {
    return (
      <Card variant="glass">
        <CardHeader>
          <div className="flex items-center gap-2">
            <BookOpen className="w-4 h-4 text-primary-400" />
            <h3 className="font-medium text-text-primary">{t('bots.knowledge.title')}</h3>
          </div>
          <p className="text-xs text-text-muted">{t('bots.knowledge.sharedDescription')}</p>
        </CardHeader>
        {!readOnly && (
          <CardContent>
            <Button
              onClick={() =>
                enable.mutate(undefined, { onError: (e) => fail(e, t('bots.knowledge.errors.generic')) })
              }
              disabled={enable.isPending}
              className="gap-1.5"
            >
              <ArrowLeftRight className="w-4 h-4" />
              {t('bots.knowledge.giveDedicated')}
            </Button>
          </CardContent>
        )}
      </Card>
    );
  }

  const handleAdd = () => {
    if (!title.trim() || !content.trim()) return;
    addDoc.mutate(
      { type: 'text', title: title.trim(), sourceContent: content.trim() },
      {
        onSuccess: () => {
          setTitle('');
          setContent('');
          toast.success(t('bots.knowledge.toast.added'));
        },
        onError: (e) => fail(e, t('bots.knowledge.errors.addFailed')),
      },
    );
  };

  return (
    <Card variant="glass">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <BookOpen className="w-4 h-4 text-primary-400" />
            <h3 className="font-medium text-text-primary">{t('bots.knowledge.dedicatedTitle')}</h3>
          </div>
          {!readOnly && (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                disable.mutate(undefined, { onError: (e) => fail(e, t('bots.knowledge.errors.generic')) })
              }
              disabled={disable.isPending}
              className="gap-1.5"
            >
              <ArrowLeftRight className="w-3.5 h-3.5" />
              {t('bots.knowledge.switchShared')}
            </Button>
          )}
        </div>
        <p className="text-xs text-text-muted">{t('bots.knowledge.dedicatedDescription')}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        {!readOnly && (
          <div className="space-y-2 rounded-lg bg-surface-2 p-3">
            <Label className="text-text-secondary">{t('bots.knowledge.addTitle')}</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('bots.knowledge.titlePlaceholder')}
            />
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={t('bots.knowledge.contentPlaceholder')}
              rows={4}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={handleAdd} disabled={addDoc.isPending || !title.trim() || !content.trim()} size="sm" className="gap-1.5">
                <Plus className="w-4 h-4" />
                {t('bots.knowledge.add')}
              </Button>
              <span className="text-xs text-text-muted">{t('bots.knowledge.or')}</span>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.docx"
                className="hidden"
                onChange={handleFile}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadFile.isPending || addDoc.isPending}
                className="gap-1.5"
              >
                <Upload className="w-4 h-4" />
                {uploadFile.isPending ? t('bots.knowledge.uploading') : t('bots.knowledge.uploadFile')}
              </Button>
            </div>
          </div>
        )}

        {data.documents.length === 0 ? (
          <p className="text-sm text-text-muted py-2">{t('bots.knowledge.empty')}</p>
        ) : (
          <ul className="divide-y divide-edge rounded-lg border border-edge">
            {data.documents.map((doc) => (
              <li key={doc.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="text-sm text-text-primary truncate">{doc.title}</span>
                <div className="flex items-center gap-2 shrink-0">
                  <Badge variant={STATUS_VARIANT[doc.status] ?? 'secondary'}>
                    {t(`bots.knowledge.status.${doc.status}`, { defaultValue: doc.status })}
                  </Badge>
                  {!readOnly && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-red-400 hover:text-red-300"
                      onClick={() =>
                        delDoc.mutate(doc.id, { onError: (e) => fail(e, t('bots.knowledge.errors.generic')) })
                      }
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
};

export default BotKnowledgePanel;
