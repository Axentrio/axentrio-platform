import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import {
  useGetWidgetAppearance,
  useUpdateWidgetAppearance,
} from '@/queries/useWidgetAppearance';
import { useGetAiSettings } from '@/queries/useKnowledgeQueries';
import { useTenantSettings } from '@/queries/useTenantQueries';
import ChatbotAppearancesPreview from './ChatbotAppearancesPreview';

type FormState = {
  primaryColor: string;
  avatarUrl: string;
  launcherPosition: 'bottom-right' | 'bottom-left';
  launcherLabel: string;
};

const ChatbotAppearancesForm: React.FC = () => {
  const { t } = useTranslation();
  const { data: appearance, isLoading } = useGetWidgetAppearance();
  const { data: aiSettings } = useGetAiSettings();
  const { data: tenant } = useTenantSettings() as { data: { apiKey?: string } | undefined };
  const update = useUpdateWidgetAppearance();

  const [form, setForm] = useState<FormState>({
    primaryColor: '#6366f1',
    avatarUrl: '',
    launcherPosition: 'bottom-right',
    launcherLabel: '',
  });
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(null);
  const hydratedRef = useRef(false);

  useEffect(() => {
    if (hydratedRef.current) return;
    if (isLoading) return;
    hydratedRef.current = true;
    const hydrated: FormState = appearance
      ? {
          primaryColor: appearance.primaryColor ?? '#6366f1',
          avatarUrl: appearance.avatarUrl ?? '',
          launcherPosition: appearance.launcherPosition,
          launcherLabel: appearance.launcherLabel ?? '',
        }
      : form;
    setForm(hydrated);
    setSavedSnapshot(JSON.stringify(hydrated));
  }, [appearance, isLoading]);

  const greeting = (aiSettings as { guardrails?: { greetingMessage?: string } } | undefined)
    ?.guardrails?.greetingMessage ?? '';

  const currentSnapshot = JSON.stringify(form);
  const isDirty = savedSnapshot !== null && currentSnapshot !== savedSnapshot;

  const widgetTestHref = useMemo(() => {
    const key = tenant?.apiKey;
    return key ? `/widget-test?apiKey=${encodeURIComponent(key)}` : '#';
  }, [tenant?.apiKey]);

  const handleSave = () => {
    const payload = {
      primaryColor: form.primaryColor,
      avatarUrl: form.avatarUrl === '' ? null : form.avatarUrl,
      launcherPosition: form.launcherPosition,
      launcherLabel: form.launcherLabel === '' ? null : form.launcherLabel,
    };
    update.mutate(payload, {
      onSuccess: () => setSavedSnapshot(currentSnapshot),
    });
  };

  if (isLoading) return <PageSkeleton variant="list" rows={5} />;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_minmax(280px,420px)]">
      <div className="space-y-6">
        <div className="space-y-2">
          <Label htmlFor="primaryColor">{t('ai.appearances.color.label')}</Label>
          <Input
            id="primaryColor"
            type="color"
            value={form.primaryColor}
            onChange={(e) => setForm((f) => ({ ...f, primaryColor: e.target.value }))}
            className="h-10 w-20 p-1"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="avatarUrl">{t('ai.appearances.avatar.label')}</Label>
          <Input
            id="avatarUrl"
            type="url"
            placeholder={t('ai.appearances.avatar.placeholder')}
            value={form.avatarUrl}
            onChange={(e) => setForm((f) => ({ ...f, avatarUrl: e.target.value }))}
          />
          <p className="text-xs text-muted-foreground">
            {t('ai.appearances.avatar.helper')}
          </p>
        </div>

        <div className="space-y-2">
          <Label>{t('ai.appearances.launcher.position.label')}</Label>
          <div className="flex gap-2">
            {(['bottom-right', 'bottom-left'] as const).map((pos) => (
              <Button
                key={pos}
                type="button"
                variant={form.launcherPosition === pos ? 'default' : 'outline'}
                onClick={() => setForm((f) => ({ ...f, launcherPosition: pos }))}
              >
                {pos === 'bottom-right'
                  ? t('ai.appearances.launcher.position.options.bottomRight')
                  : t('ai.appearances.launcher.position.options.bottomLeft')}
              </Button>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="launcherLabel">{t('ai.appearances.launcher.label.label')}</Label>
          <Input
            id="launcherLabel"
            maxLength={30}
            placeholder={t('ai.appearances.launcher.label.placeholder')}
            value={form.launcherLabel}
            onChange={(e) => setForm((f) => ({ ...f, launcherLabel: e.target.value }))}
          />
          <p className="text-xs text-muted-foreground">
            {t('ai.appearances.launcher.label.helper')}
          </p>
        </div>

        <div className="space-y-1 rounded-lg border border-border bg-muted/30 p-3">
          <Label>{t('ai.appearances.welcome.label')}</Label>
          <p className="text-sm text-foreground">
            {greeting || <span className="text-muted-foreground italic">{t('ai.appearances.welcome.empty')}</span>}
          </p>
          <p className="text-xs text-muted-foreground">
            {t('ai.appearances.welcome.helper')}{' '}
            <a href="/ai?tab=bot" className="underline">
              {t('ai.appearances.welcome.editLink')}
            </a>
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Button onClick={handleSave} disabled={!isDirty || update.isPending}>
            <Save className="mr-2 h-4 w-4" />
            {t('common.save')}
          </Button>
          <a
            href={widgetTestHref}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center text-sm underline text-muted-foreground"
          >
            {t('ai.appearances.openFullWidgetTest')}
            <ExternalLink className="ml-1 h-3 w-3" />
          </a>
        </div>
      </div>

      <ChatbotAppearancesPreview
        primaryColor={form.primaryColor}
        avatarUrl={form.avatarUrl || null}
        launcherPosition={form.launcherPosition}
        launcherLabel={form.launcherLabel || null}
        greetingMessage={greeting}
      />
    </div>
  );
};

export default ChatbotAppearancesForm;
