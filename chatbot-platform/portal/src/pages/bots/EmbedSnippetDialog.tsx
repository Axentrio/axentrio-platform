import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { InlineError } from '@/components/ui/inline-error';
import { useBotEmbed } from '@/queries/useBotsQueries';

interface EmbedSnippetDialogProps {
  botId: string | null;
  onClose: () => void;
}

export const EmbedSnippetDialog: React.FC<EmbedSnippetDialogProps> = ({ botId, onClose }) => {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const { data, isLoading, isError } = useBotEmbed(botId);

  const handleCopy = async () => {
    if (!data?.snippet) return;
    try {
      await navigator.clipboard.writeText(data.snippet);
      setCopied(true);
      toast.success(t('bots.embed.copied'));
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(t('bots.errors.generic'));
    }
  };

  return (
    <Dialog open={!!botId} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{t('bots.embed.title')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-4">
          <p className="text-sm text-text-muted">{t('bots.embed.description')}</p>
          {isLoading && <Skeleton className="h-20 w-full" />}
          {isError && <InlineError message={t('bots.errors.generic')} />}
          {data?.snippet && (
            <pre className="overflow-x-auto rounded-md border border-edge bg-surface-3 p-3 text-xs text-text-primary">
              <code>{data.snippet}</code>
            </pre>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common.close')}
          </Button>
          <Button onClick={handleCopy} disabled={!data?.snippet}>
            {copied ? (
              <>
                <Check className="w-4 h-4 mr-2" />
                {t('bots.embed.copied')}
              </>
            ) : (
              <>
                <Copy className="w-4 h-4 mr-2" />
                {t('bots.embed.copyButton')}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default EmbedSnippetDialog;
