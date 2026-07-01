/**
 * Super-admin Bot Template editor (.scratch/plan-bot-templates.md, Phase 3b):
 * metadata + versions (draft/publish/unpublish/rollback) + per-tenant grants.
 *
 * Destructive ops (archive, unpublish a pinned version, removing a grant from a
 * tenant with bound bots) use a confirm-then-force flow: try without force →
 * the API answers 409 with an impacted count → confirm → retry with force,
 * which reassigns affected bots to blank-base (T21).
 */
import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Plus, Check, X, ChevronsUpDown, Eye, MoreVertical, TriangleAlert, Boxes, Cpu, Pencil, ShieldCheck, Sparkles, FlaskConical, SlidersHorizontal } from 'lucide-react';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { InlineError } from '@/components/ui/inline-error';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Slider } from '@/components/ui/slider';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from '@/components/ui/command';
import TagInput from '@/pages/knowledge/TagInput';
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from '@/components/ui/accordion';
import { useAdminTenantsAll } from '@/queries/useAdminQueries';
import { SkillStateCard } from '@/components/SkillStateCard';
import { COMPOSABLE_TEMPLATES_ENABLED } from '@/config/featureFlags';
import type { SkillState, SkillRemedy } from '@contracts/skill-readiness';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import {
  useAdminBotTemplateDetail, useUpdateBotTemplate, useArchiveBotTemplate,
  useCreateTemplateVersion, useEditTemplateVersion, usePublishTemplateVersion,
  useUnpublishTemplateVersion, useDeleteTemplateVersion, useRollbackTemplate, useUpdateTemplateGrants, useTemplateTestChat,
  usePreviewLedger, useAdminModules, useAdminSkills,
  forceConflict, type BotTemplateVersion, type BotTemplateConfig, type AdminModuleRow,
} from '../../queries/useBotTemplatesQueries';

// Platform defaults — seeded as REAL values in the editor (not grey placeholders)
// so an author always sees the effective template, per the UX review.
const DEFAULT_CONFIDENCE = '0.7';
const DEFAULT_MAX_LENGTH = '500';

// Max-response-length presets (chars) with rough word estimates shown in the UI.
const LENGTH_PRESETS = [
  { value: '300', words: '~45–60 words' },
  { value: '500', words: '~75–100 words' },
  { value: '900', words: '~130–170 words' },
  { value: '1200', words: '~180–230 words' },
] as const;
// One-click safety bundle for "topics to avoid".
const COMMON_TOPICS = ['politics', 'religion', 'adult content', 'illegal activity', 'hate or harassment', 'self-harm', 'legal advice', 'medical diagnosis', 'financial advice'];

// Policy guardrails are edited as flat strings in the dialog, then assembled into
// a BotTemplateConfig on save. Confidence/max-length carry real defaults; messages
// + topics stay empty (opt-in via "Insert suggested"). Tone is bot-owned, not here.
type ConfigDraft = {
  topicsToAvoid: string;
  greetingMessage: string;
  fallbackMessage: string;
  offHoursMessage: string;
  confidenceThreshold: string;
  maxResponseLength: string;
};
const EMPTY_CONFIG: ConfigDraft = {
  topicsToAvoid: '', greetingMessage: '', fallbackMessage: '', offHoursMessage: '', confidenceThreshold: DEFAULT_CONFIDENCE, maxResponseLength: DEFAULT_MAX_LENGTH,
};

function configToDraft(c: BotTemplateConfig | undefined): ConfigDraft {
  const g = c?.guardrails ?? {};
  return {
    topicsToAvoid: (g.topicsToAvoid ?? []).join(', '),
    greetingMessage: g.greetingMessage ?? '',
    fallbackMessage: g.fallbackMessage ?? '',
    offHoursMessage: g.offHoursMessage ?? '',
    confidenceThreshold: g.confidenceThreshold === undefined ? DEFAULT_CONFIDENCE : String(g.confidenceThreshold),
    maxResponseLength: g.maxResponseLength === undefined ? DEFAULT_MAX_LENGTH : String(g.maxResponseLength),
  };
}

function draftToConfig(d: ConfigDraft): BotTemplateConfig {
  const config: BotTemplateConfig = {};
  const g: NonNullable<BotTemplateConfig['guardrails']> = {};
  const topics = d.topicsToAvoid.split(',').map((x) => x.trim()).filter(Boolean);
  if (topics.length) g.topicsToAvoid = topics;
  if (d.greetingMessage.trim()) g.greetingMessage = d.greetingMessage;
  if (d.fallbackMessage.trim()) g.fallbackMessage = d.fallbackMessage;
  if (d.offHoursMessage.trim()) g.offHoursMessage = d.offHoursMessage;
  if (d.confidenceThreshold.trim()) g.confidenceThreshold = Number(d.confidenceThreshold);
  if (d.maxResponseLength.trim()) g.maxResponseLength = Number(d.maxResponseLength);
  if (Object.keys(g).length) config.guardrails = g;
  return config;
}

// Canonical {placeholder} set (mirrors the API's KNOWN_PLACEHOLDERS) for live linting.
const KNOWN_PLACEHOLDERS = new Set(['botName', 'tone', 'supportEmail', 'businessName', 'fallbackMessage', 'offHoursMessage', 'greetingMessage', 'maxResponseLength', 'topicsToAvoid']);
// Tap-to-insert chips for the most common placeholders (appended at the end).
const PLACEHOLDER_CHIPS = ['{botName}', '{businessName}', '{tone}', '{supportEmail}'];

// Preview pane — the author previews mostly by PLAN (which gates capabilities);
// channel is a secondary toggle (it only tweaks reply length + proactive contact).
// Modules are NOT a knob: the preview assumes the template's Expected modules are
// enabled, so it reflects what THIS form declares.
const TIER_LABELS: Record<string, string> = { free: 'Free', essential: 'Essential', pro: 'Pro', enterprise: 'Enterprise' };
const CHANNEL_LABELS: Record<string, string> = { widget: 'Website widget', whatsapp: 'WhatsApp', instagram: 'Instagram', messenger: 'Messenger', telegram: 'Telegram' };

// Outcome-language capabilities, keyed off the tools the bot would actually have.
// Absent → shown as a warning with a plain reason (no engineer jargon).
const PREVIEW_CAPABILITIES: { tool: string; label: string; whenAbsent?: string }[] = [
  { tool: 'kb_search', label: 'Answer questions from its knowledge base' },
  { tool: 'capture_lead', label: 'Capture leads and take contact details', whenAbsent: 'available on paid plans' },
  { tool: 'create_booking', label: 'Book appointments', whenAbsent: 'needs the Bookings module on' },
  { tool: 'escalate_to_human', label: 'Hand off to a person' },
];

// Plain-English gloss for the composer's exclusion reason codes (technical view).
const REASON_TEXT: Record<string, string> = {
  empty: 'not set',
  channel: 'not used on this channel',
  toolAbsent: 'needs a capability that isn’t on',
  tier: 'available on higher plans',
  module: 'needs the matching module on',
  specialty: 'specialty not selected on the bot',
  bookingConfigured: 'booking isn’t set up yet',
};

// Composable-templates (Phase 5): the engineered skills a module can bind, with
// the preview tools each exposes. v1 = booking only; used to (a) feed the bound
// skills into the scenario preview and (b) derive a per-skill state badge from the
// ledger. ponytail: booking-only by design — extend this map as skills land.
const SKILL_PREVIEW: Record<string, { tools: string[]; label: string }> = {
  booking: { tools: ['create_booking', 'check_availability', 'request_appointment'], label: 'Bookings' },
};
const stateToRemedy = (s: SkillState): SkillRemedy =>
  s === 'unentitled' ? 'upgrade' : s === 'disabled' ? 'turn on' : s === 'unconfigured' ? 'finish setup' : null;

// Blocks the author can't touch from a template — they need a bound bot, a live
// conversation, or tenant-level config, so they can NEVER appear in a template
// preview. Hidden entirely (they're not gaps, and not actionable here).
const PREVIEW_HIDDEN_BLOCKS = new Set([
  'CUSTOM_INSTRUCTIONS', 'EXTRA_INFO', 'CUSTOMER_NAME', 'AVAILABLE_SKILLS', 'KB_CONTEXT',
]);

// Actionable note for an excluded block the author CAN fix from the template here.
const EXCLUDED_NOTE: Record<string, string> = {
  BOOKING: 'add Bookings to Expected modules',
};

