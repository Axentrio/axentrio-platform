/**
 * Outbound event webhooks — the tenant-facing half of Story 3's CRM integration.
 *
 * Deliberately framed as "send your leads to your CRM", not "CRM sync": this is a
 * one-way push of `lead.created` / `lead.updated` / `lead.deleted` to a URL, which
 * reaches HubSpot, Salesforce, Odoo, Zoho or Pipedrive today through Zapier/Make/n8n.
 * Calling it sync would imply bidirectional reconciliation that does not exist.
 *
 * `lead.deleted` is opt-outable but pre-checked with an explanation, because a CRM that
 * received a lead and never hears about its erasure leaves the tenant unable to honour
 * a deletion request end-to-end.
 *
 * The signing secret is write-only: the API returns `hasSecret`, never the value.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Webhook, Plus, Trash2, Loader2, Lock } from 'lucide-react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { api } from '@/services/apiClient';
import { useIsEntitled } from '@/queries/useEntitlementsQueries';

interface WebhookRow {
  url: string;
  events: string[];
  enabled: boolean;
  hasSecret: boolean;
  /** Local-only: a secret the user just typed (never returned by the API). */
  secret?: string;
}

interface WebhooksResponse {
  webhooks: WebhookRow[];
  subscribableEvents: string[];
  maxEndpoints: number;
}

const LEAD_EVENTS = ['lead.created', 'lead.updated', 'lead.deleted'];

export const EventWebhooksCard: React.FC = () => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const entitled = useIsEntitled('crm');
  const [draft, setDraft] = useState<WebhookRow[] | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['event-webhooks'],
    queryFn: () => api.get<WebhooksResponse>('/tenants/me/event-webhooks'),
    enabled: entitled,
  });

  const save = useMutation({
    mutationFn: (webhooks: WebhookRow[]) =>
      api.put('/tenants/me/event-webhooks', {
        webhooks: webhooks.map((w) => ({
          url: w.url,
          events: w.events,
          enabled: w.enabled,
          // Omit unless the user typed one, so an untouched endpoint KEEPS its secret
          // (the API never returns it, so sending undefined would otherwise blank it).
          ...(w.secret ? { secret: w.secret } : {}),
        })),
      }),
    onSuccess: () => {
      toast.success(t('settings.webhooks.saved', { defaultValue: 'Webhooks saved' }));
      setDraft(null);
      void qc.invalidateQueries({ queryKey: ['event-webhooks'] });
    },
    onError: (err: unknown) => {
      // The API validates the URL at write time (https only, no private/internal
      // targets), so surface its reason rather than a generic failure.
      const message =
        (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error?.message ??
        t('settings.webhooks.error', { defaultValue: 'Could not save webhooks' });
      toast.error(message);
    },
  });

  if (!entitled) return null;

  const rows = draft ?? data?.webhooks ?? [];
  const maxEndpoints = data?.maxEndpoints ?? 5;
  const dirty = draft !== null;

  const update = (i: number, patch: Partial<WebhookRow>) =>
    setDraft(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const toggleEvent = (i: number, event: string) => {
    const row = rows[i];
    const events = row.events.includes(event)
      ? row.events.filter((e) => e !== event)
      : [...row.events, event];
    update(i, { events });
  };

  return (
    <Card variant="glass">
      <CardHeader>
        <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
          <Webhook className="w-5 h-5" />
          {t('settings.webhooks.title', { defaultValue: 'Send leads to your CRM' })}
        </h2>
        <p className="text-sm text-text-secondary mt-1">
          {t('settings.webhooks.subtitle', {
            defaultValue:
              'Push new and updated leads to any URL — connect HubSpot, Salesforce, Odoo, Zoho or Pipedrive via Zapier, Make or n8n. This is a one-way send, not a two-way sync.',
          })}
        </p>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-text-secondary">{t('common.loading')}</p>
        ) : (
          <div className="space-y-4">
            {rows.length === 0 && (
              <p className="text-sm text-text-muted">
                {t('settings.webhooks.empty', { defaultValue: 'No endpoints yet.' })}
              </p>
            )}

            {rows.map((row, i) => (
              <div key={i} className="rounded-lg border border-edge p-3 space-y-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <Input
                    value={row.url}
                    placeholder="https://hooks.zapier.com/…"
                    onChange={(e) => update(i, { url: e.target.value })}
                    className="w-full flex-1"
                  />
                  <div className="flex items-center gap-2">
                    <Switch checked={row.enabled} onCheckedChange={(v) => update(i, { enabled: v })} />
                    <button
                      type="button"
                      aria-label={t('settings.webhooks.remove', { defaultValue: 'Remove endpoint' })}
                      className="rounded p-2 text-text-muted hover:bg-surface-3 hover:text-destructive"
                      onClick={() => setDraft(rows.filter((_, idx) => idx !== i))}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                <div className="flex flex-wrap gap-1.5">
                  {LEAD_EVENTS.map((event) => (
                    <button
                      key={event}
                      type="button"
                      aria-pressed={row.events.includes(event)}
                      onClick={() => toggleEvent(i, event)}
                      className="focus:outline-none"
                    >
                      <Badge variant={row.events.includes(event) ? 'default' : 'outline'}>{event}</Badge>
                    </button>
                  ))}
                </div>
                {!row.events.includes('lead.deleted') && (
                  <p className="text-xs text-status-away">
                    {t('settings.webhooks.deletedWarning', {
                      defaultValue:
                        'Without lead.deleted, your CRM keeps its copy when a customer asks to be erased — you would have to delete it there manually.',
                    })}
                  </p>
                )}

                <div className="flex items-center gap-2">
                  <Lock className="h-3.5 w-3.5 text-text-muted shrink-0" />
                  <Input
                    type="password"
                    value={row.secret ?? ''}
                    placeholder={
                      row.hasSecret
                        ? t('settings.webhooks.secretSet', { defaultValue: 'Signing secret set — type to replace' })
                        : t('settings.webhooks.secretNew', { defaultValue: 'Signing secret (generated if left blank)' })
                    }
                    onChange={(e) => update(i, { secret: e.target.value })}
                  />
                </div>
              </div>
            ))}

            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={rows.length >= maxEndpoints}
                onClick={() =>
                  setDraft([...rows, { url: '', events: [...LEAD_EVENTS], enabled: true, hasSecret: false }])
                }
              >
                <Plus className="h-3.5 w-3.5 mr-1.5" />
                {t('settings.webhooks.add', { defaultValue: 'Add endpoint' })}
              </Button>
              {dirty && (
                <Button size="sm" onClick={() => save.mutate(rows)} disabled={save.isPending}>
                  {save.isPending && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
                  {t('common.save', { defaultValue: 'Save' })}
                </Button>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
};
