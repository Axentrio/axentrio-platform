import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { HelpCircle, Sparkles, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { AutoSaveStatusIndicator } from '@/components/ui/auto-save-status';
import { useAutoSave } from '@/hooks/useAutoSave';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useAppAuth } from '@/auth/useAppAuth';
import {
  useBotAiSettings,
  useUpdateBotAiSettings,
  useBotTemplates,
  useBindBotTemplate,
} from '@/queries/useBotsQueries';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { InlineError } from '@/components/ui/inline-error';
import BotInstructionsHelpDrawer from '@/pages/help/BotInstructionsHelpDrawer';

// Placeholder hint shown under the additional-instructions field. These resolve
// at runtime via the prompt composer's variable map.
const AI_PLACEHOLDERS = ['{botName}', '{businessName}', '{tone}', '{supportEmail}'];

interface AiBotFormProps {
  /** The bot whose AI config this form edits (per-bot config editing). */
  botId: string;
  onGoToKnowledgeBase: () => void;
}

const TONE_PRESETS = [
  { value: 'friendly', labelKey: 'ai.bot.identity.tones.friendly' },
  { value: 'professional', labelKey: 'ai.bot.identity.tones.professional' },
  { value: 'casual', labelKey: 'ai.bot.identity.tones.casual' },
  { value: 'formal', labelKey: 'ai.bot.identity.tones.formal' },
] as const;

type FormSnapshot = {
  enabled: boolean;
  botName: string;
  supportEmail: string;
  effectiveTone: string;
  systemPrompt: string;
  greetingMessage: string;
  fallbackMessage: string;
  offHoursMessage: string;
  confidenceThreshold: number;
  maxResponseLength: number;
  escalationKeywords: string[];
  topicsToAvoid: string[];
};

const snapshotKey = (s: FormSnapshot): string => JSON.stringify(s);

const computeEffectiveTone = (tone: string, customTone: string): string => {
  const isCustom = !TONE_PRESETS.some((p) => p.value === tone);
  return isCustom ? (customTone.trim() || 'custom') : tone;
};