// Plain-English "what is this block" for the preview tooltips.
const BLOCK_INFO: Record<string, string> = {
  TEMPLATE_BODY: 'The prompt body you write above (or a generic service fallback if it’s blank).',
  KNOWLEDGE: 'Tells the bot to search its knowledge base before answering factual questions.',
  KB_CONTEXT: 'Knowledge-base snippets retrieved for the customer’s current question.',
  CONTACT_DETAILS: 'Lets the bot take the customer’s contact details (lead capture).',
  CHANNEL_LEAD_CAPTURE: 'On messaging channels, the bot proactively confirms the customer’s contact details.',
  SOCIAL_SHORT_REPLY: 'On messaging channels, keeps replies short and chat-style.',
  CUSTOMER_NAME: 'The customer’s name, taken from their messaging profile.',
  CUSTOM_INSTRUCTIONS: 'Extra instructions set per-bot by the tenant.',
  EXTRA_INFO: 'Extra background the tenant adds on the bot (reference only).',
  AVAILABLE_SKILLS: 'The skills the bound bot has enabled.',
  ESCALATION: 'Lets the bot hand the conversation off to a human.',
  BOOKING: 'Booking behaviour and tools — check availability and create a booking.',
};
function getBlockInfo(key: string): string {
  if (BLOCK_INFO[key]) return BLOCK_INFO[key];
  if (key.startsWith('MODULE_')) return `Instructions added by the ${key.slice(7)} module.`;
  if (key.startsWith('SPECIALTY_')) return `Tailored handling for the ${key.slice(10).replace(/_/g, ' ')} specialty.`;
  return 'A prompt block contributed at runtime.';
}
// A block key with a hover/focus tooltip explaining what it is.
const BlockKey: React.FC<{ name: string }> = ({ name }) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <span className="cursor-help underline decoration-dotted decoration-text-tertiary/60 underline-offset-2">{name}</span>
    </TooltipTrigger>
    <TooltipContent className="max-w-[240px] font-sans text-xs">{getBlockInfo(name)}</TooltipContent>
  </Tooltip>
);
function unknownPlaceholders(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(/\{(\w+)\}/g)) if (!KNOWN_PLACEHOLDERS.has(m[1])) out.add(m[1]);
  return [...out];
}

/** Count the guardrail fields a template actually sets (for the current-prompt summary). */
function countGuardrails(c: BotTemplateConfig): number {
  const g = c.guardrails ?? {};
  let n = 0;
  if (g.greetingMessage) n++;
  if (g.fallbackMessage) n++;
  if (g.offHoursMessage) n++;
  if (g.topicsToAvoid?.length) n++;
  if (g.confidenceThreshold !== undefined) n++;
  if (g.maxResponseLength !== undefined) n++;
  return n;
}

/** Render a prompt body with its {placeholders} highlighted as fill-in slots:
 *  known ones (resolved per business) in primary, unknown ones flagged amber. */
function renderPromptWithVars(body: string): React.ReactNode {
  return body.split(/(\{\w+\})/g).map((part, i) => {
    const m = part.match(/^\{(\w+)\}$/);
    if (!m) return <span key={i}>{part}</span>;
    const known = KNOWN_PLACEHOLDERS.has(m[1]);
    return (
      <span
        key={i}
        title={known ? 'Filled in per business' : 'Unknown variable — will not resolve'}
        className={`rounded px-1 font-medium ${known ? 'bg-primary-500/10 text-primary-300' : 'bg-amber-500/10 text-amber-300'}`}
      >
        {part}
      </span>
    );
  });
}

// Section shell for the authoring canvas: a numbered icon-chip + title + optional
// helper and trailing action, with content indented under a connecting rail. Turns
// the long left column into legible, ordered steps instead of a flat stack of fields.
const AuthorSection: React.FC<{
  step: number;
  icon: React.ElementType;
  title: string;
  hint?: React.ReactNode;
  action?: React.ReactNode;
  last?: boolean;
  children: React.ReactNode;
}> = ({ step, icon: Icon, title, hint, action, last, children }) => (
  <section className="relative grid grid-cols-[2rem_1fr] gap-x-4">
    <div className="flex flex-col items-center">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-primary-300 ring-1 ring-inset ring-edge">
        <Icon className="h-4 w-4" />
      </span>
      {!last && <span aria-hidden className="mt-1 w-px flex-1 bg-edge/70" />}
    </div>
    <div className={last ? '' : 'pb-8'}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-[11px] tabular-nums text-text-muted">{String(step).padStart(2, '0')}</span>
            <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
          </div>
          {hint && <p className="mt-1 max-w-prose text-xs leading-relaxed text-text-tertiary">{hint}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      <div className="mt-3">{children}</div>
    </div>
  </section>
);

// A compact grouping label for the live-preview rail (uppercase eyebrow + count).
const RailLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="text-[10px] font-medium uppercase tracking-wider text-text-tertiary">{children}</div>
);

type VersionDraft = { open: boolean; mode: 'create' | 'edit' | 'view'; version?: number; lockVersion?: number; body: string; changelog: string; expectedModules: string; selectedModuleIds: string[]; config: ConfigDraft };
const EMPTY_DRAFT: VersionDraft = { open: false, mode: 'create', body: '', changelog: '', expectedModules: '', selectedModuleIds: [], config: EMPTY_CONFIG };

