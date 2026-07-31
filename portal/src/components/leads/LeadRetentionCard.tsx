/**
 * Lead retention control.
 *
 * Deliberately blunt copy. This schedules irreversible erasure of customer records, so
 * the UI states what will happen, what is exempt, and that it cannot be undone — rather
 * than presenting it as a tidy-up preference.
 *
 * "Keep everything" is the default and the first option, because that is the current
 * behaviour for every existing tenant and no upgrade should quietly change it.
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
  { value: null, labelKey: 'leads.retention.keep', fallback: 'Keep everything' },
  { value: 180, labelKey: 'leads.retention.6m', fallback: '6 months' },
  { value: 365, labelKey: 'leads.retention.1y', fallback: '1 year' },
  { value: 730, labelKey: 'leads.retention.2y', fallback: '2 years' },
];

export const LeadRetentionCard: React.FC = () => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { isRole } = useAppAuth();
  const isAdmin = isRole(['admin', 'super_admin']);
  const [confirming, setConfirming] = useState<number | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['leads', 'retention'],
    queryFn: () => api.get<RetentionResponse>('/leads/retention'),
  });

  const save = useMutation({
    mutationFn: (retentionDays: number | null) =>
      api.put<RetentionResponse>('/leads/retention', { retentionDays }),
    onSuccess: () => {
      toast.success(t('leads.retention.saved', { defaultValue: 'Retention updated' }));
      setConfirming(null);
      void qc.invalidateQueries({ queryKey: ['leads', 'retention'] });
    },
    onError: () => toast.error(t('leads.retention.error', { defaultValue: 'Could not update retention' })),
  });

  if (isLoading || !data) return null;
  const current = data.retentionDays;

  return (
    <Card>
      <CardHeader>
        <h2 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
          <Trash2 className="h-4 w-4 text-text-muted" />
          {t('leads.retention.title', { defaultValue: 'How long to keep leads' })}
        </h2>
        <p className="mt-1 text-xs text-text-secondary">
          {t('leads.retention.body', {
            defaultValue:
              'Leads older than this have their name, contact details and request permanently erased, and any connected system is told to delete its copy. This cannot be undone. Leads with an upcoming appointment, or that you have scored yourself, are never removed.',
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
              {t('leads.retention.confirm', {
                defaultValue:
                  'Erase leads older than {{days}} days, starting tonight? This runs every day from now on and cannot be undone.',
                days: confirming,
              })}
            </p>
            <div className="mt-2 flex gap-2">
              <Button size="sm" variant="destructive" onClick={() => save.mutate(confirming)}>
                {t('leads.retention.confirmYes', { defaultValue: 'Yes, erase old leads' })}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setConfirming(null)}>
                {t('common.cancel', { defaultValue: 'Cancel' })}
              </Button>
            </div>
          </div>
        )}

        {!isAdmin && (
          <p className="mt-2 text-xs text-text-muted">
            {t('leads.retention.adminOnly', { defaultValue: 'Only workspace admins can change this.' })}
          </p>
        )}
      </CardContent>
    </Card>
  );
};