const AiBotForm: React.FC<AiBotFormProps> = ({ botId, onGoToKnowledgeBase }) => {
  const { t } = useTranslation();
  const { isRole, tenantId } = useAppAuth();
  const isAdmin = isRole('admin');
  const isAdminOrSupervisor = isRole(['admin', 'supervisor']);

  // Track which (tenant, bot) pair has already populated the form. Refetches /
  // query invalidations for the same bot must not clobber in-flight edits;
  // navigating to a different bot (or tenant) re-hydrates from its data.
  const hydratedKeyRef = useRef<string | null>(null);
  const hydrationKey = `${tenantId ?? ''}:${botId}`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: aiSettings, isLoading, error } = useBotAiSettings(botId, { enabled: isAdminOrSupervisor }) as { data: any; isLoading: boolean; error: any };
  const updateSettings = useUpdateBotAiSettings(botId);

  // Template binding (Phase 4): the bound prompt identity is its own resource,
  // separate from the auto-saved behavioural form. Each picker change saves
  // immediately via the bind mutation; the query is the source of truth.
  const { data: templateView } = useBotTemplates(botId, { enabled: isAdminOrSupervisor });
  const bindTemplate = useBindBotTemplate(botId);

  // Form state
  const [enabled, setEnabled] = useState(false);
  const [botName, setBotName] = useState('');
  const [supportEmail, setSupportEmail] = useState('');
  const [tone, setTone] = useState('friendly');
  const [customTone, setCustomTone] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [greetingMessage, setGreetingMessage] = useState('');
  const [fallbackMessage, setFallbackMessage] = useState('');
  const [offHoursMessage, setOffHoursMessage] = useState('');
  const [confidenceThreshold, setConfidenceThreshold] = useState(0.7);
  const [maxResponseLength, setMaxResponseLength] = useState(500);
  const [escalationKeywords, setEscalationKeywords] = useState<string[]>([]);
  const [topicsToAvoid, setTopicsToAvoid] = useState<string[]>([]);
  // Baseline snapshot captured at hydration. Stays fixed until tenant change;
  // useAutoSave maintains its own moving "last saved" baseline on top of this.
  const [initialSnapshot, setInitialSnapshot] = useState<string | null>(null);
  // Open state for the unsaved-changes navigation dialog (Go to Knowledge Base).
  const [showLeaveDialog, setShowLeaveDialog] = useState(false);
  const [isHelpOpen, setIsHelpOpen] = useState(false);

  const isCustomTone = !TONE_PRESETS.some((p) => p.value === tone);

  // Hydrate from server once per tenant. Skips on refetches/invalidations
  // for the already-loaded tenant so the user's in-progress edits survive.
  useEffect(() => {
    if (!aiSettings) return;
    if (!tenantId) return;
    if (hydratedKeyRef.current === hydrationKey) return;
    hydratedKeyRef.current = hydrationKey;

    const hEnabled = aiSettings.enabled ?? false;
    const hBotName = aiSettings.brandVoice?.name ?? '';
    const hSupportEmail = aiSettings.supportEmail ?? '';
    const serverTone: string = aiSettings.brandVoice?.tone ?? 'friendly';
    const isPreset = TONE_PRESETS.some((p) => p.value === serverTone);
    const hTone = serverTone;
    const hCustomTone = isPreset ? '' : serverTone;
    const hSystemPrompt = aiSettings.brandVoice?.customInstructions ?? '';
    const hGreeting = aiSettings.guardrails?.greetingMessage ?? '';
    const hFallback = aiSettings.guardrails?.fallbackMessage ?? '';
    const hOffHours = aiSettings.guardrails?.offHoursMessage ?? '';
    const hConfidence = aiSettings.guardrails?.confidenceThreshold ?? 0.7;
    const hMaxLen = aiSettings.guardrails?.maxResponseLength ?? 500;
    const hEscalation = aiSettings.guardrails?.escalationKeywords ?? [];
    const hTopics = aiSettings.guardrails?.topicsToAvoid ?? [];

    setEnabled(hEnabled);
    setBotName(hBotName);
    setSupportEmail(hSupportEmail);
    setTone(hTone);
    setCustomTone(hCustomTone);
    setSystemPrompt(hSystemPrompt);
    setGreetingMessage(hGreeting);
    setFallbackMessage(hFallback);
    setOffHoursMessage(hOffHours);
    setConfidenceThreshold(hConfidence);
    setMaxResponseLength(hMaxLen);
    setEscalationKeywords(hEscalation);
    setTopicsToAvoid(hTopics);

    setInitialSnapshot(snapshotKey({
      enabled: hEnabled,
      botName: hBotName,
      supportEmail: hSupportEmail,
      effectiveTone: computeEffectiveTone(hTone, hCustomTone),
      systemPrompt: hSystemPrompt,
      greetingMessage: hGreeting,
      fallbackMessage: hFallback,
      offHoursMessage: hOffHours,
      confidenceThreshold: hConfidence,
      maxResponseLength: hMaxLen,
      escalationKeywords: hEscalation,
      topicsToAvoid: hTopics,
    }));
  }, [aiSettings, tenantId, hydrationKey]);

  const effectiveTone = isCustomTone ? (customTone.trim() || 'custom') : tone;

  const currentSnapshotKey = snapshotKey({
    enabled,
    botName,
    supportEmail,
    effectiveTone,
    systemPrompt,
    greetingMessage,
    fallbackMessage,
    offHoursMessage,
    confidenceThreshold,
    maxResponseLength,
    escalationKeywords,
    topicsToAvoid,
  });

  // Inline validation. Auto-save skips while invalid so the backend never
  // sees garbage; the leave dialog re-appears specifically for this case to
  // warn the user before they navigate away with an unsaved invalid draft.
  const isSupportEmailValid = !supportEmail || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(supportEmail);
  const isMaxResponseLengthValid = maxResponseLength > 0;
  const isValid = isSupportEmailValid && isMaxResponseLengthValid;

  const commitSave = useCallback(
    ({ onSuccess, onError }: { onSuccess: () => void; onError: () => void }) => {
      updateSettings.mutate(
        {
          enabled,
          supportEmail: supportEmail || null,
          brandVoice: {
            name: botName || 'AI Assistant',
            tone: effectiveTone,
            customInstructions: systemPrompt,
          },
          guardrails: {
            greetingMessage,
            fallbackMessage,
            offHoursMessage,
            confidenceThreshold,
            maxResponseLength,
            escalationKeywords,
            topicsToAvoid,
          },
        },
        { onSuccess, onError },
      );
    },
    [updateSettings, enabled, supportEmail, botName, effectiveTone, systemPrompt, greetingMessage, fallbackMessage, offHoursMessage, confidenceThreshold, maxResponseLength, escalationKeywords, topicsToAvoid],
  );

  const { status, isDirty, flush, retry } = useAutoSave({
    snapshot: currentSnapshotKey,
    initialSnapshot,
    isValid,
    save: commitSave,
  });

  const handleGoToKnowledgeBase = () => {
    flush();
    if (isDirty && !isValid) {
      setShowLeaveDialog(true);
      return;
    }
    onGoToKnowledgeBase();
  };

  const confirmLeave = () => {
    setShowLeaveDialog(false);
    onGoToKnowledgeBase();
  };

  // Template binding (saved immediately, separate from the auto-saved form).
  const binding = templateView?.binding;
  const availableTemplates = templateView?.available ?? [];
  const publishedVersions = templateView?.publishedVersions ?? [];
  const resolved = templateView?.resolved;
  const missingModules = templateView?.missingModules ?? [];

  // Selecting a template resets the pin to 'latest'; selecting a version pins it.
  const handleTemplateSelect = (id: string) => bindTemplate.mutate({ templateId: id, templateVersion: 'latest' });
  const handleVersionSelect = (version: string) => {
    if (binding?.templateId) bindTemplate.mutate({ templateId: binding.templateId, templateVersion: version });
  };

  const readOnly = !isAdmin;

  const placeholderHint = useMemo(() => AI_PLACEHOLDERS.join('  '), []);

  if (!isAdminOrSupervisor) {
    return (
      <div className="py-16 text-center text-sm text-text-muted">
        {t('ai.bot.noPermission')}
      </div>
    );
  }

  if (isLoading) return <PageSkeleton variant="cards" />;
  if (error) return <InlineError message={t('ai.bot.loadError')} />;

  return (
    <div className="max-w-3xl space-y-8" onBlur={flush}>
      {/* Enable bar */}
      <div className="flex items-center justify-between p-4 rounded-xl bg-surface-2">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-surface-3">
            <Sparkles className="w-4 h-4 text-primary-400" />
          </div>
          <div>
            <p className="text-sm font-medium text-text-primary">{t('ai.bot.enable.title')}</p>
            <p className="text-xs text-text-muted">{t('ai.bot.enable.description')}</p>
          </div>
        </div>
        <Switch checked={enabled} onCheckedChange={setEnabled} disabled={readOnly} />
      </div>

      <div className={enabled ? 'space-y-8' : 'space-y-8 opacity-50 pointer-events-none'}>
        {/* Bot Identity */}
        <section className="space-y-4">
          <div>
            <h3 className="text-sm font-semibold text-text-primary">{t('ai.bot.identity.title')}</h3>
            <p className="text-xs text-text-muted mt-0.5">{t('ai.bot.identity.description')}</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label className="mb-1 text-text-secondary">{t('ai.bot.identity.botName.label')}</Label>
              <Input
                value={botName}
                onChange={(e) => setBotName(e.target.value)}
                placeholder={t('ai.bot.identity.botName.placeholder')}
                disabled={readOnly}
              />
              <p className="text-[10px] text-text-muted mt-1">{t('ai.bot.identity.botName.helper')}</p>
            </div>
            <div>
              <Label className="mb-1 text-text-secondary">{t('ai.bot.identity.supportEmail.label')}</Label>
              <Input
                type="email"
                value={supportEmail}
                onChange={(e) => setSupportEmail(e.target.value)}
                placeholder={t('ai.bot.identity.supportEmail.placeholder')}
                disabled={readOnly}
                aria-invalid={!isSupportEmailValid}
              />
              {isSupportEmailValid ? (
                <p className="text-[10px] text-text-muted mt-1">{t('ai.bot.identity.supportEmail.helper')}</p>
              ) : (
                <p className="text-[10px] text-red-400 mt-1">{t('ai.bot.identity.supportEmail.invalid')}</p>
              )}
            </div>
          </div>
        </section>

        {/* Bot Template (prompt identity, managed centrally; bound here) */}
        <section className="space-y-3">
          <div>
            <h3 className="text-sm font-semibold text-text-primary">{t('ai.bot.template.title')}</h3>
            <p className="text-xs text-text-muted mt-0.5">{t('ai.bot.template.description')}</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <Label className="mb-1 text-text-secondary">{t('ai.bot.template.select')}</Label>
              <Select value={binding?.templateId ?? ''} onValueChange={handleTemplateSelect} disabled={readOnly || bindTemplate.isPending}>
                <SelectTrigger className="h-9" aria-label={t('ai.bot.template.select')}>
                  <SelectValue placeholder={t('ai.bot.template.selectPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {availableTemplates.map((tpl) => (
                    <SelectItem key={tpl.id} value={tpl.id}>{tpl.displayName}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {binding?.templateId && publishedVersions.length > 0 && (
              <div>
                <Label className="mb-1 text-text-secondary">{t('ai.bot.template.version')}</Label>
                <Select value={binding?.templateVersion ?? 'latest'} onValueChange={handleVersionSelect} disabled={readOnly || bindTemplate.isPending}>
                  <SelectTrigger className="h-9" aria-label={t('ai.bot.template.version')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="latest">{t('ai.bot.template.latest')}</SelectItem>
                    {publishedVersions.map((v) => (
                      <SelectItem key={v} value={String(v)}>{`v${v}`}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          {resolved?.templateUnavailable && (
            <p className="text-[11px] text-amber-400">{t('ai.bot.template.warnings.unavailable')}</p>
          )}
          {resolved?.pinnedButUnavailable && (
            <p className="text-[11px] text-amber-400">{t('ai.bot.template.warnings.pinned')}</p>
          )}
          {missingModules.length > 0 && (
            <p className="text-[11px] text-amber-400">
              {t('ai.bot.template.warnings.missingModules', { modules: missingModules.join(', ') })}
            </p>
          )}
          <div>
            <Label className="mb-1 text-text-secondary">{t('ai.bot.template.preview')}</Label>
            <Textarea
              value={resolved?.body || ''}
              placeholder={t('ai.bot.template.previewEmpty')}
              rows={6}
              readOnly
              className="font-mono text-xs bg-surface-2"
            />
          </div>
        </section>

        {/* Additional instructions (tenant tweaks layered on top of the template) */}
        <section className="space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <h3 className="text-sm font-semibold text-text-primary">{t('ai.bot.additionalInstructions.title')}</h3>
              <p className="text-xs text-text-muted mt-0.5">{t('ai.bot.additionalInstructions.description')}</p>
            </div>
            <button
              type="button"
              onClick={() => setIsHelpOpen(true)}
              className="text-xs text-primary-400 hover:text-primary-300 flex items-center gap-1"
              title={t('ai.bot.instructions.faqsTooltip')}
              aria-expanded={isHelpOpen}
            >
              <HelpCircle className="w-3.5 h-3.5" /> {t('ai.bot.instructions.faqs')}
            </button>
          </div>
          <Textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder={t('ai.bot.additionalInstructions.placeholder')}
            rows={8}
            disabled={readOnly}
            className="font-mono text-xs"
          />
          <p className="text-[10px] text-text-muted">
            {t('ai.bot.instructions.placeholders')} <code className="text-primary-400">{placeholderHint}</code>
          </p>
        </section>
      </div>

      {/* Go to KB + auto-save status */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 pt-4 border-t border-edge">
        <Button
          onClick={handleGoToKnowledgeBase}
          size="lg"
          className="bg-primary-600 hover:bg-primary-500 text-white"
        >
          {t('ai.bot.actions.goToKnowledgeBase')}
          <ArrowRight className="w-4 h-4 ml-2" />
        </Button>
        {isAdmin && <AutoSaveStatusIndicator status={status} onRetry={retry} />}
      </div>

      <BotInstructionsHelpDrawer
        isOpen={isHelpOpen}
        onClose={() => setIsHelpOpen(false)}
      />

      <AlertDialog open={showLeaveDialog} onOpenChange={setShowLeaveDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('ai.bot.dialogs.leaveWithInvalid.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('ai.bot.dialogs.leaveWithInvalid.description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('ai.bot.dialogs.leaveWithInvalid.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmLeave}>{t('ai.bot.dialogs.leaveWithInvalid.confirm')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default AiBotForm;
