import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { UpgradeCTA } from '@/components/billing/UpgradeCTA';
import { extractApiErrorMessage } from '@services/apiClient';
import { useCreateBot, extractApiErrorCode } from '@/queries/useBotsQueries';

interface CreateBotDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const CreateBotDialog: React.FC<CreateBotDialogProps> = ({ open, onOpenChange }) => {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [planLimitHit, setPlanLimitHit] = useState(false);
  const createBot = useCreateBot();

  // Reset transient state every time the dialog re-opens.
  useEffect(() => {
    if (open) {
      setName('');
      setPlanLimitHit(false);
    }
  }, [open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPlanLimitHit(false);
    try {
      await createBot.mutateAsync({ name: name.trim() });
      toast.success(t('bots.toast.created'));
      onOpenChange(false);
    } catch (err) {
      if (extractApiErrorCode(err) === 'plan_limit_bots') {
        // Inline upsell — the global interceptor already toasted the generic
        // upgrade nudge; we just keep the dialog open so the user sees the CTA.
        setPlanLimitHit(true);
        return;
      }
      const message = extractApiErrorMessage(err) ?? t('bots.errors.generic');
      toast.error(message);
    }
  };

  const submitDisabled = !name.trim() || createBot.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{t('bots.create.title')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="bot-name">{t('bots.create.nameLabel')}</Label>
              <Input
                id="bot-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('bots.create.namePlaceholder')}
                maxLength={255}
                autoFocus
                disabled={createBot.isPending}
              />
            </div>
            {planLimitHit && (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 space-y-2">
                <p className="text-sm text-amber-300">{t('bots.errors.planLimit')}</p>
                <UpgradeCTA tier="pro" variant="primary" />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={createBot.isPending}
            >
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={submitDisabled}>
              {createBot.isPending ? t('common.saving') : t('bots.create.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default CreateBotDialog;
