/**
 * Accepted terms.
 *
 * Shown once per version and not dismissible: the point of the record is that the
 * person actually saw the document, so "continue" is the acceptance. Logging in
 * was never consent, and inferring it is exactly what a regulator will not accept
 * as proof.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Loader2, ScrollText } from 'lucide-react';
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

interface TermsStatus {
  currentVersion: string;
  acceptedVersion: string | null;
  acceptedAt: string | null;
  upToDate: boolean;
}

export const TermsAcceptanceModal: React.FC = () => {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const { data } = useQuery({
    queryKey: ['tenant', 'terms'],
    queryFn: () => api.get<TermsStatus>('/tenants/me/terms'),
  });

  const accept = useMutation({
    mutationFn: () => api.post<{ termsVersion: string }>('/tenants/me/terms'),
    onSuccess: () => {
      toast.success(t('terms.accepted', { defaultValue: 'Thanks — that is recorded.' }));
      void qc.invalidateQueries({ queryKey: ['tenant', 'terms'] });
    },
    onError: () =>
      toast.error(t('terms.error', { defaultValue: 'Could not record your acceptance' })),
  });

  if (!data || data.upToDate) return null;

  return (
    <Dialog open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ScrollText className="h-4 w-4" />
            {t('terms.title', { defaultValue: 'Our Terms of Service have been updated' })}
          </DialogTitle>
          <DialogDescription>
            {t('terms.body', {
              defaultValue:
                'Please read and accept version {{version}} before continuing. Your acceptance is recorded with the date and is what we rely on if there is ever a question about what you agreed to.',
              version: data.currentVersion,
            })}
          </DialogDescription>
        </DialogHeader>
        <p className="text-xs text-text-secondary">
          <a href="/terms" target="_blank" rel="noreferrer" className="text-primary-600 underline">
            {t('terms.read', { defaultValue: 'Read the Terms of Service' })}
          </a>
        </p>
        <DialogFooter>
          <Button disabled={accept.isPending} onClick={() => accept.mutate()}>
            {accept.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {t('terms.accept', { defaultValue: 'I accept' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
