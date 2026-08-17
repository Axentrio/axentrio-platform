/**
 * Step 4 — the website assistant.
 *
 * Collects the four things the assistant cannot work properly without: its name, how it
 * should sound, where to send a customer it can't help, and when you are open. Each one
 * is visible in the very first conversation, which is why they are here and not deferred.
 *
 * Business hours are asked as ONE pair of times plus the days you are open, not the
 * seven-row grid from AI & Content. Almost every business opens at the same time every
 * weekday, and the few that don't are better served refining it later on a screen built
 * for it than fighting a grid during setup. The value written is the full seven-day
 * schedule either way, so nothing has to be migrated when they do.
 *
 * Skipping this step turns the assistant OFF, server-side. That is not a toggle key —
 * `ai.enabled` lives on the anchor bot — so the route special-cases it rather than
 * pretending it is one.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy, Loader2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { api, extractApiErrorMessage } from '@/services/apiClient';
import { useGetAiSettings, useUpdateAiSettings } from '@/queries/useKnowledgeQueries';
import { useBotEmbed, useBots } from '@/queries/useBotsQueries';
import type { StepProps } from './types';

const TONES = ['friendly', 'professional', 'casual', 'formal'] as const;

const WEEK_DAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;

/** Opening Monday to Friday is the common case, so it is the starting point. */
const DEFAULT_OPEN_DAYS: string[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function ChatbotStep({ submit }: StepProps) {
  const { t } = useTranslation();
  const { data: settings, isLoading } = useGetAiSettings();
  const updateAi = useUpdateAiSettings();
  const { data: botsData } = useBots();
  const anchorBot = botsData?.bots.find((b) => b.isDefault) ?? botsData?.bots[0];
  const { data: embed } = useBotEmbed(anchorBot?.id);

  const [name, setName] = React.useState('');
  const [tone, setTone] = React.useState<string>('friendly');
  const [supportEmail, setSupportEmail] = React.useState('');
  const [openDays, setOpenDays] = React.useState<string[]>(DEFAULT_OPEN_DAYS);
  const [opensAt, setOpensAt] = React.useState('09:00');
  const [closesAt, setClosesAt] = React.useState('17:00');
  const [saving, setSaving] = React.useState(false);
  const [seeded, setSeeded] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  // Seed once from the server, then leave the fields alone — a refetch mid-edit must
  // not overwrite what the customer is typing.
  React.useEffect(() => {
    if (seeded || isLoading || !settings) return;
    setName(settings.brandVoice?.name ?? '');
    setTone(settings.brandVoice?.tone ?? 'friendly');
    setSupportEmail(settings.supportEmail ?? '');
    setSeeded(true);
  }, [seeded, isLoading, settings]);

  const toggleDay = (day: string) =>
    setOpenDays((days) =>
      days.includes(day) ? days.filter((d) => d !== day) : [...days, day],
    );

  const save = async () => {
    setSaving(true);
    try {
      await updateAi.mutateAsync({
        enabled: true,
        supportEmail: supportEmail.trim(),
        brandVoice: { name: name.trim(), tone },
      });
      // The same top-level key AI & Content writes, so the two screens edit one value.
      await api.patch('/tenants/me', {
        businessHours: {
          enabled: true,
          schedule: WEEK_DAYS.map((day) => ({
            day,
            open: opensAt,
            close: closesAt,
            closed: !openDays.includes(day),
          })),
        },
      });
      submit.mutate({ step: 'chatbot' });
    } catch (err) {
      // Without this the customer clicks Continue, the spinner stops, and nothing
      // happens — the same dead end the wizard shell exists to prevent. The
      // ai-settings hook toasts its own failures; the hours write had nothing.
      toast.error(extractApiErrorMessage(err) ?? t('setup.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const copySnippet = async () => {
    if (!embed?.snippet) return;
    try {
      await navigator.clipboard.writeText(embed.snippet);
      setCopied(true);
      toast.success(t('bots.embed.copied'));
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(t('bots.errors.generic'));
    }
  };

  const busy = saving || submit.isPending;
  const complete =
    name.trim().length > 0 && EMAIL.test(supportEmail.trim()) && openDays.length > 0;

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

      <div className="space-y-2">
        <Label htmlFor="setup-support-email">{t('setup.steps.chatbot.supportEmailLabel')}</Label>
        <Input
          id="setup-support-email"
          type="email"
          value={supportEmail}
          onChange={(e) => setSupportEmail(e.target.value)}
          placeholder="info@yourcompany.be"
        />
        <p className="text-xs text-text-muted">{t('setup.steps.chatbot.supportEmailHint')}</p>
      </div>

      <div className="space-y-3">
        <Label>{t('setup.steps.chatbot.hoursLabel')}</Label>
        <div className="flex flex-wrap gap-1.5">
          {WEEK_DAYS.map((day) => (
            <button
              key={day}
              type="button"
              onClick={() => toggleDay(day)}
              aria-pressed={openDays.includes(day)}
              className={cn(
                'rounded-lg border px-3 py-1.5 text-xs font-medium capitalize transition-colors',
                openDays.includes(day)
                  ? 'border-primary-500 bg-primary-500/10 text-text-primary'
                  : 'border-edge bg-surface-2 text-text-muted hover:border-primary-500/50',
              )}
            >
              {t(`setup.steps.chatbot.days.${day}`)}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Input
            aria-label={t('setup.steps.chatbot.opensAt')}
            type="time"
            value={opensAt}
            onChange={(e) => setOpensAt(e.target.value)}
            className="w-32"
          />
          <span className="text-sm text-text-muted">{t('setup.steps.chatbot.to')}</span>
          <Input
            aria-label={t('setup.steps.chatbot.closesAt')}
            type="time"
            value={closesAt}
            onChange={(e) => setClosesAt(e.target.value)}
            className="w-32"
          />
        </div>
        <p className="text-xs text-text-muted">{t('setup.steps.chatbot.hoursHint')}</p>
      </div>

      {embed?.snippet && (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <h3 className="text-sm font-medium text-text-primary">{t('setup.steps.chatbot.installTitle')}</h3>
            <p className="text-sm text-text-secondary">{t('setup.steps.chatbot.installBody')}</p>
          </div>
          <pre className="overflow-x-auto rounded-md border border-edge bg-surface-3 p-3 text-xs text-text-primary">
            <code>{embed.snippet}</code>
          </pre>
          <Button type="button" variant="outline" onClick={copySnippet}>
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
          <p className="text-xs text-text-muted">{t('setup.steps.chatbot.installHint')}</p>
        </div>
      )}

      <div className="flex justify-end">
        <Button size="lg" onClick={save} disabled={busy || !complete}>
          {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {t('setup.continue')}
        </Button>
      </div>
    </div>
  );
}