const AdminBotTemplateDetail: React.FC = () => {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const { data, isLoading, isError } = useAdminBotTemplateDetail(id);
  // Tenant list for the access picker — only fetched when this template is not
  // globally available (i.e. per-tenant grants are actually used).
  const { data: tenantList } = useAdminTenantsAll({ enabled: data?.template ? !data.template.availableToAllTenants : false });

  const updateMut = useUpdateBotTemplate(id);
  const archiveMut = useArchiveBotTemplate(id);
  const createVersionMut = useCreateTemplateVersion(id);
  const editVersionMut = useEditTemplateVersion(id);
  const publishMut = usePublishTemplateVersion(id);
  const unpublishMut = useUnpublishTemplateVersion(id);
  const deleteMut = useDeleteTemplateVersion(id);
  const rollbackMut = useRollbackTemplate(id);
  const grantsMut = useUpdateTemplateGrants(id);
  const testChat = useTemplateTestChat();
  const preview = usePreviewLedger();
  // Composable-templates: authored-module catalog for the module multi-select.
  // Only fetched when the flag is ON (the legacy editor never reads it).
  const { data: modulesData } = useAdminModules({ enabled: COMPOSABLE_TEMPLATES_ENABLED });
  const { data: skillsCatalog } = useAdminSkills({ enabled: COMPOSABLE_TEMPLATES_ENABLED });
  const draftBaselineRef = useRef<string>('');

  const [meta, setMeta] = useState<{ displayName: string; category: string; description: string; availableToAllTenants: boolean } | null>(null);
  const [draft, setDraft] = useState<VersionDraft>(EMPTY_DRAFT);
  const [testInput, setTestInput] = useState('');
  const [testLog, setTestLog] = useState<{ role: 'user' | 'assistant'; content: string }[]>([]);
  const [selectedTenants, setSelectedTenants] = useState<string[] | null>(null);
  const [tenantPickerOpen, setTenantPickerOpen] = useState(false);
  const [pvTier, setPvTier] = useState<'free' | 'essential' | 'pro' | 'enterprise'>('pro');
  const [pvChannel, setPvChannel] = useState('widget');
  const [confirm, setConfirm] = useState<{ open: boolean; title: string; description: string; onConfirm: () => void }>({
    open: false, title: '', description: '', onConfirm: () => {},
  });

  // Live block-ledger: re-compile the preview whenever the open draft's body/config
  // or the mock context changes (debounced). Read-only (no persistence), so it's
  // safe to fire on every edit. preview.data is NOT a dependency → no refresh loop.
  const previewMutate = preview.mutate;
  const draftConfigKey = JSON.stringify(draft.config);

  // Map selected module ids → the engineered skills they bind, and → the publish-
  // pinned {moduleId, moduleVersion} refs (latest published version). Defined as
  // closures over modulesData so both the preview effect (above the early returns)
  // and save (below) share one source of truth.
  const moduleRows: AdminModuleRow[] = modulesData ?? [];
  const boundSkillIds = (ids: string[]): string[] => {
    const out = new Set<string>();
    for (const id of ids) {
      const row = moduleRows.find((r) => r.module.id === id);
      for (const s of row?.module.skillIds ?? []) out.add(s);
    }
    return [...out];
  };
  const boundModuleRefs = (ids: string[]): { moduleId: string; moduleVersion: number }[] =>
    ids.map((id) => {
      const published = (moduleRows.find((r) => r.module.id === id)?.versions ?? []).filter((v) => v.status === 'published');
      const moduleVersion = published.length ? Math.max(...published.map((v) => v.version)) : 1;
      return { moduleId: id, moduleVersion };
    });

  // The skills the scenario preview activates. Composable: the selected modules'
  // bound skills; legacy: the free-text Expected modules. (When composable, the
  // saved expectedModules mirror these bound skills, so both agree.)
  const previewActiveModules = COMPOSABLE_TEMPLATES_ENABLED
    ? boundSkillIds(draft.selectedModuleIds)
    : draft.expectedModules.split(',').map((x) => x.trim()).filter(Boolean);
  const previewActiveModulesKey = previewActiveModules.join(',');

  // Preview re-compiles on body/config or scenario change. The active skills come
  // from THIS form (selected modules when composable, else Expected modules), so
  // the preview reflects what the author declared.
  useEffect(() => {
    if (!draft.open) return;
    const handle = setTimeout(() => {
      previewMutate({
        body: draft.body,
        config: draftToConfig(draft.config),
        tier: pvTier,
        channel: pvChannel,
        activeModules: previewActiveModulesKey ? previewActiveModulesKey.split(',') : [],
      });
    }, 300);
    return () => clearTimeout(handle);
    // draftConfigKey stands in for draft.config (object identity is unstable);
    // previewActiveModulesKey stands in for the derived active-skills array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewMutate, draft.open, draft.body, draftConfigKey, pvTier, pvChannel, previewActiveModulesKey]);

  if (isLoading) return <PageSkeleton variant="list" rows={4} />;
  if (isError || !data) return <InlineError message={t('admin.botTemplates.errors.load')} />;

  const { template, versions, grantedTenantIds, usage, moduleCatalog } = data;
  // The live prompt = latest published version (versions are DESC-ordered).
  const publishedVersion = versions.find((v) => v.status === 'published');
  const m = meta ?? {
    displayName: template.displayName,
    category: template.category ?? '',
    description: template.description ?? '',
    availableToAllTenants: template.availableToAllTenants,
  };
  const selectedTenantIds = selectedTenants ?? grantedTenantIds;
  const tenants: Array<{ id: string; name: string }> = (tenantList ?? []) as Array<{ id: string; name: string }>;
  const tenantName = (tid: string) => tenants.find((x) => x.id === tid)?.name ?? tid;
  const toggleTenant = (tid: string) =>
    setSelectedTenants((prev) => {
      const base = prev ?? grantedTenantIds;
      return base.includes(tid) ? base.filter((x) => x !== tid) : [...base, tid];
    });

  const parseModules = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

  // Try an action without force; on a 409 force-conflict, confirm then retry with force.
  const withForce = async (
    run: (force: boolean) => Promise<unknown>,
    confirmCopy: (n: number) => { title: string; description: string },
  ) => {
    try {
      await run(false);
    } catch (err) {
      const fc = forceConflict(err);
      if (!fc) return; // non-conflict already toasted by the mutation
      const count = fc.impactedBots ?? (fc.impactedTenants ?? []).reduce((a, b) => a + b.bots, 0);
      const copy = confirmCopy(count);
      setConfirm({
        open: true,
        title: copy.title,
        description: copy.description,
        onConfirm: () => {
          setConfirm((c) => ({ ...c, open: false }));
          void run(true);
        },
      });
    }
  };

  // Serialized snapshot of the editable fields, captured when a draft opens, to
  // detect unsaved changes before discarding. (draftBaselineRef hook is declared
  // above the early returns to keep hook order stable.)
  const draftKey = (d: VersionDraft) => JSON.stringify({ body: d.body, changelog: d.changelog, expectedModules: d.expectedModules, selectedModuleIds: d.selectedModuleIds, config: d.config });
  const openDraft = (d: VersionDraft) => {
    draftBaselineRef.current = draftKey(d);
    setTestLog([]);
    setTestInput('');
    preview.reset();
    setPvTier('pro');      // preview defaults: Pro plan…
    setPvChannel('widget'); // …on the website widget; modules follow Expected modules
    setDraft(d);
  };

  // Test-this-prompt panel — runs the current draft body+config against the LLM
  // without saving, so authors can try before publishing.
  const runTest = async () => {
    const msg = testInput.trim();
    if (!msg) return;
    const history = testLog;
    setTestLog((l) => [...l, { role: 'user', content: msg }]);
    setTestInput('');
    try {
      const res = await testChat.mutateAsync({ body: draft.body, config: draftToConfig(draft.config), message: msg, history });
      setTestLog((l) => [...l, { role: 'assistant', content: res.response }]);
    } catch {
      setTestLog((l) => [...l, { role: 'assistant', content: t('admin.botTemplates.editor.testError') }]);
    }
  };

  // Discard with a guard: confirm if there are unsaved edits (create/edit only).
  const requestCloseDraft = () => {
    if (draft.mode !== 'view' && draftKey(draft) !== draftBaselineRef.current) {
      setConfirm({
        open: true,
        title: t('admin.botTemplates.confirm.discardTitle'),
        description: t('admin.botTemplates.confirm.discardBody'),
        onConfirm: () => { setConfirm((c) => ({ ...c, open: false })); setDraft(EMPTY_DRAFT); },
      });
    } else {
      setDraft(EMPTY_DRAFT);
    }
  };

  // Prefill a new draft from the most recent version (body + modules + config) so
  // it's an edit-from-here, not a blank slate. Changelog stays empty (new entry).
  const refIds = (v: BotTemplateVersion | undefined) => (v?.selectedModuleRefs ?? []).map((r) => r.moduleId);
  const openCreate = () => {
    const latest = versions[0];
    openDraft({
      ...EMPTY_DRAFT,
      open: true,
      mode: 'create',
      body: latest?.body ?? '',
      expectedModules: latest ? latest.expectedModules.join(', ') : '',
      selectedModuleIds: refIds(latest),
      config: latest ? configToDraft(latest.config) : EMPTY_CONFIG,
    });
  };
  const openEdit = (v: BotTemplateVersion) =>
    openDraft({ open: true, mode: 'edit', version: v.version, lockVersion: v.lockVersion, body: v.body, changelog: v.changelog ?? '', expectedModules: v.expectedModules.join(', '), selectedModuleIds: refIds(v), config: configToDraft(v.config) });
  const openView = (v: BotTemplateVersion) =>
    openDraft({ open: true, mode: 'view', version: v.version, body: v.body, changelog: v.changelog ?? '', expectedModules: v.expectedModules.join(', '), selectedModuleIds: refIds(v), config: configToDraft(v.config) });

  // Delete a draft/unpublished version: always confirm; an unpublished version that
  // bots pin then runs the block-or-force flow (unpins them to latest).
  const askDelete = (v: BotTemplateVersion) =>
    setConfirm({
      open: true,
      title: t('admin.botTemplates.confirm.deleteTitle', { version: v.version }),
      description: t('admin.botTemplates.confirm.deleteBody'),
      onConfirm: () => {
        setConfirm((c) => ({ ...c, open: false }));
        if (v.status === 'unpublished') {
          void withForce(
            (force) => deleteMut.mutateAsync({ version: v.version, force }),
            (n) => ({ title: t('admin.botTemplates.confirm.deleteTitle', { version: v.version }), description: t('admin.botTemplates.confirm.deleteReassign', { count: n }) }),
          );
        } else {
          deleteMut.mutate({ version: v.version });
        }
      },
    });

  // The version body shared by save + publish. Composable: persist selectedModuleRefs
  // (authoritative) and mirror the bound skills into expectedModules so the legacy
  // fallback stays consistent. Legacy: free-text Expected modules, no refs (flag OFF
  // = unchanged wire shape).
  const versionPayload = () => {
    const config = draftToConfig(draft.config);
    if (COMPOSABLE_TEMPLATES_ENABLED) {
      // Guard against silent data loss: with NO authored module selected, do not
      // overwrite expectedModules with [] (that would drop e.g. booking from a
      // legacy template). Preserve the prefilled expectation + clear refs instead.
      if (draft.selectedModuleIds.length === 0) {
        return {
          body: draft.body,
          changelog: draft.changelog || null,
          expectedModules: parseModules(draft.expectedModules),
          selectedModuleRefs: null,
          config,
        };
      }
      return {
        body: draft.body,
        changelog: draft.changelog || null,
        expectedModules: boundSkillIds(draft.selectedModuleIds),
        selectedModuleRefs: boundModuleRefs(draft.selectedModuleIds),
        config,
      };
    }
    return { body: draft.body, changelog: draft.changelog || null, expectedModules: parseModules(draft.expectedModules), config };
  };

  const saveDraft = async () => {
    if (draft.mode === 'create') {
      await createVersionMut.mutateAsync(versionPayload());
    } else {
      await editVersionMut.mutateAsync({ version: draft.version!, lockVersion: draft.lockVersion!, ...versionPayload() });
    }
    setDraft(EMPTY_DRAFT);
  };

  // Save the draft, then publish that version — the one-step path from the editor.
  // Save and publish are separate server calls, so after the save half succeeds we
  // advance the local draft to edit-mode with the server's returned version+lock.
  // That way a retry after a publish failure re-publishes the SAME draft instead of
  // creating a duplicate (create mode) or sending a stale lockVersion (edit mode).
  // Mutations toast their own errors, so a failure just leaves the editor open.
  const publishDraft = async () => {
    try {
      let version: number;
      if (draft.mode === 'create') {
        const res = await createVersionMut.mutateAsync(versionPayload());
        version = res.version.version;
        setDraft((d) => ({ ...d, mode: 'edit', version, lockVersion: res.version.lockVersion }));
      } else {
        const res = await editVersionMut.mutateAsync({ version: draft.version!, lockVersion: draft.lockVersion!, ...versionPayload() });
        version = draft.version!;
        setDraft((d) => ({ ...d, lockVersion: res.version.lockVersion }));
      }
      await publishMut.mutateAsync(version);
      setDraft(EMPTY_DRAFT);
    } catch {
      // Save or publish failed (already toasted). Keep the editor open in its now
      // edit-mode state so the next Publish click resumes from the saved version.
    }
  };

  const editorTitle =
    draft.mode === 'create'
      ? t('admin.botTemplates.editor.newTitle')
      : draft.mode === 'view'
        ? t('admin.botTemplates.editor.viewTitle', { version: draft.version })
        : t('admin.botTemplates.editor.editTitle', { version: draft.version });
  const editorBusy = createVersionMut.isPending || editVersionMut.isPending || publishMut.isPending;
  // Unsaved-edits signal for the editor header, mirroring the discard guard.
  const dirty = draft.mode !== 'view' && draftKey(draft) !== draftBaselineRef.current;

  return (
    <div className="h-full overflow-y-auto">
    <div className="mx-auto max-w-6xl p-6 space-y-6">
      <div>
        <Link to="/admin/bot-templates" className="inline-flex items-center text-sm text-text-secondary transition-colors hover:text-text-primary">
          <ArrowLeft className="h-4 w-4 mr-1" />
          {t('admin.botTemplates.detail.back')}
        </Link>
        <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-2xl font-semibold tracking-tight text-text-primary">{template.displayName}</h1>
              <Badge variant={template.status === 'active' ? 'default' : 'secondary'}>
                {t(`admin.botTemplates.templateStatus.${template.status}`)}
              </Badge>
            </div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-tertiary">
              <span className="inline-flex items-center rounded-md bg-surface-2 px-2 py-0.5 font-mono text-text-secondary ring-1 ring-inset ring-edge">{template.key}</span>
              <span className="text-text-muted">·</span>
              <span>{t('admin.botTemplates.detail.usage', { bots: usage.bots, tenants: usage.tenants })}</span>
            </div>
          </div>
          {template.status === 'active' && (
            <Button
              variant="outline"
              onClick={() =>
                withForce(
                  (force) => archiveMut.mutateAsync({ force }),
                  (n) => ({ title: t('admin.botTemplates.confirm.archiveTitle'), description: t('admin.botTemplates.confirm.reassign', { count: n }) }),
                )
              }
            >
              {t('admin.botTemplates.actions.archive')}
            </Button>
          )}
        </div>
      </div>

      {/* Composition — the hero: general prompt + modules → skills, from the current
          published version. Makes "a template is a composition" legible at a glance. */}
      {COMPOSABLE_TEMPLATES_ENABLED && (() => {
        const current = versions.filter((v) => v.status === 'published').sort((a, b) => b.version - a.version)[0];
        if (!current) return null;
        const modIds = (current.selectedModuleRefs ?? []).map((r) => r.moduleId);
        const mods = modIds
          .map((id) => moduleRows.find((r) => r.module.id === id)?.module)
          .filter((mo): mo is { id: string; name: string; description: string | null; skillIds: string[] } => !!mo);
        // Mirrors the runtime `selectSkillIds`: module refs win; else the legacy
        // `expectedModules` binds skills directly (pre-modules templates). When we
        // fall through to that path, say so — a skill with no module is legacy, not
        // magic.
        const skillIds = mods.length ? [...new Set(mods.flatMap((mo) => mo.skillIds))] : current.expectedModules;
        const legacyBinding = mods.length === 0 && skillIds.length > 0;
        const skillLabel = (id: string) => skillsCatalog?.find((s) => s.id === id)?.displayName ?? id;
        const Col = ({ label, children }: { label: string; children: React.ReactNode }) => (
          <div className="flex-1 rounded-lg border border-edge bg-surface-1 p-3">
            <div className="mb-1.5 text-[10px] uppercase tracking-wider text-text-tertiary">{label}</div>
            {children}
          </div>
        );
        return (
          <Card variant="glass">
            <CardContent className="p-5">
              <div className="mb-4 flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-md bg-surface-1 text-primary-300 ring-1 ring-inset ring-edge">
                  <Boxes className="h-3.5 w-3.5" />
                </span>
                <h2 className="text-sm font-semibold text-text-primary">Composition</h2>
                <Badge variant="secondary" className="ml-auto">from v{current.version}</Badge>
              </div>
              <div className="flex flex-col gap-3 lg:flex-row lg:items-stretch">
                <Col label="General prompt">
                  <p className="line-clamp-4 text-sm text-text-secondary">{current.body?.trim() || 'Platform generic core.'}</p>
                </Col>
                <div className="flex items-center justify-center text-text-tertiary lg:flex-col">
                  <Plus className="h-4 w-4" />
                </div>
                <Col label={`Modules (${mods.length})`}>
                  {mods.length ? (
                    <div className="space-y-1">
                      {mods.map((mo) => (
                        <div key={mo.id} className="flex items-center gap-1.5 text-sm text-text-primary">
                          <Boxes className="h-3.5 w-3.5 shrink-0 text-text-muted" />
                          <span className="truncate">{mo.name}</span>
                        </div>
                      ))}
                    </div>
                  ) : legacyBinding ? (
                    <p className="flex items-start gap-1.5 text-xs text-amber-300/90">
                      <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span>None bound — the skill is bound directly (a legacy binding from before modules).</span>
                    </p>
                  ) : (
                    <p className="text-xs text-text-muted">None — this template is prompt-only.</p>
                  )}
                </Col>
                <div className="flex items-center justify-center text-text-tertiary lg:flex-col">
                  <ArrowRight className="h-4 w-4" />
                </div>
                <Col label="Skills the bot gets">
                  {skillIds.length ? (
                    <>
                      <div className="flex flex-wrap gap-1.5">
                        {skillIds.map((sid) => (
                          <span
                            key={sid}
                            className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs ${legacyBinding ? 'border-amber-500/30 bg-amber-500/10 text-amber-200' : 'border-edge bg-surface-2 text-text-secondary'}`}
                          >
                            <Cpu className="h-3 w-3 opacity-70" />
                            {skillLabel(sid)}
                            {legacyBinding && <span className="ml-0.5 rounded bg-amber-500/20 px-1 text-[9px] uppercase tracking-wide">direct</span>}
                          </span>
                        ))}
                      </div>
                      {legacyBinding && (
                        <p className="mt-2 text-[11px] text-text-muted">Bound directly, bypassing modules. Re-bind through a module to modernise.</p>
                      )}
                    </>
                  ) : (
                    <p className="text-xs text-text-muted">No skills — prompt-only.</p>
                  )}
                </Col>
              </div>
            </CardContent>
          </Card>
        );
      })()}

      {/* Details — a settings surface, not a raw form. Two decision groups, each with
          a left-rail explanation: Identity (what the template is) and Distribution
          (who can pick it). Every field keeps its id/label wiring. */}
      <Card variant="glass">
        <CardContent className="p-0">
          {/* Identity */}
          <section className="grid gap-4 border-b border-edge p-5 lg:grid-cols-[220px_1fr] lg:gap-8">
            <div>
              <h3 className="text-sm font-semibold text-text-primary">Identity</h3>
              <p className="mt-1 text-xs text-text-muted">How this template is named and catalogued.</p>
            </div>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="m-name">{t('admin.botTemplates.create.displayName')}</Label>
                <Input id="m-name" value={m.displayName} onChange={(e) => setMeta({ ...m, displayName: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="m-vertical">{t('admin.botTemplates.detail.category')}</Label>
                <Input id="m-vertical" value={m.category} placeholder="plumber" onChange={(e) => setMeta({ ...m, category: e.target.value })} />
                {m.category.trim() ? (
                  <p className="text-xs text-text-secondary">
                    Unlocks the{' '}
                    <span className="rounded bg-surface-2 px-1 font-mono text-text-primary">{m.category.trim()}</span>{' '}
                    specialty catalog.
                  </p>
                ) : (
                  <p className="text-xs text-text-muted">{t('admin.botTemplates.detail.categoryHint')}</p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="m-desc">{t('admin.botTemplates.detail.description')}</Label>
                <Textarea id="m-desc" rows={2} value={m.description} onChange={(e) => setMeta({ ...m, description: e.target.value })} />
                <p className="text-xs text-text-muted">{t('admin.botTemplates.detail.descriptionHint')}</p>
              </div>
            </div>
          </section>

          {/* Distribution */}
          <section className="grid gap-4 border-b border-edge p-5 lg:grid-cols-[220px_1fr] lg:gap-8">
            <div>
              <h3 className="text-sm font-semibold text-text-primary">Distribution</h3>
              <p className="mt-1 text-xs text-text-muted">Who can pick this template.</p>
            </div>
            <label
              htmlFor="m-global"
              className="flex cursor-pointer items-center justify-between gap-4 rounded-lg border border-edge bg-surface-1 p-3 transition-colors hover:border-edge-light"
            >
              <div>
                <div className="text-sm font-medium text-text-primary">{t('admin.botTemplates.create.availableToAll')}</div>
                <p className="mt-0.5 text-xs text-text-muted">{t('admin.botTemplates.detail.availabilityHint')}</p>
              </div>
              <Switch id="m-global" checked={m.availableToAllTenants} onCheckedChange={(v) => setMeta({ ...m, availableToAllTenants: v })} />
            </label>
          </section>

          {/* Save */}
          <div className="flex items-center justify-end gap-3 p-5">
            <Button
              onClick={async () => {
                await updateMut.mutateAsync({ displayName: m.displayName, category: m.category.trim() || null, description: m.description || undefined, availableToAllTenants: m.availableToAllTenants });
                setMeta(null);
              }}
              disabled={updateMut.isPending}
            >
              {t('common.save')}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Current prompt — the live (latest published) system prompt, shown as
          readable prose with its {variables} highlighted as fill-in slots, sized to
          content instead of an empty textarea, with a clear edit path. */}
      <Card variant="glass">
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <CardTitle>{t('admin.botTemplates.detail.currentPrompt')}</CardTitle>
            {publishedVersion && <Badge variant="default">{`v${publishedVersion.version}`}</Badge>}
          </div>
          <Button size="sm" variant="outline" onClick={() => openCreate()}>
            <Pencil className="h-3.5 w-3.5" />{t('admin.botTemplates.actions.editNewVersion')}
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {publishedVersion ? (
            <>
              {publishedVersion.body?.trim() ? (
                <div className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-lg border border-edge bg-surface-1 p-4 text-sm leading-relaxed text-text-secondary">
                  {renderPromptWithVars(publishedVersion.body)}
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-edge bg-surface-1 p-4 text-sm text-text-muted">
                  {t('admin.botTemplates.detail.promptEmpty')}
                </div>
              )}
              <div className="flex items-center gap-1.5 text-xs text-text-muted">
                <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
                {countGuardrails(publishedVersion.config) === 0
                  ? t('admin.botTemplates.detail.promptConfigDefaults')
                  : t('admin.botTemplates.detail.promptConfigSummary', { count: countGuardrails(publishedVersion.config) })}
              </div>
            </>
          ) : (
            <p className="text-sm text-text-muted">{t('admin.botTemplates.detail.noPublishedPrompt')}</p>
          )}
        </CardContent>
      </Card>

      {/* Versions */}
      <Card variant="glass">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>{t('admin.botTemplates.detail.versions')}</CardTitle>
          <Button size="sm" onClick={openCreate}><Plus className="h-4 w-4 mr-1" />{t('admin.botTemplates.actions.newDraft')}</Button>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('admin.botTemplates.versionColumns.version')}</TableHead>
                <TableHead>{t('admin.botTemplates.versionColumns.status')}</TableHead>
                <TableHead>{t('admin.botTemplates.versionColumns.changelog')}</TableHead>
                <TableHead className="text-right">{t('admin.botTemplates.versionColumns.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {versions.map((v) => (
                <TableRow key={v.id}>
                  <TableCell className="font-medium">v{v.version}</TableCell>
                  <TableCell>
                    <Badge variant={v.status === 'published' ? 'default' : v.status === 'draft' ? 'outline' : 'secondary'}>
                      {t(`admin.botTemplates.versionStatus.${v.status}`)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm text-text-secondary max-w-xs truncate">{v.changelog ?? '—'}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      {/* Primary action stays visible; the rest live in the ⋯ menu. */}
                      {v.status === 'draft' ? (
                        <Button size="sm" onClick={() => publishMut.mutate(v.version)}>{t('admin.botTemplates.actions.publish')}</Button>
                      ) : (
                        <Button size="sm" variant="ghost" onClick={() => openView(v)}><Eye className="h-4 w-4 mr-1" />{t('admin.botTemplates.actions.view')}</Button>
                      )}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" aria-label={t('admin.botTemplates.versionColumns.actions')}>
                            <MoreVertical className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {v.status === 'draft' && (
                            <DropdownMenuItem onClick={() => openEdit(v)}>{t('common.edit')}</DropdownMenuItem>
                          )}
                          {v.status === 'published' && (
                            <DropdownMenuItem
                              onClick={() =>
                                withForce(
                                  (force) => unpublishMut.mutateAsync({ version: v.version, force }),
                                  (n) => ({ title: t('admin.botTemplates.confirm.unpublishTitle'), description: t('admin.botTemplates.confirm.reassign', { count: n }) }),
                                )
                              }
                            >
                              {t('admin.botTemplates.actions.unpublish')}
                            </DropdownMenuItem>
                          )}
                          {v.status !== 'draft' && (
                            <DropdownMenuItem onClick={() => rollbackMut.mutate(v.version)}>{t('admin.botTemplates.actions.rollback')}</DropdownMenuItem>
                          )}
                          {v.status !== 'published' && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem className="text-red-400 focus:text-red-300" onClick={() => askDelete(v)}>{t('admin.botTemplates.actions.delete')}</DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {versions.length === 0 && (
                <TableRow><TableCell colSpan={4} className="text-center text-sm text-text-tertiary py-6">{t('admin.botTemplates.detail.noVersions')}</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Grants (only relevant when not globally available) */}
      <Card variant="glass">
        <CardHeader><CardTitle>{t('admin.botTemplates.detail.grants')}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-text-tertiary">
            {template.availableToAllTenants ? t('admin.botTemplates.detail.grantsGlobalHint') : t('admin.botTemplates.detail.grantsHint')}
          </p>

          {!template.availableToAllTenants && (
            <>
              {/* Searchable tenant multi-select */}
              <Popover open={tenantPickerOpen} onOpenChange={setTenantPickerOpen}>
                <PopoverTrigger asChild>
                  <Button variant="outline" role="combobox" className="w-full justify-between">
                    {selectedTenantIds.length
                      ? t('admin.botTemplates.detail.tenantsSelected', { count: selectedTenantIds.length })
                      : t('admin.botTemplates.detail.tenantsSelectPlaceholder')}
                    <ChevronsUpDown className="h-4 w-4 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                  <Command>
                    <CommandInput placeholder={t('admin.botTemplates.detail.tenantsSearch')} />
                    <CommandList>
                      <CommandEmpty>{t('admin.botTemplates.detail.tenantsNone')}</CommandEmpty>
                      <CommandGroup>
                        {tenants.map((tenant) => {
                          const checked = selectedTenantIds.includes(tenant.id);
                          return (
                            <CommandItem key={tenant.id} value={`${tenant.name} ${tenant.id}`} onSelect={() => toggleTenant(tenant.id)}>
                              <Check className={`mr-2 h-4 w-4 ${checked ? 'opacity-100' : 'opacity-0'}`} />
                              <span className="truncate">{tenant.name}</span>
                            </CommandItem>
                          );
                        })}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>

              {/* Selected chips */}
              {selectedTenantIds.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {selectedTenantIds.map((tid) => (
                    <Badge key={tid} variant="secondary" className="gap-1">
                      {tenantName(tid)}
                      <button type="button" onClick={() => toggleTenant(tid)} aria-label="remove">
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              )}

              <div className="flex justify-end">
                <Button
                  variant="outline"
                  disabled={grantsMut.isPending}
                  onClick={() =>
                    withForce(
                      (force) => grantsMut.mutateAsync({ tenantIds: selectedTenantIds, force }).then(() => setSelectedTenants(null)),
                      (n) => ({ title: t('admin.botTemplates.confirm.ungrantTitle'), description: t('admin.botTemplates.confirm.reassign', { count: n }) }),
                    )
                  }
                >
                  {t('admin.botTemplates.actions.saveAccess')}
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Version editor — full-page two-pane takeover (author | live ledger).
          Uses the Radix Dialog primitive for focus-trap / Escape / aria-modal / focus
          return; outside-click close is disabled so a stray click can't lose edits. */}
      <DialogPrimitive.Root open={draft.open} onOpenChange={(o) => { if (!o) requestCloseDraft(); }}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Content
            aria-label={editorTitle}
            onInteractOutside={(e) => e.preventDefault()}
            className="fixed inset-0 z-50 flex flex-col bg-surface-0 focus:outline-none"
          >
            <DialogPrimitive.Title className="sr-only">{editorTitle}</DialogPrimitive.Title>
            <header className="relative flex flex-wrap items-center gap-3 border-b border-edge bg-surface-1/70 px-5 py-3 shrink-0 backdrop-blur">
            <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary-500/60 to-transparent" />
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary-500/10 text-primary-300 ring-1 ring-inset ring-primary-500/25">
                {draft.mode === 'view' ? <Eye className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="truncate text-base font-semibold text-text-primary">{editorTitle}</h2>
                  {draft.mode === 'view'
                    ? <Badge variant="secondary" className="shrink-0">{t('admin.botTemplates.versionStatus.published')}</Badge>
                    : dirty && (
                      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-300 ring-1 ring-inset ring-amber-500/25">
                        <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />{t('admin.botTemplates.editor.unsaved')}
                      </span>
                    )}
                </div>
                <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-text-tertiary">
                  {template.category && (
                    <span className="truncate">{t('admin.botTemplates.detail.category')}: <span className="font-mono text-text-secondary">{template.category}</span></span>
                  )}
                  {draft.mode === 'create' && versions[0] && (
                    <><span className="text-text-muted">·</span><span className="truncate">{t('admin.botTemplates.editor.prefilledFrom', { version: versions[0].version })}</span></>
                  )}
                </div>
              </div>
            </div>
            <div className="ml-auto flex items-center gap-2">
              {draft.mode === 'view' ? (
                <Button variant="outline" onClick={() => setDraft(EMPTY_DRAFT)}>{t('common.close')}</Button>
              ) : (
                <>
                  <Button variant="ghost" onClick={requestCloseDraft}>{t('common.cancel')}</Button>
                  <Button variant="outline" onClick={saveDraft} disabled={editorBusy}>{t('admin.botTemplates.editor.saveDraft')}</Button>
                  <Button onClick={publishDraft} disabled={editorBusy} className="gap-1.5">
                    <Check className="h-4 w-4" />{t('admin.botTemplates.actions.publish')}
                  </Button>
                </>
              )}
            </div>
          </header>
          <div className="flex-1 min-h-0 grid lg:grid-cols-[1fr_minmax(0,440px)]">
            {/* LEFT — author: numbered steps down a connecting rail. */}
            <div className="overflow-y-auto">
            <div className="mx-auto max-w-3xl px-6 py-8 lg:px-8">

            {/* 01 — Prompt: the hero, framed as a real editor surface. */}
            <AuthorSection
              step={1}
              icon={Sparkles}
              title={COMPOSABLE_TEMPLATES_ENABLED ? t('admin.botTemplates.editor.generalPrompt') : t('admin.botTemplates.editor.promptSection')}
              hint={draft.mode !== 'view' ? (COMPOSABLE_TEMPLATES_ENABLED ? t('admin.botTemplates.editor.generalPromptHint') : t('admin.botTemplates.editor.bodyHint')) : undefined}
            >
              <div className="overflow-hidden rounded-xl border border-edge bg-surface-1 transition-colors focus-within:border-primary-400 focus-within:ring-2 focus-within:ring-primary-500/25">
                <div className="flex items-center justify-between gap-2 border-b border-edge/70 bg-surface-2/40 px-3 py-2">
                  <Label htmlFor="d-body" className="text-xs font-medium uppercase tracking-wide text-text-secondary">
                    {COMPOSABLE_TEMPLATES_ENABLED ? t('admin.botTemplates.editor.generalPrompt') : t('admin.botTemplates.editor.body')}
                  </Label>
                  <span className="font-mono text-[11px] tabular-nums text-text-muted">{t('admin.botTemplates.editor.charCount', { n: draft.body.length.toLocaleString() })}</span>
                </div>
                <Textarea
                  id="d-body"
                  rows={16}
                  className="rounded-none border-0 bg-transparent font-mono text-sm leading-relaxed hover:border-0 focus-visible:border-0 focus-visible:ring-0"
                  value={draft.body}
                  readOnly={draft.mode === 'view'}
                  onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
                />
                {draft.mode !== 'view' && (
                  <div className="flex flex-wrap items-center gap-1.5 border-t border-edge/70 bg-surface-2/40 px-3 py-2">
                    <span className="mr-1 text-[11px] font-medium text-text-muted">{t('admin.botTemplates.editor.insertLabel')}</span>
                    {PLACEHOLDER_CHIPS.map((p) => (
                      <button
                        key={p}
                        type="button"
                        className="rounded-md border border-edge bg-surface-2 px-2 py-1 font-mono text-[11px] text-text-secondary transition-colors hover:border-primary-400 hover:bg-primary-500/10 hover:text-primary-200"
                        onClick={() => setDraft((d) => ({ ...d, body: d.body + (d.body && !d.body.endsWith(' ') ? ' ' : '') + p }))}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {draft.mode !== 'view' && unknownPlaceholders(draft.body).length > 0 && (
                <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-400">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{t('admin.botTemplates.editor.unknownPlaceholders', { placeholders: unknownPlaceholders(draft.body).map((p) => `{${p}}`).join(', ') })}</span>
                </p>
              )}
            </AuthorSection>

            {/* 02 — Capabilities: the modules → skills the bot actually gets. */}
            <AuthorSection
              step={2}
              icon={Boxes}
              title={COMPOSABLE_TEMPLATES_ENABLED ? t('admin.botTemplates.editor.modules') : t('admin.botTemplates.editor.expectedModules')}
              hint={COMPOSABLE_TEMPLATES_ENABLED ? t('admin.botTemplates.editor.modulesHint') : t('admin.botTemplates.editor.expectedModulesHint')}
            >
              {COMPOSABLE_TEMPLATES_ENABLED ? (
                (() => {
                  const ro = draft.mode === 'view';
                  // One or more modules per version — the resolver unions their bound skills.
                  const toggleModule = (mid: string) =>
                    setDraft((d) => ({
                      ...d,
                      selectedModuleIds: d.selectedModuleIds.includes(mid)
                        ? d.selectedModuleIds.filter((x) => x !== mid)
                        : [...d.selectedModuleIds, mid],
                    }));
                  const publishedRows = moduleRows.filter((r) => r.versions.some((v) => v.status === 'published'));
                  if (publishedRows.length === 0) {
                    return <p className="rounded-lg border border-dashed border-edge bg-surface-1 px-3 py-4 text-xs text-text-tertiary">{t('admin.botTemplates.editor.noModulesPublished')}</p>;
                  }
                  return (
                    <div className="grid gap-2 sm:grid-cols-2">
                      {publishedRows.map((r) => {
                        const module = r.module;
                        const checked = draft.selectedModuleIds.includes(module.id);
                        const pub = [...r.versions]
                          .filter((v) => v.status === 'published')
                          .sort((a, b) => b.version - a.version)[0];
                        return (
                          <label
                            key={module.id}
                            className={`flex items-start gap-2.5 rounded-lg border p-3 transition-colors ${
                              ro ? 'pointer-events-none opacity-70' : 'cursor-pointer'
                            } ${checked ? 'border-primary-400/60 bg-primary-500/10' : 'border-edge bg-surface-1 hover:border-edge-light hover:bg-surface-2'}`}
                          >
                            <Checkbox checked={checked} onCheckedChange={() => toggleModule(module.id)} disabled={ro} className="mt-0.5" />
                            <span className="min-w-0">
                              <span className="flex items-center gap-1.5 text-sm font-medium text-text-primary">
                                <Boxes className="h-3.5 w-3.5 shrink-0 text-text-muted" />{module.name}
                              </span>
                              {pub?.prose && (
                                <span className="mt-0.5 line-clamp-2 block text-xs text-text-tertiary">{pub.prose}</span>
                              )}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  );
                })()
              ) : (
                (() => {
                  const ro = draft.mode === 'view';
                  const modulesArr = draft.expectedModules.split(',').map((x) => x.trim()).filter(Boolean);
                  const toggleModule = (mid: string) => {
                    const next = modulesArr.includes(mid) ? modulesArr.filter((x) => x !== mid) : [...modulesArr, mid];
                    setDraft((d) => ({ ...d, expectedModules: next.join(', ') }));
                  };
                  if (moduleCatalog.length === 0) return <p className="rounded-lg border border-dashed border-edge bg-surface-1 px-3 py-4 text-xs text-text-tertiary">{t('admin.botTemplates.editor.noModules')}</p>;
                  return (
                    <div className="flex flex-wrap gap-1.5">
                      {moduleCatalog.map((mod) => {
                        const selected = modulesArr.includes(mod.id);
                        return (
                          <Button key={mod.id} type="button" size="sm" variant={selected ? 'default' : 'outline'} className="h-8 text-xs" disabled={ro} onClick={() => toggleModule(mod.id)}>
                            {selected && <Check className="h-3 w-3 mr-1" />}{mod.displayName}
                          </Button>
                        );
                      })}
                    </div>
                  );
                })()
              )}
            </AuthorSection>

            {/* 03 — Guardrails: template-owned policy (tone stays bot-owned). */}
            <AuthorSection
              step={3}
              icon={ShieldCheck}
              title={t('admin.botTemplates.editor.configTitle')}
              hint={t('admin.botTemplates.editor.configHint')}
            >
              {(() => {
                const ro = draft.mode === 'view';
                const cfg = draft.config;
                const setCfg = (patch: Partial<ConfigDraft>) => setDraft((d) => ({ ...d, config: { ...d.config, ...patch } }));
                const topicsArr = cfg.topicsToAvoid.split(',').map((x) => x.trim()).filter(Boolean);
                const confidence = Number(cfg.confidenceThreshold || DEFAULT_CONFIDENCE);
                const insertMsg = (key: 'greetingMessage' | 'fallbackMessage' | 'offHoursMessage', i18nKey: string) =>
                  setCfg({ [key]: t(i18nKey) } as Partial<ConfigDraft>);
                return (
                  <div className="space-y-5">
                    {/* Customer-facing messages, each with an opt-in "Insert suggested" starter */}
                    <div className="space-y-4 rounded-xl border border-edge bg-surface-1 p-4">
                      {([
                        { key: 'greetingMessage', label: 'greetingMessage', suggest: 'admin.botTemplates.editor.greetingSuggested' },
                        { key: 'fallbackMessage', label: 'fallbackMessage', suggest: 'admin.botTemplates.editor.fallbackSuggested' },
                        { key: 'offHoursMessage', label: 'offHoursMessage', suggest: 'admin.botTemplates.editor.offHoursSuggested' },
                      ] as const).map((f) => (
                        <div key={f.key} className="space-y-1.5">
                          <div className="flex items-center justify-between">
                            <Label htmlFor={`c-${f.key}`}>{t(`admin.botTemplates.editor.${f.label}`)}</Label>
                            {!ro && !cfg[f.key].trim() && (
                              <button type="button" className="text-xs font-medium text-primary-400 hover:text-primary-300" onClick={() => insertMsg(f.key, f.suggest)}>
                                {t('admin.botTemplates.editor.insertSuggested')}
                              </button>
                            )}
                          </div>
                          <Textarea id={`c-${f.key}`} rows={2} value={cfg[f.key]} readOnly={ro} onChange={(e) => setCfg({ [f.key]: e.target.value } as Partial<ConfigDraft>)} />
                        </div>
                      ))}
                    </div>

                    {/* Topics to avoid — chips + one-click common bundle */}
                    <div className="space-y-1.5 rounded-xl border border-edge bg-surface-1 p-4">
                      <div className="flex items-center justify-between">
                        <Label>{t('admin.botTemplates.editor.topicsToAvoid')}</Label>
                        {!ro && (
                          <button type="button" className="text-xs font-medium text-primary-400 hover:text-primary-300" onClick={() => setCfg({ topicsToAvoid: Array.from(new Set([...topicsArr, ...COMMON_TOPICS])).join(', ') })}>
                            {t('admin.botTemplates.editor.topicsAddCommon')}
                          </button>
                        )}
                      </div>
                      <TagInput value={topicsArr} onChange={(arr) => setCfg({ topicsToAvoid: arr.join(', ') })} placeholder={t('admin.botTemplates.editor.topicsPlaceholder')} disabled={ro} />
                      <p className="text-xs text-text-tertiary">{t('admin.botTemplates.editor.topicsHint')}</p>
                    </div>

                    <div className="grid items-start gap-4 sm:grid-cols-2">
                      {/* Confidence — labeled slider */}
                      <div className="space-y-2 rounded-xl border border-edge bg-surface-1 p-4">
                        <div className="flex items-center justify-between">
                          <Label>{t('admin.botTemplates.editor.confidenceThreshold')}</Label>
                          <span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs font-medium text-text-primary">{confidence.toFixed(2)}</span>
                        </div>
                        <Slider value={[confidence]} min={0.4} max={0.95} step={0.05} disabled={ro} onValueChange={([v]) => setCfg({ confidenceThreshold: String(v) })} />
                        <div className="flex justify-between text-[10px] text-text-tertiary">
                          <span>{t('admin.botTemplates.editor.confidenceFlexible')}</span>
                          <span>{t('admin.botTemplates.editor.confidenceBalanced')}</span>
                          <span>{t('admin.botTemplates.editor.confidenceStrict')}</span>
                        </div>
                        <p className="text-[10px] text-text-tertiary">{t('admin.botTemplates.editor.confidenceHelper')}</p>
                      </div>

                      {/* Max response length — preset chips + number */}
                      <div className="space-y-2 rounded-xl border border-edge bg-surface-1 p-4">
                        <Label htmlFor="c-maxlen">{t('admin.botTemplates.editor.maxResponseLength')}</Label>
                        {!ro && (
                          <div className="flex flex-wrap gap-1.5">
                            {LENGTH_PRESETS.map((p) => (
                              <Button key={p.value} type="button" variant={cfg.maxResponseLength === p.value ? 'default' : 'outline'} size="sm" className="h-7 text-xs" onClick={() => setCfg({ maxResponseLength: p.value })}>
                                {t(`admin.botTemplates.editor.length.${p.value}`)} <span className="ml-1 opacity-60">{p.words}</span>
                              </Button>
                            ))}
                          </div>
                        )}
                        <Input id="c-maxlen" type="number" step="50" min="1" className="max-w-[140px]" value={cfg.maxResponseLength} readOnly={ro} onChange={(e) => setCfg({ maxResponseLength: e.target.value })} />
                      </div>
                    </div>
                  </div>
                );
              })()}
            </AuthorSection>

            {/* 04 — Version notes: what changed in this draft. */}
            <AuthorSection step={4} icon={Pencil} title={t('admin.botTemplates.editor.changelog')}>
              <Input id="d-changelog" value={draft.changelog} readOnly={draft.mode === 'view'} onChange={(e) => setDraft((d) => ({ ...d, changelog: e.target.value }))} />
            </AuthorSection>

            {/* 05 — Test this prompt: try the current draft (body + config) before publishing. */}
            <AuthorSection step={5} icon={FlaskConical} title={t('admin.botTemplates.editor.testTitle')} hint={t('admin.botTemplates.editor.testHint')} last>
              <div className="space-y-3 rounded-xl border border-edge bg-surface-1 p-4">
                {testLog.length > 0 && (
                  <div className="max-h-48 space-y-2 overflow-y-auto rounded-lg bg-surface-2 p-2">
                    {testLog.map((mtest, i) => (
                      <div key={i} className={mtest.role === 'user' ? 'text-right' : 'text-left'}>
                        <span className={`inline-block rounded-lg px-2.5 py-1.5 text-xs ${mtest.role === 'user' ? 'bg-primary-600 text-white' : 'bg-surface-3 text-text-primary'}`}>
                          {mtest.content}
                        </span>
                      </div>
                    ))}
                    {testChat.isPending && <p className="text-xs text-text-tertiary">{t('admin.botTemplates.editor.testThinking')}</p>}
                  </div>
                )}
                <div className="flex gap-2">
                  <Input
                    value={testInput}
                    placeholder={t('admin.botTemplates.editor.testPlaceholder')}
                    onChange={(e) => setTestInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void runTest(); } }}
                  />
                  <Button type="button" onClick={() => void runTest()} disabled={testChat.isPending || !testInput.trim()}>
                    {t('admin.botTemplates.editor.testSend')}
                  </Button>
                </div>
              </div>
            </AuthorSection>

            </div>
            </div>
            {/* RIGHT — live preview: a "monitor" rail. Outcomes first, ledger on demand. */}
            <aside className="relative space-y-4 overflow-y-auto border-t border-edge bg-surface-0 p-5 lg:border-l lg:border-t-0">
              <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 hidden h-px bg-gradient-to-r from-transparent via-primary-500/40 to-transparent lg:block" />
              <div className="flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-md bg-surface-2 text-primary-300 ring-1 ring-inset ring-edge">
                  <Eye className="h-3.5 w-3.5" />
                </span>
                <div>
                  <h3 className="text-sm font-semibold text-text-primary">Preview a scenario</h3>
                </div>
              </div>
              <p className="text-xs text-text-tertiary">Simulated — what a bot on this template would receive. Not this bot’s real settings.</p>

              <div className="space-y-3 rounded-xl border border-edge bg-surface-1 p-3">
                <div>
                  <label className="mb-1 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-text-tertiary">
                    <SlidersHorizontal className="h-3 w-3" />Plan
                  </label>
                  <Select value={pvTier} onValueChange={(v) => setPvTier(v as typeof pvTier)}>
                    <SelectTrigger aria-label="Plan" className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>{(['free', 'essential', 'pro', 'enterprise'] as const).map((x) => <SelectItem key={x} value={x}>{TIER_LABELS[x]}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-text-tertiary">Preview channel</span>
                  <Select value={pvChannel} onValueChange={setPvChannel}>
                    <SelectTrigger aria-label="Channel" className="h-8 w-[150px] text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>{(['widget', 'whatsapp', 'instagram', 'messenger', 'telegram'] as const).map((x) => <SelectItem key={x} value={x}>{CHANNEL_LABELS[x]}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <p className="text-[10px] leading-relaxed text-text-tertiary">{COMPOSABLE_TEMPLATES_ENABLED ? 'Booking and other skills follow the modules you select. Channel only tweaks reply length and proactive contact.' : 'Booking and other modules follow the template’s Expected modules. Channel only tweaks reply length and proactive contact.'}</p>
              </div>

              {preview.isPending && (
                <p className="flex items-center gap-2 text-xs text-text-tertiary">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary-400" />Compiling…
                </p>
              )}
              {preview.data ? (() => {
                const ledger = preview.data;
                const included = ledger.includedBlocks.filter((b) => !PREVIEW_HIDDEN_BLOCKS.has(b));
                const excluded = ledger.excludedBlocks.filter((e) => !PREVIEW_HIDDEN_BLOCKS.has(e.key));
                return (
                  <>
                    <div className="space-y-2 rounded-xl border border-edge bg-surface-1 p-3">
                      <RailLabel>In this scenario the bot can</RailLabel>
                      <div className="space-y-1.5">
                        {PREVIEW_CAPABILITIES.map((cap) => {
                          const on = ledger.allowedTools.includes(cap.tool);
                          return (
                            <div key={cap.tool} className={`flex items-start gap-2 text-xs ${on ? 'text-text-primary' : 'text-text-muted'}`}>
                              {on
                                ? <span className="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-status-online/15"><Check className="h-2.5 w-2.5 text-status-online" /></span>
                                : <span className="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-status-away/15"><TriangleAlert className="h-2.5 w-2.5 text-status-away" /></span>}
                              <span>{cap.label}{!on && cap.whenAbsent ? ` — ${cap.whenAbsent}` : ''}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* Composable-templates: per-skill state badges for the modules
                        this template binds, derived from the scenario ledger. */}
                    {COMPOSABLE_TEMPLATES_ENABLED && (() => {
                      const skills = boundSkillIds(draft.selectedModuleIds);
                      if (skills.length === 0) {
                        return <p className="rounded-xl border border-dashed border-edge px-3 py-3 text-xs text-text-tertiary">Add a module on the left to preview its skill.</p>;
                      }
                      return (
                        <div className="space-y-1.5">
                          <RailLabel>Skills from modules</RailLabel>
                          {skills.map((sid) => {
                            const meta = skillsCatalog?.find((s) => s.id === sid);
                            const provides = meta?.provides ?? SKILL_PREVIEW[sid]?.tools ?? [];
                            const readyTools = provides.filter((tn) => ledger.allowedTools.includes(tn));
                            // A skill that needs per-bot setup (booking) reads ready only when its
                            // tools surface; inert catalog skills (handoff, lead capture) need no
                            // setup, so they read ready as soon as the template composes them.
                            const state: SkillState =
                              meta && !meta.needsSetup ? 'ready' : readyTools.length > 0 ? 'ready' : 'unconfigured';
                            const name = meta?.displayName ?? moduleCatalog.find((mc) => mc.id === sid)?.displayName ?? SKILL_PREVIEW[sid]?.label ?? sid;
                            return <SkillStateCard key={sid} skill={{ id: sid, name, state, remedy: stateToRemedy(state) }} readyTools={readyTools} />;
                          })}
                        </div>
                      );
                    })()}

                    <Accordion type="single" collapsible className="w-full">
                      <AccordionItem value="tech" className="rounded-xl border border-edge px-4 border-b">
                        <AccordionTrigger className="hover:no-underline text-xs font-medium">Show technical details</AccordionTrigger>
                        <AccordionContent className="space-y-3 text-xs">
                          <TooltipProvider delayDuration={150}>
                            <div>
                              <div className="mb-1 text-[10px] uppercase tracking-wider text-text-tertiary">Prompt blocks included ({included.length})</div>
                              {included.map((b) => (
                                <div key={b} className="flex items-center gap-2 border-b border-edge/40 py-1 font-mono text-text-primary"><Check className="h-3 w-3 shrink-0 text-status-online" /><BlockKey name={b} /></div>
                              ))}
                            </div>
                            {excluded.length > 0 && (
                              <div>
                                <div className="mb-1 text-[10px] uppercase tracking-wider text-text-tertiary">Not in this scenario ({excluded.length})</div>
                                {excluded.map((e) => (
                                  <div key={e.key} className="flex items-center gap-2 border-b border-edge/40 py-1 font-mono text-text-tertiary"><X className="h-3 w-3 shrink-0" /><BlockKey name={e.key} /><span className="ml-auto rounded border border-edge bg-surface-2 px-1.5 py-0.5 font-sans text-[10px]">{EXCLUDED_NOTE[e.key] ?? REASON_TEXT[e.reason] ?? e.reason}</span></div>
                                ))}
                              </div>
                            )}
                            <div className="font-mono text-text-secondary"><span className="mb-1 block text-[10px] uppercase tracking-wider text-text-tertiary">Tools available</span>{ledger.allowedTools.join(', ') || '—'}</div>
                          </TooltipProvider>
                        </AccordionContent>
                      </AccordionItem>
                    </Accordion>
                  </>
                );
              })() : !preview.isPending ? (
                <div className="rounded-xl border border-dashed border-edge px-4 py-8 text-center">
                  <Eye className="mx-auto mb-2 h-5 w-5 text-text-muted" />
                  <p className="text-xs text-text-tertiary">Write the prompt — a preview of what the bot can do appears here.</p>
                </div>
              ) : null}
            </aside>
          </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>

      {/* Force-confirm dialog */}
      <AlertDialog open={confirm.open} onOpenChange={(o) => setConfirm((c) => ({ ...c, open: o }))}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirm.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={confirm.onConfirm}>{t('admin.botTemplates.confirm.proceed')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
    </div>
  );
};

export default AdminBotTemplateDetail;
