import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, RotateCcw, HelpCircle, Sparkles, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
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
import { useGetAiSettings, useUpdateAiSettings } from '@/queries/useKnowledgeQueries';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { InlineError } from '@/components/ui/inline-error';
import TagInput from './TagInput';
import { promptTemplates, findTemplate, AI_PLACEHOLDERS } from './aiBotTemplates';
import HelpFaqDialog from './HelpFaqDialog';

interface AiBotFormProps {
  onGoToKnowledgeBase: () => void;
}

const TONE_PRESETS = [
  { value: 'friendly', label: 'Friendly' },
  { value: 'professional', label: 'Professional' },
  { value: 'casual', label: 'Casual' },
  { value: 'formal', label: 'Formal' },
] as const;

type FormSnapshot = {
  enabled: boolean;
  botName: string;
  supportEmail: string;
  effectiveTone: string;
  templateId: string;
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

const AiBotForm: React.FC<AiBotFormProps> = ({ onGoToKnowledgeBase }) => {
  const { isRole, tenantId } = useAppAuth();
  const isAdmin = isRole('admin');
  const isAdminOrSupervisor = isRole(['admin', 'supervisor']);

  // Track which tenant's settings have already populated the form. Refetches /
  // query invalidations for the same tenant must not clobber in-flight edits;
  // a tenant switch should re-hydrate from the new tenant's data.
  const hydratedTenantRef = useRef<string | null>(null);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: aiSettings, isLoading, error } = useGetAiSettings({ enabled: isAdminOrSupervisor }) as { data: any; isLoading: boolean; error: any };
  const updateSettings = useUpdateAiSettings();

  // Form state
  const [enabled, setEnabled] = useState(false);
  const [botName, setBotName] = useState('');
  const [supportEmail, setSupportEmail] = useState('');
  const [tone, setTone] = useState('friendly');
  const [customTone, setCustomTone] = useState('');
  const [templateId, setTemplateId] = useState<string>('blank');
  const [systemPrompt, setSystemPrompt] = useState('');
  // Body that was applied last time a template was selected (or hydrated from server).
  // Compared against systemPrompt to detect unsaved edits before replacing.
  const [lastAppliedBody, setLastAppliedBody] = useState('');
  const [greetingMessage, setGreetingMessage] = useState('');
  const [fallbackMessage, setFallbackMessage] = useState('');
  const [offHoursMessage, setOffHoursMessage] = useState('');
  const [confidenceThreshold, setConfidenceThreshold] = useState(0.7);
  const [maxResponseLength, setMaxResponseLength] = useState(500);
  const [escalationKeywords, setEscalationKeywords] = useState<string[]>([]);
  const [topicsToAvoid, setTopicsToAvoid] = useState<string[]>([]);
  // Snapshot of the form at last hydrate / successful save.
  // null until hydration runs — prevents false dirty signal during initial load.
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(null);
  // Pending template ID awaiting confirmation when switching templates over edited instructions.
  const [pendingTemplateId, setPendingTemplateId] = useState<string | null>(null);
  // Open state for the unsaved-changes navigation dialog (Go to Knowledge Base).
  const [showLeaveDialog, setShowLeaveDialog] = useState(false);
  const [isFaqOpen, setIsFaqOpen] = useState(false);

  const isCustomTone = !TONE_PRESETS.some((p) => p.value === tone);

  // Hydrate from server once per tenant. Skips on refetches/invalidations
  // for the already-loaded tenant so the user's in-progress edits survive.
  useEffect(() => {
    if (!aiSettings) return;
    if (!tenantId) return;
    if (hydratedTenantRef.current === tenantId) return;
    hydratedTenantRef.current = tenantId;

    const hEnabled = aiSettings.enabled ?? false;
    const hBotName = aiSettings.brandVoice?.name ?? '';
    const hSupportEmail = aiSettings.supportEmail ?? '';
    const serverTone: string = aiSettings.brandVoice?.tone ?? 'friendly';
    const isPreset = TONE_PRESETS.some((p) => p.value === serverTone);
    const hTone = serverTone;
    const hCustomTone = isPreset ? '' : serverTone;
    const hSystemPrompt = aiSettings.brandVoice?.customInstructions ?? '';
    // Treat the saved instruction text as the source of truth: if the saved
    // templateId no longer matches a known template (renamed/removed since
    // last save), fall back to 'blank' rather than confusing the dropdown.
    const savedTemplateId: string | null | undefined = aiSettings.brandVoice?.templateId;
    const hTemplateId = savedTemplateId && findTemplate(savedTemplateId)
      ? savedTemplateId
      : 'blank';
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
    setTemplateId(hTemplateId);
    setSystemPrompt(hSystemPrompt);
    setLastAppliedBody(hSystemPrompt);
    setGreetingMessage(hGreeting);
    setFallbackMessage(hFallback);
    setOffHoursMessage(hOffHours);
    setConfidenceThreshold(hConfidence);
    setMaxResponseLength(hMaxLen);
    setEscalationKeywords(hEscalation);
    setTopicsToAvoid(hTopics);

    setSavedSnapshot(snapshotKey({
      enabled: hEnabled,
      botName: hBotName,
      supportEmail: hSupportEmail,
      effectiveTone: computeEffectiveTone(hTone, hCustomTone),
      templateId: hTemplateId,
      systemPrompt: hSystemPrompt,
      greetingMessage: hGreeting,
      fallbackMessage: hFallback,
      offHoursMessage: hOffHours,
      confidenceThreshold: hConfidence,
      maxResponseLength: hMaxLen,
      escalationKeywords: hEscalation,
      topicsToAvoid: hTopics,
    }));
  }, [aiSettings, tenantId]);

  const applyTemplate = (id: string) => {
    const tpl = findTemplate(id);
    const nextBody = tpl?.body ?? '';
    setTemplateId(id);
    setSystemPrompt(nextBody);
    setLastAppliedBody(nextBody);
  };

  const handleTemplateChange = (id: string) => {
    if (id === templateId) return;
    const hasUnsavedEdits = systemPrompt.trim() !== lastAppliedBody.trim();
    if (hasUnsavedEdits) {
      // Defer the actual switch until the user confirms in the dialog.
      // Leaving templateId unchanged keeps the Radix Select on its prior value.
      setPendingTemplateId(id);
      return;
    }
    applyTemplate(id);
  };

  const handleResetPrompt = () => {
    const tpl = findTemplate(templateId);
    if (!tpl) return;
    setSystemPrompt(tpl.body);
    setLastAppliedBody(tpl.body);
  };

  const handleToneChipClick = (value: string) => {
    setTone(value);
    setCustomTone('');
  };

  const handleCustomToneToggle = () => {
    setTone(customTone || 'custom');
  };

  const effectiveTone = isCustomTone ? (customTone.trim() || 'custom') : tone;

  const currentSnapshotKey = snapshotKey({
    enabled,
    botName,
    supportEmail,
    effectiveTone,
    templateId,
    systemPrompt,
    greetingMessage,
    fallbackMessage,
    offHoursMessage,
    confidenceThreshold,
    maxResponseLength,
    escalationKeywords,
    topicsToAvoid,
  });
  const isDirty = savedSnapshot !== null && currentSnapshotKey !== savedSnapshot;

  const handleGoToKnowledgeBase = () => {
    if (isDirty) {
      setShowLeaveDialog(true);
      return;
    }
    onGoToKnowledgeBase();
  };

  const confirmLeave = () => {
    setShowLeaveDialog(false);
    onGoToKnowledgeBase();
  };

  const confirmTemplateSwitch = () => {
    if (pendingTemplateId) applyTemplate(pendingTemplateId);
    setPendingTemplateId(null);
  };

  const handleSave = () => {
    const snapshotAtSave = currentSnapshotKey;
    updateSettings.mutate(
      {
        enabled,
        supportEmail: supportEmail || null,
        brandVoice: {
          name: botName || 'AI Assistant',
          tone: effectiveTone,
          customInstructions: systemPrompt,
          templateId: templateId === 'blank' ? null : templateId,
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
      {
        onSuccess: () => setSavedSnapshot(snapshotAtSave),
      }
    );
  };

  const readOnly = !isAdmin;

  const placeholderHint = useMemo(() => AI_PLACEHOLDERS.join('  '), []);

  if (!isAdminOrSupervisor) {
    return (
      <div className="py-16 text-center text-sm text-text-muted">
        You don't have permission to view AI settings.
      </div>
    );
  }

  if (isLoading) return <PageSkeleton variant="cards" />;
  if (error) return <InlineError message="Failed to load AI settings" />;

  return (
    <div className="max-w-3xl space-y-8">
      {/* Enable bar */}
      <div className="flex items-center justify-between p-4 rounded-xl bg-surface-2">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-surface-3">
            <Sparkles className="w-4 h-4 text-primary-400" />
          </div>
          <div>
            <p className="text-sm font-medium text-text-primary">AI Bot</p>
            <p className="text-xs text-text-muted">Enable AI-powered responses for visitors</p>
          </div>
        </div>
        <Switch checked={enabled} onCheckedChange={setEnabled} disabled={readOnly} />
      </div>

      <div className={enabled ? 'space-y-8' : 'space-y-8 opacity-50 pointer-events-none'}>
        {/* Bot Identity */}
        <section className="space-y-4">
          <div>
            <h3 className="text-sm font-semibold text-text-primary">Bot Identity</h3>
            <p className="text-xs text-text-muted mt-0.5">How your bot introduces itself to visitors</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label className="mb-1 text-text-secondary">Chatbot Name</Label>
              <Input
                value={botName}
                onChange={(e) => setBotName(e.target.value)}
                placeholder="e.g. Ava"
                disabled={readOnly}
              />
              <p className="text-[10px] text-text-muted mt-1">Chatbot display name for users to see on the website.</p>
            </div>
            <div>
              <Label className="mb-1 text-text-secondary">Support Email</Label>
              <Input
                type="email"
                value={supportEmail}
                onChange={(e) => setSupportEmail(e.target.value)}
                placeholder="support@yourcompany.com"
                disabled={readOnly}
              />
              <p className="text-[10px] text-text-muted mt-1">Used for escalations and visible via {'{supportEmail}'}</p>
            </div>
          </div>
          <div>
            <Label className="mb-2 text-text-secondary">Voice Tone</Label>
            <div className="flex flex-wrap gap-2">
              {TONE_PRESETS.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  onClick={() => !readOnly && handleToneChipClick(p.value)}
                  disabled={readOnly}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                    tone === p.value && !isCustomTone
                      ? 'bg-primary-500 text-white'
                      : 'bg-surface-2 text-text-muted hover:text-text-secondary'
                  }`}
                >
                  {p.label}
                </button>
              ))}
              <button
                type="button"
                onClick={() => !readOnly && handleCustomToneToggle()}
                disabled={readOnly}
                className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                  isCustomTone
                    ? 'bg-primary-500 text-white'
                    : 'bg-surface-2 text-text-muted hover:text-text-secondary'
                }`}
              >
                Custom
              </button>
            </div>
            {isCustomTone && (
              <Input
                className="mt-2 max-w-sm"
                value={customTone}
                onChange={(e) => {
                  setCustomTone(e.target.value);
                  setTone(e.target.value || 'custom');
                }}
                placeholder="e.g. witty, concise, no emojis"
                disabled={readOnly}
              />
            )}
          </div>
        </section>

        {/* Base System Prompt */}
        <section className="space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <h3 className="text-sm font-semibold text-text-primary">Bot Instructions</h3>
              <p className="text-xs text-text-muted mt-0.5">Tell the chatbot how it should answer visitors. You can start from a template and edit it.</p>
            </div>
            <div className="flex items-center gap-2">
              <Select value={templateId} onValueChange={handleTemplateChange} disabled={readOnly}>
                <SelectTrigger className="h-9 w-56" aria-label="Choose a starter prompt">
                  <SelectValue placeholder="Choose a starter prompt" />
                </SelectTrigger>
                <SelectContent>
                  {promptTemplates.map((t) => (
                    <SelectItem key={t.id} value={t.id}>{t.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <button
                type="button"
                onClick={() => setIsFaqOpen(true)}
                className="text-xs text-primary-400 hover:text-primary-300 flex items-center gap-1"
                title="Open the bot instructions FAQ"
              >
                <HelpCircle className="w-3.5 h-3.5" /> FAQs
              </button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleResetPrompt}
                disabled={readOnly}
                className="h-8 px-2 text-xs"
                title="Reset to the selected template"
              >
                <RotateCcw className="w-3.5 h-3.5 mr-1" />
                Reset
              </Button>
            </div>
          </div>
          <Textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder="Write your bot's instructions here, or pick a template above…"
            rows={14}
            disabled={readOnly}
            className="font-mono text-xs"
          />
          <p className="text-[10px] text-text-muted">
            Placeholders: <code className="text-primary-400">{placeholderHint}</code>
          </p>
        </section>

        {/* Advanced Settings (flat — no accordion) */}
        <section className="space-y-4">
          <div>
            <h3 className="text-sm font-semibold text-text-primary">Advanced Settings</h3>
            <p className="text-xs text-text-muted mt-0.5">Guardrails, handoff behavior, and response limits</p>
          </div>

          <div>
            <Label className="mb-1 text-text-secondary">Greeting Message</Label>
            <Input
              value={greetingMessage}
              onChange={(e) => setGreetingMessage(e.target.value)}
              placeholder="Hi! How can I help you today?"
              disabled={readOnly}
            />
          </div>

          <div>
            <Label className="mb-1 text-text-secondary">Fallback Message</Label>
            <Textarea
              value={fallbackMessage}
              onChange={(e) => setFallbackMessage(e.target.value)}
              placeholder="I'm connecting you to a human agent…"
              rows={2}
              disabled={readOnly}
            />
            <p className="text-[10px] text-text-muted mt-1">Shown when the bot can't answer confidently</p>
          </div>

          <div>
            <Label className="mb-1 text-text-secondary">Off-Hours Message</Label>
            <Textarea
              value={offHoursMessage}
              onChange={(e) => setOffHoursMessage(e.target.value)}
              placeholder="We're currently outside business hours…"
              rows={2}
              disabled={readOnly}
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label className="mb-2 text-text-secondary">
                Confidence Threshold: {confidenceThreshold.toFixed(2)}
              </Label>
              <Slider
                value={[confidenceThreshold]}
                onValueChange={([v]) => setConfidenceThreshold(v)}
                min={0}
                max={1}
                step={0.05}
                disabled={readOnly}
              />
              <p className="text-[10px] text-text-muted mt-1">Below this, bot hands off to an agent</p>
            </div>
            <div>
              <Label className="mb-1 text-text-secondary">Max Response Length</Label>
              <Input
                type="number"
                value={maxResponseLength}
                onChange={(e) => setMaxResponseLength(parseInt(e.target.value) || 0)}
                disabled={readOnly}
              />
              <p className="text-[10px] text-text-muted mt-1">Characters</p>
            </div>
          </div>

          <div>
            <Label className="mb-1 text-text-secondary">Escalation Keywords</Label>
            <TagInput
              value={escalationKeywords}
              onChange={setEscalationKeywords}
              placeholder="Type a keyword and press Enter…"
              disabled={readOnly}
            />
            <p className="text-[10px] text-text-muted mt-1">Messages containing these trigger handoff</p>
          </div>

          <div>
            <Label className="mb-1 text-text-secondary">Topics to Avoid</Label>
            <TagInput
              value={topicsToAvoid}
              onChange={setTopicsToAvoid}
              placeholder="Type a topic and press Enter…"
              disabled={readOnly}
            />
          </div>
        </section>
      </div>

      {/* Save + Go to KB */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 pt-4 border-t border-edge">
        <Button
          onClick={handleGoToKnowledgeBase}
          size="lg"
          className="bg-primary-600 hover:bg-primary-500 text-white"
        >
          Go to Knowledge Base
          <ArrowRight className="w-4 h-4 ml-2" />
        </Button>
        {isAdmin && (
          <Button onClick={handleSave} disabled={updateSettings.isPending} size="lg" variant="outline">
            {updateSettings.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Save Changes
          </Button>
        )}
      </div>

      <AlertDialog
        open={pendingTemplateId !== null}
        onOpenChange={(open) => { if (!open) setPendingTemplateId(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace edited instructions?</AlertDialogTitle>
            <AlertDialogDescription>
              Switching templates will replace your current bot instructions. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction onClick={confirmTemplateSwitch}>Replace</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <HelpFaqDialog
        isOpen={isFaqOpen}
        onClose={() => setIsFaqOpen(false)}
        defaultSectionId="ai-bot"
      />

      <AlertDialog open={showLeaveDialog} onOpenChange={setShowLeaveDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave without saving?</AlertDialogTitle>
            <AlertDialogDescription>
              You have unsaved changes. Go to Knowledge Base without saving?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Stay here</AlertDialogCancel>
            <AlertDialogAction onClick={confirmLeave}>Leave anyway</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default AiBotForm;
