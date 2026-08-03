/**
 * Step 4 — the assistant's name and tone.
 *
 * Only these two, out of everything AI & Content can configure. They are the two the
 * customer has an opinion about on day one, and both are visible in the very first
 * conversation. The rest of the bot editor stays where it is — a setup wizard that
 * reproduces a settings screen is a settings screen that now exists twice.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useGetAiSettings, useUpdateAiSettings } from '@/queries/useKnowledgeQueries';
import type { StepProps } from './types';

const TONES = ['friendly', 'professional', 'casual', 'formal'] as const;

export function ChatbotStep({ submit }: StepProps) {
  const { t } = useTranslation();
  const { data: settings, isLoading } = useGetAiSettings();
  const updateAi = useUpdateAiSettings();

  const [name, setName] = React.useState('');
  const [tone, setTone] = React.useState<string>('friendly');
  const [seeded, setSeeded] = React.useState(false);

  // Seed once from the server, then leave the fields alone — a refetch mid-edit must
  // not overwrite what the customer is typing.
  React.useEffect(() => {
    if (seeded || isLoading || !settings) return;
    setName(settings.brandVoice?.name ?? '');
    setTone(settings.brandVoice?.tone ?? 'friendly');
    setSeeded(true);
  }, [seeded, isLoading, settings]);

  const save = async () => {
    await updateAi.mutateAsync({ brandVoice: { name: name.trim(), tone } });
    submit.mutate({ step: 'chatbot' });
  };

  const busy = updateAi.isPending || submit.isPending;

  return (
    <div className="space-y-6">
      <div className="space-y-1.5">
        <h2 className="text-xl font-semibold text-text-primary">{t('setup.steps.chatbot.title')}</h2>
        <p className="text-sm text-text-secondary">{t('setup.steps.chatbot.body')}</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="setup-bot-name">{t('setup.steps.chatbot.nameLabel')}</Label>
        <Input
          id="setup-bot-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('setup.steps.chatbot.namePlaceholder')}
        />
      </div>

      <div className="space-y-2">
        <Label>{t('setup.steps.chatbot.toneLabel')}</Label>
        <div className="grid gap-2 sm:grid-cols-4">
          {TONES.map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setTone(value)}
              className={cn(
                'rounded-lg border px-3 py-2.5 text-sm font-medium transition-colors',
                tone === value
                  ? 'border-primary-500 bg-primary-500/10 text-text-primary'
                  : 'border-edge bg-surface-2 text-text-secondary hover:border-primary-500/50',
              )}
            >
              {t(`ai.bot.identity.tones.${value}`)}
            </button>
          ))}
        </div>
      </div>

      <div className="flex justify-end">
        <Button size="lg" onClick={save} disabled={busy || !name.trim()}>
          {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {t('setup.continue')}
        </Button>
      </div>
    </div>
  );
}
