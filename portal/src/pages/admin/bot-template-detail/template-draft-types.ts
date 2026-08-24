/**
 * Draft shapes the Bot Template editor edits in local state, plus the pure
 * mapping to and from the persisted BotTemplateConfig. Leaf module: it never
 * imports AdminBotTemplateDetail.tsx.
 */
import type { BotTemplateConfig, TemplateVariable } from '../../../queries/useBotTemplatesQueries';
import { DEFAULT_CONFIDENCE, DEFAULT_MAX_LENGTH } from './template-constants';

// Policy guardrails are edited as flat strings in the dialog, then assembled into
// a BotTemplateConfig on save. Confidence/max-length carry real defaults; messages
// + topics stay empty (opt-in via "Insert suggested"). Tone is bot-owned, not here.
export type ConfigDraft = {
  topicsToAvoid: string;
  greetingMessage: string;
  fallbackMessage: string;
  offHoursMessage: string;
  confidenceThreshold: string;
  maxResponseLength: string;
};
export const EMPTY_CONFIG: ConfigDraft = {
  topicsToAvoid: '', greetingMessage: '', fallbackMessage: '', offHoursMessage: '', confidenceThreshold: DEFAULT_CONFIDENCE, maxResponseLength: DEFAULT_MAX_LENGTH,
};

export type VersionDraft = { open: boolean; mode: 'create' | 'edit' | 'view'; version?: number; lockVersion?: number; body: string; changelog: string; expectedModules: string; selectedSkillIds: string[]; skillProse: Record<string, string>; variables: TemplateVariable[]; config: ConfigDraft };
export const EMPTY_DRAFT: VersionDraft = { open: false, mode: 'create', body: '', changelog: '', expectedModules: '', selectedSkillIds: [], skillProse: {}, variables: [], config: EMPTY_CONFIG };

export function configToDraft(c: BotTemplateConfig | undefined): ConfigDraft {
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

export function draftToConfig(d: ConfigDraft): BotTemplateConfig {
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

/** Count the guardrail fields a template actually sets (for the current-prompt summary). */
export function countGuardrails(c: BotTemplateConfig): number {
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
