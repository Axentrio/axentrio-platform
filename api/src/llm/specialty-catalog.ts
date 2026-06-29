// SpecialtyCatalog (AC12/AC13) — superadmin-authored specialty DATA, in code like
// BUSINESS_PRESETS / allModules / PROMPT_BLOCK_KEYS (no DB table). Per-bot SELECTION
// lives in Bot.settings.ai.selectedSpecialties (jsonb, no migration). Specialties
// scope to a vertical via the bound template's category (S2). v1 ships a plumber
// tracer; authoring the full catalog is a domain task, not code. See
// plan-dynamic-prompt-builder.md S1–S6.

export interface SpecialtyIntakeField {
  id: string;
  label: string;
  type: string;
  required: boolean;
  options?: string[];
}

export interface SpecialtyDef {
  /** Maps to BotTemplate.category (the vertical slug), e.g. 'plumber'. */
  businessType: string;
  /** Unique within a businessType; the ledger slug → SPECIALTY_<specialtyKey>. */
  specialtyKey: string;
  name: string;
  description: string;
  /** Retrieval-expansion terms (S5) + future UI search. */
  aliases: string[];
  /** Retrieval-expansion terms (S5); future hard tags. */
  knowledgeBaseTags: string[];
  /** UI hint that can seed ServiceType.intakeQuestions — no schema coupling. */
  recommendedIntakeFields: SpecialtyIntakeField[];
  /** On by default for the vertical when the bot has made no explicit selection (S6). */
  defaultEnabled: boolean;
  /** Gates the SPECIALTY_<key> prompt block (AC13). */
  requiresSpecialPrompt: boolean;
  /** Key into SPECIALTY_PROMPT_BLOCKS; null when requiresSpecialPrompt is false. */
  relatedPromptBlockId: string | null;
}

/** Platform-managed block texts (authored in code like L11's social block). */
export const SPECIALTY_PROMPT_BLOCKS: Record<string, string> = {
  'plumber.emergency': `EMERGENCY HANDLING: if the customer describes an active leak, burst pipe, flooding, or no water, treat it as urgent — acknowledge briefly, gather the address and a callback number first, and offer the fastest available response or escalation rather than a routine booking flow.`,
};

export const SPECIALTY_CATALOG: SpecialtyDef[] = [
  {
    businessType: 'plumber',
    specialtyKey: 'leaks',
    name: 'Leaks',
    description: 'Dripping taps, pipe leaks, water ingress.',
    aliases: ['leak', 'dripping', 'water leak', 'leaking pipe'],
    knowledgeBaseTags: ['leak', 'leaks', 'pipe', 'drip'],
    recommendedIntakeFields: [{ id: 'location', label: 'Where is the leak?', type: 'text', required: true }],
    defaultEnabled: true,
    requiresSpecialPrompt: false,
    relatedPromptBlockId: null,
  },
  {
    businessType: 'plumber',
    specialtyKey: 'blocked_drains',
    name: 'Blocked drains',
    description: 'Clogged or slow drains, blockages.',
    aliases: ['blocked drain', 'clogged drain', 'blockage', 'slow drain'],
    knowledgeBaseTags: ['drain', 'drains', 'clog', 'blockage'],
    recommendedIntakeFields: [],
    defaultEnabled: true,
    requiresSpecialPrompt: false,
    relatedPromptBlockId: null,
  },
  {
    businessType: 'plumber',
    specialtyKey: 'emergency',
    name: 'Emergency call-out',
    description: 'Urgent issues needing a faster escalation flow.',
    aliases: ['emergency', 'urgent', 'burst pipe', 'flooding', 'no water'],
    knowledgeBaseTags: ['emergency', 'urgent', 'burst'],
    recommendedIntakeFields: [{ id: 'address', label: 'Service address', type: 'text', required: true }],
    defaultEnabled: false,
    requiresSpecialPrompt: true,
    relatedPromptBlockId: 'plumber.emergency',
  },
];

/** A selected specialty resolved for composition (S4). */
export interface ResolvedSpecialty {
  key: string;
  name: string;
  /** The exception block text, or null when this specialty carries none. */
  block: string | null;
  requiresSpecialPrompt: boolean;
}

/** Specialties defined for a vertical (matched on the bound template's category/key). */
export function specialtiesForVertical(vertical: string | null | undefined): SpecialtyDef[] {
  if (!vertical) return [];
  return SPECIALTY_CATALOG.filter((s) => s.businessType === vertical);
}

/**
 * The bot's effective specialty defs for its vertical (S6): explicit selection when
 * present, else the vertical's default-enabled specialties. A behaviour-changing
 * (requiresSpecialPrompt) block is only ever applied via EXPLICIT selection — never
 * the default fallback — so a live bot never silently changes behaviour.
 */
export function effectiveSelectedSpecialties(
  selected: string[] | undefined,
  vertical: string | null | undefined,
): SpecialtyDef[] {
  const forVertical = specialtiesForVertical(vertical);
  if (selected && selected.length > 0) {
    const set = new Set(selected);
    return forVertical.filter((s) => set.has(s.specialtyKey));
  }
  // No explicit selection → default-enabled, and never auto-apply an exception block.
  return forVertical.filter((s) => s.defaultEnabled && !s.requiresSpecialPrompt);
}

/** Resolve specialty defs into composition inputs (S4). */
export function resolveSpecialties(defs: SpecialtyDef[]): ResolvedSpecialty[] {
  return defs.map((d) => ({
    key: d.specialtyKey,
    name: d.name,
    requiresSpecialPrompt: d.requiresSpecialPrompt,
    block: d.requiresSpecialPrompt && d.relatedPromptBlockId
      ? SPECIALTY_PROMPT_BLOCKS[d.relatedPromptBlockId] ?? null
      : null,
  }));
}

/** Retrieval-expansion terms from selected specialties (S5) — aliases + KB tags, deduped. */
export function specialtyRetrievalTerms(defs: SpecialtyDef[]): string[] {
  return [...new Set(defs.flatMap((d) => [...d.aliases, ...d.knowledgeBaseTags]))];
}
