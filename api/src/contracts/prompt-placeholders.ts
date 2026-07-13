/**
 * The canonical {placeholder} catalog — the SINGLE source of truth shared by:
 *   - the composer          (api/src/llm/placeholder-registry.ts → buildVariableMap)
 *   - the template linter   (api/src/templates/template-admin.service.ts)
 *   - the template editor   (portal/src/pages/admin/AdminBotTemplateDetail.tsx)
 *
 * Before this file the set was duplicated in all three, and drift was a live bug
 * class: a key known to the composer but not the linter → publish blocked; known
 * to the linter but not the composer → a literal "{key}" leaked into the prompt.
 *
 * Rules for this directory are "wire contracts, pure types only". This file is a
 * DELIBERATE, DOCUMENTED EXCEPTION: it is self-contained INERT DATA (no imports,
 * no behaviour), because the portal needs the runtime VALUES (labels/descriptions
 * for the editor chips) — a type-only union erases at runtime and would force the
 * portal to re-declare the list, reintroducing the drift this file exists to kill.
 *
 * ── SECURITY ──────────────────────────────────────────────────────────────────
 * Every value in this catalog is substituted verbatim into the LLM system prompt.
 * NEVER add a secret (api key, token, webhook url/secret, credential) or PII.
 * `safeToExpose` is typed as the LITERAL `true`, so a field marked otherwise
 * cannot type-check in; `placeholder-registry.test.ts` is the runtime backstop.
 *
 * NOTE: `extraInfo` is intentionally ABSENT. It renders only as a fenced,
 * lowest-authority block — exposing it as a substitution would let tenant text be
 * injected UNFENCED into a higher-authority position in the prompt.
 */

export type PlaceholderCategory = 'identity' | 'tone' | 'messaging' | 'contact' | 'booking' | 'guardrail';

export interface PlaceholderCatalogEntry {
  /** The `{key}` an author writes. */
  key: string;
  /** Short human label for the editor chip. */
  label: string;
  /** One-line explanation shown to template authors. */
  description: string;
  category: PlaceholderCategory;
  /** LITERAL true — a value that is not safe to echo into the prompt cannot be listed. */
  safeToExpose: true;
  /** Belt-and-braces default if a resolver ever yields undefined. Never a literal "{key}". */
  failClosed: string;
}

export const PLACEHOLDER_CATALOG = [
  {
    key: 'botName',
    label: 'Bot name',
    description: "The bot's display name.",
    category: 'identity',
    safeToExpose: true,
    failClosed: 'AI Assistant',
  },
  {
    key: 'businessName',
    label: 'Business name',
    description: "The bot's per-bot trading name, else the organisation name.",
    category: 'identity',
    safeToExpose: true,
    failClosed: '',
  },
  {
    key: 'tone',
    label: 'Tone',
    description: "The bot's configured voice tone (per-channel override applies on social).",
    category: 'tone',
    safeToExpose: true,
    failClosed: 'friendly',
  },
  {
    key: 'supportEmail',
    label: 'Support email',
    description: 'Email used for escalations, visible to customers.',
    category: 'contact',
    safeToExpose: true,
    failClosed: '',
  },
  {
    key: 'greetingMessage',
    label: 'Greeting',
    description: "The bot's opening greeting.",
    category: 'messaging',
    safeToExpose: true,
    failClosed: '',
  },
  {
    key: 'fallbackMessage',
    label: 'Fallback message',
    description: "What the bot says when it can't answer confidently.",
    category: 'guardrail',
    safeToExpose: true,
    failClosed: '',
  },
  {
    key: 'offHoursMessage',
    label: 'Off-hours message',
    description: 'What the bot says outside business hours.',
    category: 'guardrail',
    safeToExpose: true,
    failClosed: '',
  },
  {
    key: 'maxResponseLength',
    label: 'Max response length',
    description: 'Maximum reply length in characters.',
    category: 'guardrail',
    safeToExpose: true,
    failClosed: '500',
  },
  {
    key: 'topicsToAvoid',
    label: 'Topics to avoid',
    description: 'Comma-separated topics the bot must never discuss.',
    category: 'guardrail',
    safeToExpose: true,
    failClosed: 'N/A',
  },
  {
    key: 'services',
    label: 'Services',
    description: "The bot's bookable services (name, duration, price). Empty when the bot can't book.",
    category: 'booking',
    safeToExpose: true,
    failClosed: '',
  },
  {
    key: 'openingHours',
    label: 'Opening hours',
    description: "The business's opening hours. Booking availability if set, else the operational business hours.",
    category: 'booking',
    safeToExpose: true,
    failClosed: '',
  },
] as const satisfies readonly PlaceholderCatalogEntry[];

/** Every `{key}` an author may write. Consumed by the linter + the editor. */
export const PLACEHOLDER_KEYS: ReadonlySet<string> = new Set(PLACEHOLDER_CATALOG.map((e) => e.key));

/** Union of the catalog keys — makes the composer's resolver map exhaustive. */
export type PlaceholderKey = (typeof PLACEHOLDER_CATALOG)[number]['key'];
