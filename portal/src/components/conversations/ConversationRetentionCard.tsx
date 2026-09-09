/**
 * Conversation retention control.
 *
 * Deliberately blunt copy. This schedules irreversible deletion of customer
 * conversations, so the UI states what will happen and that it cannot be undone —
 * rather than presenting it as a tidy-up preference.
 *
 * "Keep everything" is the default and the first option, because that is the
 * current behaviour for every existing tenant and no upgrade should quietly
 * change it.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Trash2, Loader2 } from 'lucide-react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { api } from '@/services/apiClient';
import { useAppAuth } from '@auth/useAppAuth';

interface RetentionResponse {
  retentionDays: number | null;
  minDays: number;
  maxDays: number;
}

/** Offered periods. `null` (keep) is first and is the default. */
const OPTIONS: Array<{ value: number | null; labelKey: string; fallback: string }> = [
  { value: null, labelKey: 'conversations.retention.keep', fallback: 'Keep everything' },
  { value: 180, labelKey: 'conversations.retention.6m', fallback: '6 months' },
  { value: 365, labelKey: 'conversations.retention.1y', fallback: '1 year' },
  { value: 730, labelKey: 'conversations.retention.2y', fallback: '2 years' },
];

export const ConversationRetentionCard: React.FC = () => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { isRole } = useAppAuth();
  const isAdmin = isRole(['admin', 'super_admin']);
  const [confirming, setConfirming] = useState<number | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['chats', 'retention'],
    queryFn: () => api.get<RetentionResponse>('/chats/retention'),
  });

  const save = useMutation({
    mutationFn: (retentionDays: number | null) =>
      api.put<RetentionResponse>('/chats/retention', { retentionDays }),
    onSuccess: () => {
      toast.success(
        t('conversations.retention.saved', { defaultValue: 'Retention updated' }),
      );
      setConfirming(null);
      void qc.invalidateQueries({ queryKey: ['chats', 'retention'] });
    },
    onError: () =>
      toast.error(
        t('conversations.retention.error', { defaultValue: 'Could not update retention' }),
      ),
  });

  if (isLoading || !data) return null;
  const current = data.retentionDays;

  return (
    <Card>
      <CardHeader>
        <h2 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
          <Trash2 className="h-4 w-4 text-text-muted" />
          {t('conversations.retention.title', { defaultValue: 'How long to keep conversations' })}
        </h2>
        <p className="mt-1 text-xs text-text-secondary">
          {t('conversations.retention.body', {
            defaultValue:
              'Conversations with no activity for longer than this are permanently deleted, along with their messages and attachments. This cannot be undone. Deletion is measured from the last message, so a conversation your customer keeps returning to never expires.',
          })}
        </p>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-center gap-1.5">
          {OPTIONS.map((opt) => {
            const active = current === opt.value;
            const needsConfirm = opt.value !== null && !active;
            return (
              <Button
                key={String(opt.value)}
                size="sm"
                variant={active ? 'default' : 'outline'}
                aria-pressed={active}
                disabled={!isAdmin || save.isPending}
                onClick={() => {
                  // Choosing a period schedules deletion, so it asks first. Choosing
                  // "keep everything" only ever makes the policy safer — no prompt.
                  if (needsConfirm) setConfirming(opt.value);
                  else save.mutate(opt.value);
                }}
              >
                {save.isPending && confirming === opt.value && (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                )}
                {t(opt.labelKey, { defaultValue: opt.fallback })}
              </Button>
            );
          })}
        </div>

        {confirming !== null && (
          <div className="mt-3 rounded-lg border border-status-away/40 bg-status-away/10 p-3">
            <p className="text-xs text-text-primary">
              {t('conversations.retention.confirm', {
                defaultValue:
                  'Delete conversations idle for more than {{days}} days, starting tonight? This runs every day from now on and cannot be undone.',
                days: confirming,
              })}
            </p>
            <div className="mt-2 flex gap-2">
              <Button size="sm" variant="destructive" onClick={() => save.mutate(confirming)}>
                {t('conversations.retention.confirmYes', { defaultValue: 'Yes, delete old conversations' })}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setConfirming(null)}>
                {t('common.cancel', { defaultValue: 'Cancel' })}
              </Button>
            </div>
          </div>
        )}

        {!isAdmin && (
          <p className="mt-2 text-xs text-text-muted">
            {t('conversations.retention.adminOnly', {
              defaultValue: 'Only workspace admins can change this.',
            })}
          </p>
        )}
      </CardContent>
    </Card>
  );
};
