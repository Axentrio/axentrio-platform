/**
 * "Your workspace is scheduled for deletion" — shown on every authenticated page
 * while the dormancy window is open.
 *
 * This is the reactivation half of the deletion flow: the account is dormant, not
 * gone, and the customer has 30 days to change their mind. Dismissing is allowed
 * (it is their workspace, and nagging on every page would be its own problem) —
 * the banner on the retention screen keeps the state visible.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { api } from '@/services/apiClient';
import { useAppAuth } from '@auth/useAppAuth';
import type { DeletionState } from './deletion-types';

export const DeletionPendingModal: React.FC = () => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { isRole } = useAppAuth();
  const isAdmin = isRole(['admin', 'super_admin']);
  const [dismissed, setDismissed] = useState(false);

  const { data } = useQuery({
    queryKey: ['tenant', 'deletion'],
    queryFn: () => api.get<DeletionState>('/tenants/me/deletion'),
  });

  const keep = useMutation({
    mutationFn: () => api.delete<DeletionState>('/tenants/me/deletion'),
    onSuccess: () => {
      toast.success(t('tenantDeletion.reactivated', { defaultValue: 'Your workspace is staying.' }));
      void qc.invalidateQueries({ queryKey: ['tenant', 'deletion'] });
      setDismissed(true);
    },
    onError: () =>
      toast.error(
        t('tenantDeletion.reactivateError', { defaultValue: 'Could not reactivate the workspace' }),
      ),
  });

  const open = Boolean(data?.scheduledFor) && !dismissed;
  const when = data?.scheduledFor ? new Date(data.scheduledFor).toLocaleDateString() : '';

  return (
    <Dialog open={open} onOpenChange={(next) => !next && setDismissed(true)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-status-away" />
            {t('tenantDeletion.pendingTitle', { defaultValue: 'This workspace is scheduled for deletion' })}
          </DialogTitle>
          <DialogDescription>
            {t('tenantDeletion.pendingBody', {
              defaultValue:
                'It stops answering customers straight away and everything is permanently deleted on {{date}} — {{days}} days from now. If you did not mean to do this, keep your account now.',
              date: when,
              days: data?.daysRemaining ?? 0,
            })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => setDismissed(true)}>
            {t('tenantDeletion.continueDeleting', { defaultValue: 'Continue deleting' })}
          </Button>
          <Button disabled={!isAdmin || keep.isPending} onClick={() => keep.mutate()}>
            {t('tenantDeletion.keepAccount', { defaultValue: 'Keep my account' })}
          </Button>
        </DialogFooter>
        {!isAdmin && (
          <p className="text-xs text-text-muted">
            {t('tenantDeletion.adminOnly', { defaultValue: 'Only workspace admins can change this.' })}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
};
