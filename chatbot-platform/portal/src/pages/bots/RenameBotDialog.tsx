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
import { extractApiErrorMessage } from '@services/apiClient';
import { useUpdateBot, type BotListItem } from '@/queries/useBotsQueries';

interface RenameBotDialogProps {
  bot: BotListItem | null;
  onClose: () => void;
}

export const RenameBotDialog: React.FC<RenameBotDialogProps> = ({ bot, onClose }) => {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const updateBot = useUpdateBot();

  useEffect(() => {
    if (bot) setName(bot.name);
  }, [bot]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bot) return;
    try {
      await updateBot.mutateAsync({ id: bot.id, name: name.trim() });
      toast.success(t('bots.toast.renamed'));
      onClose();
    } catch (err) {
      const message = extractApiErrorMessage(err) ?? t('bots.errors.generic');
      toast.error(message);
    }
  };

  const submitDisabled = !name.trim() || name.trim() === bot?.name || updateBot.isPending;

  return (
    <Dialog open={!!bot} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[440px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{t('bots.rename.title')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="rename-bot-name">{t('bots.create.nameLabel')}</Label>
              <Input
                id="rename-bot-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={255}
                autoFocus
                disabled={updateBot.isPending}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={updateBot.isPending}
            >
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={submitDisabled}>
              {updateBot.isPending ? t('common.saving') : t('common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default RenameBotDialog;
