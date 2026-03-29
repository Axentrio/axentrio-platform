import React, { useState, useEffect } from 'react';
import { Loader2, FlaskConical } from 'lucide-react';
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
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { useAppAuth } from '@/auth/useAppAuth';
import { useGetAiSettings, useUpdateAiSettings, useTestAiSettings } from '@/queries/useKnowledgeQueries';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { InlineError } from '@/components/ui/inline-error';
import TagInput from './TagInput';

const AiSettingsTab: React.FC = () => {
  const { isRole } = useAppAuth();
  const isAdmin = isRole('admin');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: aiSettings, isLoading, error } = useGetAiSettings() as { data: any; isLoading: boolean; error: any };
  const updateSettings = useUpdateAiSettings();
  const testSettings = useTestAiSettings();

  const [enabled, setEnabled] = useState(false);
  const [provider, setProvider] = useState<'openai' | 'anthropic'>('openai');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [hasExistingKey, setHasExistingKey] = useState(false);
  const [botName, setBotName] = useState('');
  const [tone, setTone] = useState('friendly');
  const [customInstructions, setCustomInstructions] = useState('');
  const [greetingMessage, setGreetingMessage] = useState('');
  const [confidenceThreshold, setConfidenceThreshold] = useState(0.7);
  const [maxResponseLength, setMaxResponseLength] = useState(500);
  const [escalationKeywords, setEscalationKeywords] = useState<string[]>([]);
  const [topicsToAvoid, setTopicsToAvoid] = useState<string[]>([]);
  const [fallbackMessage, setFallbackMessage] = useState('');
  const [offHoursMessage, setOffHoursMessage] = useState('');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [testResult, setTestResult] = useState<any>(null);
  const [testFailed, setTestFailed] = useState(false);

  useEffect(() => {
    if (aiSettings) {
      setEnabled(aiSettings.enabled ?? false);
      setProvider(aiSettings.provider ?? 'openai');
      setModel(aiSettings.model ?? '');
      setHasExistingKey(aiSettings.hasApiKey ?? false);
      setBotName(aiSettings.brandVoice?.name ?? '');
      setTone(aiSettings.brandVoice?.tone ?? 'friendly');
      setCustomInstructions(aiSettings.brandVoice?.customInstructions ?? '');
      setGreetingMessage(aiSettings.guardrails?.greetingMessage ?? '');
      setConfidenceThreshold(aiSettings.guardrails?.confidenceThreshold ?? 0.7);
      setMaxResponseLength(aiSettings.guardrails?.maxResponseLength ?? 500);
      setEscalationKeywords(aiSettings.guardrails?.escalationKeywords ?? []);
      setTopicsToAvoid(aiSettings.guardrails?.topicsToAvoid ?? []);
      setFallbackMessage(aiSettings.guardrails?.fallbackMessage ?? '');
      setOffHoursMessage(aiSettings.guardrails?.offHoursMessage ?? '');
    }
  }, [aiSettings]);

  const handleSave = () => {
    updateSettings.mutate({
      enabled,
      provider,
      model,
      apiKey: apiKey || (hasExistingKey ? undefined : null),
      brandVoice: {
        name: botName || 'AI Assistant',
        tone,
        customInstructions,
      },
      guardrails: {
        greetingMessage,
        confidenceThreshold,
        maxResponseLength,
        escalationKeywords,
        topicsToAvoid,
        fallbackMessage,
        offHoursMessage,
      },
    });
  };

  const handleTest = () => {
    setTestResult(null);
    setTestFailed(false);
    // Send current form values directly — no save needed
    testSettings.mutate(
      { question: 'Hello, can you help me?', provider, model, apiKey: apiKey || undefined },
      {
        onSuccess: (data) => setTestResult(data),
        onError: () => setTestFailed(true),
      },
    );
  };

  if (isLoading) return <PageSkeleton variant="cards" />;
  if (error) return <InlineError message="Failed to load AI settings" />;

  const readOnly = !isAdmin;

  return (
    <div className="mt-4 space-y-5">
      {/* Enable toggle */}
      <div className="flex items-center justify-between p-4 rounded-xl bg-surface-2">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-surface-3">
            <FlaskConical className="w-4 h-4 text-primary-400" />
          </div>
          <div>
            <p className="text-sm font-medium text-text-primary">AI Bot</p>
            <p className="text-xs text-text-muted">Enable AI-powered responses for visitors</p>
          </div>
        </div>
        <Switch checked={enabled} onCheckedChange={setEnabled} disabled={readOnly} />
      </div>

      <div className={enabled ? '' : 'opacity-50 pointer-events-none'}>
        <Accordion type="multiple" defaultValue={['provider']} className="space-y-3">
          {/* Provider Configuration */}
          <AccordionItem value="provider" className="border border-edge rounded-xl px-5 bg-surface-0/50">
            <AccordionTrigger className="text-sm font-semibold">
              <span className="flex items-center gap-2">Provider Configuration</span>
            </AccordionTrigger>
            <AccordionContent className="space-y-4 pb-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label className="mb-2 text-text-secondary">Provider</Label>
                  <div className="flex gap-2">
                    {(['openai', 'anthropic'] as const).map((p) => (
                      <button
                        key={p}
                        onClick={() => !readOnly && setProvider(p)}
                        className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                          provider === p
                            ? 'bg-primary-500 text-white'
                            : 'bg-surface-2 text-text-muted'
                        }`}
                      >
                        {p === 'openai' ? 'OpenAI' : 'Anthropic'}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <Label className="mb-2 text-text-secondary">Model</Label>
                  <Select value={model} onValueChange={setModel} disabled={readOnly}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select a model" />
                    </SelectTrigger>
                    <SelectContent>
                      {provider === 'openai' ? (
                        <>
                          <SelectItem value="gpt-4o">GPT-4o</SelectItem>
                          <SelectItem value="gpt-4o-mini">GPT-4o Mini</SelectItem>
                          <SelectItem value="gpt-4-turbo">GPT-4 Turbo</SelectItem>
                          <SelectItem value="gpt-3.5-turbo">GPT-3.5 Turbo</SelectItem>
                        </>
                      ) : (
                        <>
                          <SelectItem value="claude-sonnet-4-20250514">Claude Sonnet 4</SelectItem>
                          <SelectItem value="claude-haiku-4-20250414">Claude Haiku 4</SelectItem>
                          <SelectItem value="claude-3-5-sonnet-20241022">Claude 3.5 Sonnet</SelectItem>
                          <SelectItem value="claude-3-haiku-20240307">Claude 3 Haiku</SelectItem>
                        </>
                      )}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div>
                <Label className="mb-2 text-text-secondary">API Key</Label>
                {readOnly ? (
                  <p className="text-sm text-text-muted">
                    {hasExistingKey ? 'Key configured' : 'No key configured'}
                  </p>
                ) : (
                  <>
                    <div className="flex gap-2">
                      <Input
                        type="password"
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        placeholder={hasExistingKey ? '••••••••••••' : 'Enter API key'}
                      />
                      {hasExistingKey && (
                        <Button
                          variant="outline"
                          onClick={() => { setApiKey(''); setHasExistingKey(false); }}
                        >
                          Clear
                        </Button>
                      )}
                    </div>
                    {hasExistingKey && !apiKey && (
                      <p className="text-xs text-status-online mt-1">Key configured</p>
                    )}
                  </>
                )}
              </div>

              {isAdmin && (
                <div>
                  <Button variant="outline" size="sm" onClick={handleTest} disabled={testSettings.isPending}>
                    {testSettings.isPending ? (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                      <FlaskConical className="w-4 h-4 mr-2" />
                    )}
                    Test Connection
                  </Button>
                  {testResult && (
                    <p className="text-xs text-emerald-400 mt-2 flex items-center gap-1.5">
                      <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400" />
                      Connection successful — {testResult.provider} / {testResult.model}
                    </p>
                  )}
                  {testFailed && (
                    <p className="text-xs text-red-400 mt-2 flex items-center gap-1.5">
                      <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-400" />
                      Connection failed — check your API key and model
                    </p>
                  )}
                </div>
              )}
            </AccordionContent>
          </AccordionItem>

          {/* Brand Voice */}
          <AccordionItem value="brand-voice" className="border border-edge rounded-xl px-5 bg-surface-0/50">
            <AccordionTrigger className="text-sm font-semibold">
              <span className="flex items-center gap-2">Brand Voice</span>
            </AccordionTrigger>
            <AccordionContent className="space-y-4 pb-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label className="mb-1 text-text-secondary">Bot Name</Label>
                  <Input
                    value={botName}
                    onChange={(e) => setBotName(e.target.value)}
                    placeholder="AI Assistant"
                    disabled={readOnly}
                  />
                </div>
                <div>
                  <Label className="mb-1 text-text-secondary">Tone</Label>
                  <Select value={tone} onValueChange={setTone} disabled={readOnly}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="formal">Formal</SelectItem>
                      <SelectItem value="casual">Casual</SelectItem>
                      <SelectItem value="friendly">Friendly</SelectItem>
                      <SelectItem value="professional">Professional</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div>
                <Label className="mb-1 text-text-secondary">Fallback Message</Label>
                <Textarea
                  value={fallbackMessage}
                  onChange={(e) => setFallbackMessage(e.target.value)}
                  placeholder="I'm connecting you to a human agent..."
                  rows={2}
                  disabled={readOnly}
                />
                <p className="text-[10px] text-text-muted mt-1">Shown when the bot can't answer confidently</p>
              </div>
            </AccordionContent>
          </AccordionItem>

          {/* Advanced Settings */}
          <AccordionItem value="advanced" className="border border-edge rounded-xl px-5 bg-surface-0/50">
            <AccordionTrigger className="text-sm font-semibold">
              <span className="flex items-center gap-2 text-text-muted">Advanced Settings</span>
            </AccordionTrigger>
            <AccordionContent className="space-y-4 pb-4">
              <div>
                <Label className="mb-1 text-text-secondary">Custom Instructions</Label>
                <Textarea
                  value={customInstructions}
                  onChange={(e) => setCustomInstructions(e.target.value)}
                  placeholder="Additional instructions for the AI..."
                  rows={3}
                  disabled={readOnly}
                />
                <p className="text-[10px] text-text-muted mt-1">Extra context appended to the system prompt</p>
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
              <div className="grid grid-cols-2 gap-4">
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
                  placeholder="Type a keyword and press Enter..."
                  disabled={readOnly}
                />
                <p className="text-[10px] text-text-muted mt-1">Messages containing these trigger handoff to agent</p>
              </div>
              <div>
                <Label className="mb-1 text-text-secondary">Topics to Avoid</Label>
                <TagInput
                  value={topicsToAvoid}
                  onChange={setTopicsToAvoid}
                  placeholder="Type a topic and press Enter..."
                  disabled={readOnly}
                />
              </div>
              <div>
                <Label className="mb-1 text-text-secondary">Off-Hours Message</Label>
                <Textarea
                  value={offHoursMessage}
                  onChange={(e) => setOffHoursMessage(e.target.value)}
                  placeholder="We're currently outside business hours..."
                  rows={2}
                  disabled={readOnly}
                />
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>

      {isAdmin && (
        <div className="flex justify-end pt-4 pb-2">
          <Button onClick={handleSave} disabled={updateSettings.isPending} size="lg">
            {updateSettings.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Save Settings
          </Button>
        </div>
      )}

    </div>
  );
};

export default AiSettingsTab;
