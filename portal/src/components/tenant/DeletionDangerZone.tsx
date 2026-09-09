/**
 * Danger zone: delete the whole workspace.
 *
 * Deliberately blunt and deliberately two-step. This is the only irreversible
 * button in the product, so it says what happens, when it happens, and what
 * survives — an invoice retention the customer did not ask for is exactly the
 * kind of thing that turns a deletion into a complaint.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, Loader2, Trash2 } from 'lucide-react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { api } from '@/services/apiClient';
import { useAppAuth } from '@auth/useAppAuth';
import type { DeletionState } from './deletion-types';

export const DeletionDangerZone: React.FC = () => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { isRole } = useAppAuth();
  const isAdmin = isRole(['admin', 'super_admin']);
  const [confirming, setConfirming] = useState(false);

  const { data } = useQuery({
    queryKey: ['tenant', 'deletion'],
    queryFn: () => api.get<DeletionState>('/tenants/me/deletion'),
  });

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['tenant', 'deletion'] });

  const request = useMutation({
    mutationFn: () => api.post<DeletionState>('/tenants/me/deletion'),
    onSuccess: () => {
      toast.success(
        t('tenantDeletion.requested', { defaultValue: 'Your workspace will be deleted in 30 days.' }),
      );
      setConfirming(false);
      invalidate();
    },
    onError: () =>
      toast.error(
        t('tenantDeletion.requestError', { defaultValue: 'Could not schedule the deletion' }),
      ),
  });

  const keep = useMutation({
    mutationFn: () => api.delete<DeletionState>('/tenants/me/deletion'),
    onSuccess: () => {
      toast.success(t('tenantDeletion.reactivated', { defaultValue: 'Your workspace is staying.' }));
      invalidate();
    },
    onError: () =>
      toast.error(
        t('tenantDeletion.reactivateError', { defaultValue: 'Could not reactivate the workspace' }),
      ),
  });

  if (!data) return null;
  const pending = Boolean(data.scheduledFor);
  const when = data.scheduledFor ? new Date(data.scheduledFor).toLocaleDateString() : '';

  return (
    <Card>
      <CardHeader>
        <h2 className="flex items-center gap-2 text-sm font-semibold text-status-away">
          <AlertTriangle className="h-4 w-4" />
          {t('tenantDeletion.title', { defaultValue: 'Delete this workspace' })}
        </h2>
        <p className="mt-1 text-xs text-text-secondary">
          {t('tenantDeletion.body', {
            defaultValue:
              'Your bots stop answering immediately. Everything is kept for 30 days in case you change your mind, then permanently deleted: conversations, leads, bookings, documents and files. Only the invoices we are legally required to keep survive.',
          })}
        </p>
      </CardHeader>
      <CardContent>
        {pending ? (
          <div className="rounded-lg border border-status-away/40 bg-status-away/10 p-3">
            <p className="text-xs text-text-primary">
              {t('tenantDeletion.pendingCard', {
                defaultValue:
                  'Scheduled for deletion on {{date}} — {{days}} days from now. Until then you can keep your account and everything comes back.',
                date: when,
                days: data.daysRemaining ?? 0,
              })}
            </p>
            <Button
              size="sm"
              className="mt-2"
              disabled={!isAdmin || keep.isPending}
              onClick={() => keep.mutate()}
            >
              {keep.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {t('tenantDeletion.keepAccount', { defaultValue: 'Keep my account' })}
            </Button>
          </div>
        ) : confirming ? (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3">
            <p className="text-xs text-text-primary">
              {t('tenantDeletion.confirm', {
                defaultValue:
                  'Delete this workspace? Your bots stop answering now, everything is kept for 30 days, then permanently deleted. This cannot be undone after that.',
              })}
            </p>
            <div className="mt-2 flex gap-2">
              <Button
                size="sm"
                variant="destructive"
                disabled={request.isPending}
                onClick={() => request.mutate()}
              >
                {request.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                {t('tenantDeletion.confirmYes', { defaultValue: 'Yes, delete my workspace' })}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setConfirming(false)}>
                {t('common.cancel', { defaultValue: 'Cancel' })}
              </Button>
            </div>
          </div>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="text-destructive"
            disabled={!isAdmin}
            onClick={() => setConfirming(true)}
          >
            <Trash2 className="mr-1.5 h-3.5 w-3.5" />
            {t('tenantDeletion.button', { defaultValue: 'Delete this workspace' })}
          </Button>
        )}

        {!isAdmin && (
          <p className="mt-2 text-xs text-text-muted">
            {t('tenantDeletion.adminOnly', { defaultValue: 'Only workspace admins can change this.' })}
          </p>
        )}
      </CardContent>
    </Card>
  );
};
