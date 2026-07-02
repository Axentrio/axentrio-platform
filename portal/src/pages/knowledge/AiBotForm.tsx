import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles, ArrowRight, X, Fingerprint, Boxes, PenLine } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from '@/components/ui/accordion';
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
import { useOrganization } from '@clerk/clerk-react';
import {
  useBotAiSettings,
  useUpdateBotAiSettings,
  useBotTemplates,
  useBindBotTemplate,
  useSkillReadiness,
  useBotDetail,
  useUpdateBot,
  type BusinessHours,
  type WeekDay,
} from '@/queries/useBotsQueries';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { InlineError } from '@/components/ui/inline-error';
import { SkillStateCard } from '@/components/SkillStateCard';
import { COMPOSABLE_TEMPLATES_ENABLED } from '@/config/featureFlags';
import TagInput from './TagInput';

interface AiBotFormProps {
  /** The bot whose AI config this form edits (per-bot config editing). */
  botId: string;
  onGoToKnowledgeBase: () => void;
}

// Operational, tenant-owned business hours. Full lowercase weekday names — must
// match the API/runtime off-hours check (Intl `weekday: 'long'`).
const WEEK_DAYS: WeekDay[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
type DaySchedule = BusinessHours['schedule'][number];

/** A full 7-day schedule, merging stored rows over a sensible default (9–5, weekends closed). */
function buildSchedule(stored: BusinessHours['schedule'] | undefined): DaySchedule[] {
  const byDay = new Map((stored ?? []).map((s) => [s.day, s]));
  return WEEK_DAYS.map(
    (day) => byDay.get(day) ?? { day, open: '09:00', close: '17:00', closed: day === 'saturday' || day === 'sunday' },
  );
}

const businessHoursKey = (enabled: boolean, tz: string, schedule: DaySchedule[]): string =>
  JSON.stringify({ enabled, tz, schedule });

// Quick-set presets so the common cases don't require touching the 7-row grid.
const PRESET_WEEKDAYS: DaySchedule[] = WEEK_DAYS.map((day) => ({ day, open: '09:00', close: '17:00', closed: day === 'saturday' || day === 'sunday' }));
const PRESET_EVERYDAY: DaySchedule[] = WEEK_DAYS.map((day) => ({ day, open: '09:00', close: '17:00', closed: false }));

const TONE_PRESETS = [
  { value: 'friendly', labelKey: 'ai.bot.identity.tones.friendly' },
  { value: 'professional', labelKey: 'ai.bot.identity.tones.professional' },
  { value: 'casual', labelKey: 'ai.bot.identity.tones.casual' },
  { value: 'formal', labelKey: 'ai.bot.identity.tones.formal' },
] as const;

type FormSnapshot = {
  enabled: boolean;
  botName: string;
  businessName: string;
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
  selectedSpecialties: string[];
  templateVariables: Record<string, string>;
};

const snapshotKey = (s: FormSnapshot): string => JSON.stringify(s);

/** A consistent settings section: an icon-led header + a card body. Turns the
 *  form's flat stack of headings into scannable, grouped cards. */
const Section: React.FC<{
  icon: React.ElementType;
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}> = ({ icon: Icon, title, description, action, children }) => (
  <section className="overflow-hidden rounded-xl border border-edge bg-surface-1">
    <div className="flex items-start justify-between gap-3 border-b border-edge/60 px-5 py-3.5">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-primary-400">
          <Icon className="h-4 w-4" />
        </span>
        <div>
          <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
          {description && <p className="mt-0.5 text-xs text-text-muted">{description}</p>}
        </div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
    <div className="space-y-4 p-5">{children}</div>
  </section>
);

const computeEffectiveTone = (tone: string, customTone: string): string => {
  const isCustom = !TONE_PRESETS.some((p) => p.value === tone);
  return isCustom ? (customTone.trim() || 'custom') : tone;
};

const AiBotForm: React.FC<AiBotFormProps> = ({ botId, onGoToKnowledgeBase }) => {
  const { t } = useTranslation();
  const { isRole, tenantId } = useAppAuth();
  // The org/business name — the inherited default for a bot's business name when
  // no per-bot override is set (shown as the field's placeholder).
  const { organization } = useOrganization();
  const orgBusinessName = organization?.name ?? '';
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
  // Phase 6 skill-state badges — gated behind the composable-templates flag (same
  // gate as the Phase-5 editor, for a coherent rollout).
  const { data: skillReadiness } = useSkillReadiness(botId, {
    enabled: isAdminOrSupervisor && COMPOSABLE_TEMPLATES_ENABLED,
  });

  // Business hours (operational, tenant-owned). Its own resource (bot settings),
  // saved explicitly with its own button — separate from the auto-saved AI form.
  const { data: botDetail } = useBotDetail(botId, { enabled: isAdminOrSupervisor });
  const updateBot = useUpdateBot();

  // Form state
  const [enabled, setEnabled] = useState(false);
  const [botName, setBotName] = useState('');
  const [businessName, setBusinessName] = useState('');
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
  const [selectedSpecialties, setSelectedSpecialties] = useState<string[]>([]);
  // Tenant-filled values for the bound template's custom {placeholders}.
  const [templateVarValues, setTemplateVarValues] = useState<Record<string, string>>({});
  // Business hours editor state (hydrated from the bot detail, saved separately).
  const [bhEnabled, setBhEnabled] = useState(false);
  const [bhTimezone, setBhTimezone] = useState('UTC');
  const [bhSchedule, setBhSchedule] = useState<DaySchedule[]>(() => buildSchedule(undefined));
  const [bhBaseline, setBhBaseline] = useState<string | null>(null);
  const bhHydratedKeyRef = useRef<string | null>(null);
  // Baseline snapshot captured at hydration. Stays fixed until tenant change;
  // useAutoSave maintains its own moving "last saved" baseline on top of this.
  const [initialSnapshot, setInitialSnapshot] = useState<string | null>(null);
  // Open state for the unsaved-changes navigation dialog (Go to Knowledge Base).
  const [showLeaveDialog, setShowLeaveDialog] = useState(false);

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
    const hBusinessName = aiSettings.brandVoice?.businessName ?? '';
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
    const hSpecialties = (aiSettings.selectedSpecialties ?? []) as string[];
    const hTemplateVars = ((aiSettings as { templateVariables?: Record<string, string> }).templateVariables) ?? {};

    setEnabled(hEnabled);
    setBotName(hBotName);
    setBusinessName(hBusinessName);
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
    setSelectedSpecialties(hSpecialties);
    setTemplateVarValues(hTemplateVars);

    setInitialSnapshot(snapshotKey({
      enabled: hEnabled,
      botName: hBotName,
      businessName: hBusinessName,
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
      selectedSpecialties: hSpecialties,
      templateVariables: hTemplateVars,
    }));
  }, [aiSettings, tenantId, hydrationKey]);

  // Hydrate business hours once per (tenant, bot), mirroring the AI-form guard so
  // refetches don't clobber in-progress edits.
  useEffect(() => {
    if (!botDetail || !tenantId) return;
    if (bhHydratedKeyRef.current === hydrationKey) return;
    bhHydratedKeyRef.current = hydrationKey;
    const bh = botDetail.businessHours;
    const sched = buildSchedule(bh?.schedule);
    setBhEnabled(bh?.enabled ?? false);
    setBhTimezone(bh?.timezone || 'UTC');
    setBhSchedule(sched);
    setBhBaseline(businessHoursKey(bh?.enabled ?? false, bh?.timezone || 'UTC', sched));
  }, [botDetail, tenantId, hydrationKey]);

  const bhDirty = bhBaseline !== null && businessHoursKey(bhEnabled, bhTimezone, bhSchedule) !== bhBaseline;

  const setDay = (day: WeekDay, patch: Partial<DaySchedule>) =>
    setBhSchedule((prev) => prev.map((d) => (d.day === day ? { ...d, ...patch } : d)));

  const saveBusinessHours = async () => {
    await updateBot.mutateAsync({ id: botId, businessHours: { enabled: bhEnabled, timezone: bhTimezone, schedule: bhSchedule } });
    setBhBaseline(businessHoursKey(bhEnabled, bhTimezone, bhSchedule));
  };

  const effectiveTone = isCustomTone ? (customTone.trim() || 'custom') : tone;

  const currentSnapshotKey = snapshotKey({
    enabled,
    botName,
    businessName,
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
    selectedSpecialties,
    templateVariables: templateVarValues,
  });

  // Specialties available for this bot's vertical (from the GET ai-settings response).
  const availableSpecialties = (aiSettings?.availableSpecialties ?? []) as Array<{
    key: string; name: string; description: string; requiresSpecialPrompt: boolean;
  }>;
  // Toggle, rebuilding the selection in catalog order so the autosave snapshot is
  // stable regardless of click order.
  const toggleSpecialty = (key: string) =>
    setSelectedSpecialties((prev) => {
      const has = prev.includes(key);
      return availableSpecialties.map((s) => s.key).filter((k) => (k === key ? !has : prev.includes(k)));
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
            // Trimmed; blank means "inherit the business name" (backend omits it).
            businessName: businessName.trim(),
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
          selectedSpecialties,
          templateVariables: templateVarValues,
        },
        { onSuccess, onError },
      );
    },
    [updateSettings, enabled, supportEmail, botName, businessName, effectiveTone, systemPrompt, greetingMessage, fallbackMessage, offHoursMessage, confidenceThreshold, maxResponseLength, escalationKeywords, topicsToAvoid, selectedSpecialties, templateVarValues],
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

  // Template bindings (up to 3, AND/OR) — saved immediately, separate from the
  // auto-saved form. The query is the source of truth.
  const bindings = templateView?.bindings ?? [];
  const templateMode = templateView?.mode ?? 'or';
  const availableTemplates = templateView?.available ?? [];
  const missingModules = templateView?.missingModules ?? [];
  const bindingsInput = bindings.map((b) => ({ templateId: b.templateId, version: b.version }));

  // Skill labelling + per-skill state, for the "what this speciality gives" pills.
  const skillNames = templateView?.skillNames ?? {};
  const skillLabel = (id: string) => skillNames[id] ?? id.replace(/[_-]/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  const skillStateById: Record<string, string> = {};
  for (const s of skillReadiness ?? []) skillStateById[s.id] = s.state;
  // Short amber footnote for a skill that isn't ready to use yet.
  const skillIssue = (state?: string): string | null => {
    switch (state) {
      case 'unconfigured': return t('ai.bot.template.skillIssue.unconfigured', { defaultValue: 'needs setup' });
      case 'unentitled': return t('ai.bot.template.skillIssue.unentitled', { defaultValue: 'not in plan' });
      case 'disabled': return t('ai.bot.template.skillIssue.disabled', { defaultValue: 'turned off' });
      case 'absent': return t('ai.bot.template.skillIssue.absent', { defaultValue: 'unavailable' });
      case 'error': return t('ai.bot.template.skillIssue.error', { defaultValue: 'error' });
      default: return null;
    }
  };

  const saveBindings = (next: { templateId: string; version: string }[], nextMode: 'and' | 'or' = templateMode) => {
    // Empty is allowed — an explicit unbind leaves the bot blank (generic KB bot).
    bindTemplate.mutate({ bindings: next, mode: nextMode });
  };
  // Toggle a template in/out of the binding set (cap 3); selecting defaults to 'latest'.
  const toggleTemplate = (id: string) => {
    const has = bindings.some((b) => b.templateId === id);
    if (has) {
      saveBindings(bindingsInput.filter((b) => b.templateId !== id));
    } else if (bindings.length < 3) {
      saveBindings([...bindingsInput, { templateId: id, version: 'latest' }]);
    }
  };
  const setVersionFor = (id: string, version: string) =>
    saveBindings(bindingsInput.map((b) => (b.templateId === id ? { ...b, version } : b)));

  const readOnly = !isAdmin;


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
        <Section icon={Fingerprint} title={t('ai.bot.identity.title')} description={t('ai.bot.identity.description')}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label className="mb-1 text-text-secondary">{t('ai.bot.identity.businessName.label')}</Label>
              <Input
                value={businessName}
                onChange={(e) => setBusinessName(e.target.value)}
                placeholder={orgBusinessName || t('ai.bot.identity.businessName.placeholder')}
                disabled={readOnly}
              />
              <p className="text-[10px] text-text-muted mt-1">
                {orgBusinessName
                  ? t('ai.bot.identity.businessName.helperInherit', { name: orgBusinessName })
                  : t('ai.bot.identity.businessName.helper')}
              </p>
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
            <div>
              <Label className="mb-1 text-text-secondary">{t('ai.bot.identity.voiceTone.label')}</Label>
              <Select
                value={isCustomTone ? '__custom__' : tone}
                onValueChange={(v) => {
                  if (v === '__custom__') setTone(customTone || 'custom');
                  else { setTone(v); setCustomTone(''); }
                }}
                disabled={readOnly}
              >
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TONE_PRESETS.map((p) => (
                    <SelectItem key={p.value} value={p.value}>{t(p.labelKey)}</SelectItem>
                  ))}
                  <SelectItem value="__custom__">{t('ai.bot.identity.tones.custom')}</SelectItem>
                </SelectContent>
              </Select>
              {isCustomTone && (
                <Input
                  className="mt-1.5"
                  value={customTone}
                  onChange={(e) => { setCustomTone(e.target.value); setTone(e.target.value || 'custom'); }}
                  placeholder={t('ai.bot.identity.customTone.placeholder')}
                  disabled={readOnly}
                />
              )}
              <p className="text-[10px] text-text-muted mt-1">{t('ai.bot.identity.voiceTone.helper')}</p>
            </div>
          </div>
        </Section>

        {/* Bot Templates (specialities, managed centrally; bind up to 3, AND/OR) */}
        <Section
          icon={Boxes}
          title={t('ai.bot.template.title')}
          description={t('ai.bot.template.descriptionMulti')}
          action={availableTemplates.length > 0 ? (
            <span className="whitespace-nowrap text-[11px] text-text-muted">{t('ai.bot.template.selectedCount', { count: bindings.length })}</span>
          ) : undefined}
        >
          {availableTemplates.length === 0 ? (
            <div className="rounded-lg border border-edge bg-surface-2 p-3 text-xs text-text-muted">
              {t('ai.bot.template.noneAvailable')}
            </div>
          ) : (
            <>
              {/* Add a speciality — Select listing only the not-yet-selected templates (cap 3). */}
              {(() => {
                const unselected = availableTemplates.filter((x) => !bindings.some((b) => b.templateId === x.id));
                const atCap = bindings.length >= 3;
                return (
                  <Select value="" onValueChange={(id) => toggleTemplate(id)} disabled={readOnly || bindTemplate.isPending || atCap || unselected.length === 0}>
                    <SelectTrigger className="h-9" aria-label={t('ai.bot.template.addPlaceholder')}>
                      <SelectValue placeholder={atCap ? t('ai.bot.template.maxReached') : t('ai.bot.template.addPlaceholder')} />
                    </SelectTrigger>
                    <SelectContent>
                      {unselected.map((tpl) => (
                        <SelectItem key={tpl.id} value={tpl.id}>
                          <span className="flex flex-col gap-0.5">
                            <span>{tpl.displayName}</span>
                            {tpl.description && <span className="text-[11px] text-text-muted">{tpl.description}</span>}
                            {(tpl.skills?.length ?? 0) > 0 && (
                              <span className="text-[10px] text-text-muted">
                                {t('ai.bot.template.gives', { defaultValue: 'Gives' })}: {(tpl.skills ?? []).map(skillLabel).join(' · ')}
                              </span>
                            )}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                );
              })()}

              {/* Selected specialities as cards — name + version + remove, and the
                  skills each one gives the bot (state-coloured pills). */}
              {bindings.length > 0 && (
                <div className="space-y-2">
                  {bindings.map((b) => {
                    const tpl = availableTemplates.find((x) => x.id === b.templateId);
                    const skills = tpl?.skills ?? [];
                    return (
                      <div key={b.templateId} className="rounded-xl border border-edge bg-surface-2 p-4">
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium text-text-primary">{tpl?.displayName ?? t('ai.bot.template.unknownTemplate')}</div>
                            {tpl?.description && <div className="truncate text-[11px] text-text-muted">{tpl.description}</div>}
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            {b.publishedVersions.length > 0 && (
                              <Select value={b.version} onValueChange={(v) => setVersionFor(b.templateId, v)} disabled={readOnly || bindTemplate.isPending}>
                                <SelectTrigger className="h-7 gap-1 rounded-full border border-edge bg-surface-3 px-2.5 text-[11px] text-text-secondary" title={b.version === 'latest' ? t('ai.bot.template.latest') : t('ai.bot.template.pinTo', { version: b.version })}>
                                  {b.version === 'latest' ? t('ai.bot.template.latestShort', { defaultValue: 'Latest' }) : `v${b.version}`}
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="latest">{t('ai.bot.template.latest')}</SelectItem>
                                  {b.publishedVersions.map((v) => (
                                    <SelectItem key={v} value={String(v)}>{t('ai.bot.template.pinTo', { version: v })}</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            )}
                            {!readOnly && (
                              <button type="button" onClick={() => toggleTemplate(b.templateId)} aria-label={t('ai.bot.template.removeAria')} className="rounded-full p-1 text-text-muted hover:bg-surface-3 hover:text-text-primary">
                                <X className="h-4 w-4" />
                              </button>
                            )}
                          </div>
                        </div>
                        {skills.length > 0 && (
                          <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-edge/50 pt-3">
                            <span className="mr-0.5 text-[10px] uppercase tracking-wide text-text-muted">{t('ai.bot.template.gives', { defaultValue: 'Gives' })}</span>
                            {skills.map((id) => {
                              const issue = skillIssue(skillStateById[id]);
                              return (
                                <span key={id} className="inline-flex items-center gap-1.5 rounded-md bg-surface-3 px-2 py-1 text-[11px] text-text-secondary">
                                  <span className={`h-1.5 w-1.5 rounded-full ${issue ? 'bg-amber-400' : 'bg-emerald-400'}`} />
                                  {skillLabel(id)}
                                  {issue && <span className="text-amber-400/90">· {issue}</span>}
                                </span>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {bindings.length === 0 && (
                <div className="rounded-lg border border-dashed border-edge bg-surface-2 p-3 text-xs text-text-muted">
                  {t('ai.bot.template.none', { defaultValue: 'No speciality bound — this bot answers generically from your knowledge base only. Add one above to give it skills like booking, lead capture, or handoff.' })}
                </div>
              )}

              {bindings.filter((b) => b.pinnedButUnavailable).map((b) => (
                <p key={'p' + b.templateId} className="text-[11px] text-amber-400">{t('ai.bot.template.warnings.pinned')}</p>
              ))}
              {bindings.filter((b) => b.templateUnavailable).map((b) => (
                <p key={'u' + b.templateId} className="text-[11px] text-amber-400">{t('ai.bot.template.warnings.unavailable')}</p>
              ))}
            </>
          )}

          {/* AND / OR — only meaningful with more than one speciality */}
          {bindings.length > 1 && (
            <div className="rounded-lg border border-edge p-3 space-y-2">
              <Label className="text-text-secondary">{t('ai.bot.template.modeLabel')}</Label>
              <div className="flex gap-2">
                <Button type="button" size="sm" variant={templateMode === 'or' ? 'default' : 'outline'} disabled={readOnly || bindTemplate.isPending} onClick={() => saveBindings(bindingsInput, 'or')}>
                  {t('ai.bot.template.modeOr')}
                </Button>
                <Button type="button" size="sm" variant={templateMode === 'and' ? 'default' : 'outline'} disabled={readOnly || bindTemplate.isPending} onClick={() => saveBindings(bindingsInput, 'and')}>
                  {t('ai.bot.template.modeAnd')}
                </Button>
              </div>
              <p className="text-[10px] text-text-muted">{templateMode === 'or' ? t('ai.bot.template.modeOrHelp') : t('ai.bot.template.modeAndHelp')}</p>
            </div>
          )}

          {/* Legacy advisory — only when the composable per-skill states aren't shown. */}
          {!COMPOSABLE_TEMPLATES_ENABLED && missingModules.length > 0 && (
            <p className="text-[11px] text-amber-400">
              {t('ai.bot.template.warnings.missingModules', { modules: missingModules.join(', ') })}{' '}
              {t('ai.bot.template.warnings.missingModulesAction')}
            </p>
          )}

          {/* Actionable remedies only for skills that aren't ready yet — the ready ones
              already show as green pills on their speciality card above. */}
          {COMPOSABLE_TEMPLATES_ENABLED && (skillReadiness ?? []).some((s) => s.state !== 'ready') && (
            <div className="space-y-1.5">
              {(skillReadiness ?? []).filter((s) => s.state !== 'ready').map((skill) => (
                <SkillStateCard key={skill.id} skill={skill} />
              ))}
            </div>
          )}
        </Section>

        {/* Your template details — the custom {placeholders} the bound template declares
            for the tenant to complete. Saved into ai.templateVariables; substituted into
            the prompt at runtime (an unfilled field falls back to the template's default). */}
        {(templateView?.variables?.length ?? 0) > 0 && (
          <Section
            icon={PenLine}
            title={t('ai.bot.templateDetails.title', { defaultValue: 'Your template details' })}
            description={t('ai.bot.templateDetails.subtitle', { defaultValue: "Your bot's template asks for a few details — they're filled into its prompt where the template expects them." })}
          >
            <div className="space-y-3">
              {(templateView?.variables ?? []).map((v) => {
                const value = templateVarValues[v.key] ?? v.default ?? '';
                const missing = !!v.required && !value.trim();
                return (
                  <div key={v.key} className="space-y-1">
                    <label htmlFor={`tv-${v.key}`} className="flex items-center gap-1.5 text-xs font-medium text-text-secondary">
                      {v.label || v.key}
                      {v.required && <span className="text-amber-400">*</span>}
                    </label>
                    <textarea
                      id={`tv-${v.key}`}
                      rows={2}
                      readOnly={readOnly}
                      value={value}
                      onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setTemplateVarValues((prev) => ({ ...prev, [v.key]: e.target.value }))}
                      className={`w-full rounded-lg border bg-surface-2 px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40 disabled:opacity-50 ${missing ? 'border-amber-500/50' : 'border-edge'}`}
                    />
                    {v.help && <p className="text-[11px] text-text-muted">{v.help}</p>}
                    {missing && <p className="text-[11px] text-amber-400">{t('ai.bot.templateDetails.required', { defaultValue: 'Required — your bot needs this to answer correctly.' })}</p>}
                  </div>
                );
              })}
            </div>
          </Section>
        )}

        {/* Specialties — scoped to the bot's vertical (bound template category). Only
            shown when the vertical defines specialties. Selecting biases KB retrieval;
            a specialty flagged requiresSpecialPrompt also injects its exception block. */}
        {availableSpecialties.length > 0 && (
          <Section
            icon={Sparkles}
            title="Specialties"
            description="Pick what this bot specialises in. This sharpens knowledge-base answers; some specialties also add tailored handling."
          >
            <div className="grid gap-1.5 sm:grid-cols-2">
              {availableSpecialties.map((s) => (
                <label key={s.key} className="flex items-start gap-2 rounded-lg border border-edge p-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={selectedSpecialties.includes(s.key)}
                    onChange={() => toggleSpecialty(s.key)}
                  />
                  <span>
                    <span className="font-medium text-text-primary">{s.name}</span>
                    {s.requiresSpecialPrompt && <span className="ml-1 text-[10px] text-amber-400">(special handling)</span>}
                    {s.description && <span className="block text-xs text-text-muted">{s.description}</span>}
                  </span>
                </label>
              ))}
            </div>
          </Section>
        )}


        {/* Operational settings (tenant-owned: escalation + business hours).
            Collapsed by default to keep the page lean — most tenants won't touch it. */}
        <Accordion type="single" collapsible className="w-full">
          <AccordionItem value="operational" className="rounded-xl border border-edge px-4 border-b">
            <AccordionTrigger className="hover:no-underline">
              <div className="text-left">
                <h3 className="text-sm font-semibold text-text-primary">{t('ai.bot.operational.title')}</h3>
                <p className="text-xs text-text-muted mt-0.5 font-normal">{t('ai.bot.operational.description')}</p>
              </div>
            </AccordionTrigger>
            <AccordionContent className="space-y-4">
              <div>
                <Label className="mb-1 text-text-secondary">{t('ai.bot.operational.escalationKeywords.label')}</Label>
                <TagInput
                  value={escalationKeywords}
                  onChange={setEscalationKeywords}
                  placeholder={t('ai.bot.operational.escalationKeywords.placeholder')}
                  disabled={readOnly}
                />
                <p className="text-[10px] text-text-muted mt-1">{t('ai.bot.operational.escalationKeywords.helper')}</p>
              </div>

              {/* Business hours — its own resource, saved with an explicit button. */}
              <div className="rounded-xl border border-edge p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <Label className="text-text-secondary">{t('ai.bot.operational.businessHours.label')}</Label>
                    <p className="text-[10px] text-text-muted mt-0.5">{t('ai.bot.operational.businessHours.helper')}</p>
                    <p className="text-[10px] text-text-muted">{t('ai.bot.operational.businessHours.alwaysOnHint')}</p>
                  </div>
                  <Switch checked={bhEnabled} onCheckedChange={setBhEnabled} disabled={readOnly} />
                </div>

                {bhEnabled && (
                  <>
                    {!readOnly && (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[10px] text-text-muted">{t('ai.bot.operational.businessHours.presetsLabel')}</span>
                        <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={() => setBhSchedule(PRESET_WEEKDAYS)}>
                          {t('ai.bot.operational.businessHours.presetWeekdays')}
                        </Button>
                        <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={() => setBhSchedule(PRESET_EVERYDAY)}>
                          {t('ai.bot.operational.businessHours.presetEveryday')}
                        </Button>
                      </div>
                    )}
                    <div className="max-w-xs">
                      <Label className="mb-1 text-text-secondary">{t('ai.bot.operational.businessHours.timezone')}</Label>
                      <Input
                        value={bhTimezone}
                        onChange={(e) => setBhTimezone(e.target.value)}
                        placeholder="America/New_York"
                        disabled={readOnly}
                      />
                    </div>
                    <div className="space-y-1.5">
                      {bhSchedule.map((d) => (
                        <div key={d.day} className="flex items-center gap-2 text-sm">
                          <span className="w-24 capitalize text-text-secondary">{d.day}</span>
                          <Switch
                            checked={!d.closed}
                            onCheckedChange={(open) => setDay(d.day, { closed: !open })}
                            disabled={readOnly}
                            aria-label={`${d.day} open`}
                          />
                          {d.closed ? (
                            <span className="text-xs text-text-muted">{t('ai.bot.operational.businessHours.closed')}</span>
                          ) : (
                            <div className="flex items-center gap-1.5">
                              <Input type="time" className="h-8 w-28" value={d.open} onChange={(e) => setDay(d.day, { open: e.target.value })} disabled={readOnly} />
                              <span className="text-text-muted">–</span>
                              <Input type="time" className="h-8 w-28" value={d.close} onChange={(e) => setDay(d.day, { close: e.target.value })} disabled={readOnly} />
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </>
                )}

                {!readOnly && (
                  <div className="flex justify-end">
                    <Button variant="outline" size="sm" onClick={saveBusinessHours} disabled={!bhDirty || updateBot.isPending}>
                      {t('ai.bot.operational.businessHours.save')}
                    </Button>
                  </div>
                )}
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
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
