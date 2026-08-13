import crypto from 'crypto';
import type { OfferScoring } from '../booking/travel/score-offer';
import { DateTime } from 'luxon';
import type { OfferMeasurement } from '../channels/response.types';
import { ToolRegistry } from './tool-registry';
import { PromptBuilder } from './prompt-builder';
import { MeteringService } from './metering.service';
import { TraceLogger, AgentTrace } from './trace-logger';
import { ToolContext } from './tool-adapter';
import { getProvider } from '../llm/provider-factory';
import { buildPromptTrace } from '../llm/block-ledger';
import { effectiveSelectedSpecialties, resolveSpecialties, specialtyRetrievalTerms } from '../llm/specialty-catalog';
import { DEFAULT_PROVIDER, DEFAULT_MODEL } from '../llm/defaults';
import { ChatMessage, ContentPart, ToolDefinition } from '../llm/llm.types';
import { ChatSession } from '../database/entities/ChatSession';
import { getEntitlements } from '../billing/entitlements';
import { shouldAskForContact } from '../leads/proactive/should-ask';
import type { ToolAdapter, Affordance, BookingAddressReplyFact } from './tool-adapter';
import { readAskState, withAskState, ASK_STATE_KEY } from '../leads/proactive/ask-state';
import { ConversationBinding } from '../database/entities/ConversationBinding';
import { AvailabilityRule } from '../database/entities/AvailabilityRule';
import { BookingSettings } from '../database/entities/BookingSettings';
import { describeServiceArea } from '../contracts/service-area';
import { ServiceType } from '../database/entities/ServiceType';
import { Tenant } from '../database/entities/Tenant';
import { AppDataSource } from '../database/data-source';
import { listActiveModules } from '../modules';
import { getModule, gatedToolNames, skillPromptAllowed } from '../modules/module-catalog';
import { resolveSkillStates, dropUnreadySkillTools } from '../modules/skill-state';
import { readinessRefinement } from '../llm/skill-readiness';
import { logger } from '../utils/logger';
import { getLlmRuntimeConfigForSession } from '../services/bot-config.service';
import { resolveBoundTemplates, composeTemplateBodies, effectiveConfigFromList, withEffectiveConfig, templateUnavailabilityReason, selectSkillIds } from '../templates/template-resolver';
import { isBookingConfigured } from '../scheduler/booking-readiness';
import { buildBoundAddressSection, formatServicesForPlaceholder, formatHoursForPlaceholder } from '../modules/booking.module';
import { getBoundAddress } from '../booking/travel/address-binding';
import { formatBusinessHoursForPlaceholder } from '../utils/format-business-hours';
import { isUpstreamQuotaExhausted, isUpstreamRateLimit } from '../llm/upstream-error';
import { searchKnowledge } from '../llm/rag.service';
import { getBotKnowledgeBaseIds } from '../knowledge/bot-knowledge-bases';

/** A tappable suggestion rendered by the widget (e.g. an appointment slot). */
export interface QuickReply {
  title: string;
  value: string;
}

export type AgentResult =
  | {
      type: 'response';
      content: string;
      quickReplies?: QuickReply[];
      /**
       * A control the client should offer, decided by the server and never by the model.
       *
       * Distinct from `quickReplies`, which are suggested SENTENCES: a chip's value is sent back
       * as an ordinary customer message, so anything routed through one is a claim the model then
       * reads. An affordance is the opposite - it opens a control whose result comes back through
       * an endpoint the server owns, which is the only kind of evidence allowed to move an
       * **Address Binding**.
       */
      affordance?: Affordance;
      /**
       * #80 (LP3) measurement, carried to whoever delivers this reply.
       *
       * Not part of the answer - nothing renders it. It exists because the offer can only be
       * recorded where BOTH halves are known: the delivering path knows what the channel kept,
       * and only the agent knows the canonical instants behind the natural-language chips.
       */
      offer?: OfferMeasurement;
    }
  | { type: 'awaiting_confirmation'; toolCallId: string; toolName: string; preview: Record<string, unknown>; message: string }
  | { type: 'max_iterations'; fallbackMessage: string }
  | { type: 'budget_exceeded'; fallbackMessage: string }
  | {
      type: 'error';
      error: string;
      fallbackMessage: string;
      /**
       * The provider failed (out of credit, throttled, unreachable) rather than
       * the bot. Callers must NOT hand these to a human: an infra outage hits
       * every conversation at once, so it would park the entire inbox in handoff
       * — and a handoff silences the bot until the 60-minute sweep, which each
       * new customer message pushes further out. The operator alert for this is
       * the health probe (llm/provider-health), not a per-conversation handoff.
       */
      infraFailure?: boolean;
    };

const MAX_ITERATIONS = 10;

/** An image attached to the live user turn, already fetched + base64-encoded. */
export interface AgentImageInput {
  mimeType: string;
  data: string;
}

/** Build the live user turn — multimodal when images are attached, plain string
 *  otherwise (so the common text path is unchanged). */
function buildUserContent(message: string, images?: AgentImageInput[]): string | ContentPart[] {
  if (!images || images.length === 0) return message;
  const parts: ContentPart[] = [];
  if (message) parts.push({ type: 'text', text: message });
  for (const img of images) parts.push({ type: 'image', mimeType: img.mimeType, data: img.data });
  return parts;
}

const BOOKING_MUTATION_TOOLS = ['create_booking', 'request_appointment', 'reschedule_booking', 'cancel_booking'];

interface PendingAvailability {
  slots: Array<{ start: string; end: string }>;
  timezone: string;
  /** #80: carried so the offer record can name the service and its mode without a later join. */
  serviceId?: string;
  locationMode?: string;
  /** The service the slots are for — embedded in the chip so a tap books the
   *  right service when the bot offers more than one. */
  serviceName?: string;
  /** #81: shadow scoring, carried to dispatch to be recorded. Never shown to model or customer. */
  grouping?: OfferScoring;
  /** #82: the pilot was on for this call, which is the cohort rather than the outcome. */
  groupingPilot?: boolean;
  /** #82: whether the order was actually changed, for the owner's durable audit trail. */
  grouped?: { savedMinutes: number };
  /** #82: the pre-reorder order, so dispatch can tell whether the DELIVERED prefix changed. */
  groupingPreviousOrder?: string[];
}

/**
 * Turn freshly-offered availability into tappable slot chips.
 *
 * `title` is the human-readable button label; `value` is the message sent back
 * when tapped — a natural-language, absolute date+time+tz the LLM can re-book
 * from. (Telegram's 64-byte callback_data limit doesn't constrain this: quick
 * replies are disabled on the Telegram adapter; the widget + Messenger/IG/
 * WhatsApp have ample payload room.)
 */
function buildSlotQuickReplies(av: PendingAvailability | null): QuickReply[] | undefined {
  if (!av || !av.slots.length) return undefined;
  const forService = av.serviceName ? `${av.serviceName} on ` : '';
  return av.slots.slice(0, 8).map((s) => {
    const dt = DateTime.fromISO(s.start).setZone(av.timezone);
    return {
      title: dt.toFormat('ccc h:mm a'),
      value: `Book ${forService}${dt.toFormat('cccc d LLLL')} at ${dt.toFormat('h:mm a')} (${av.timezone})`,
    };
  });
}

/**
 * Best-effort detector for a final reply that CLAIMS a booking/request was made
 * (or is being made right now). Used ONLY as a hazard signal — what authorizes a
 * confirmation is whether a booking mutation actually succeeded this run (see the
 * egress guard). Patterns are narrow to avoid firing on "you requested X" or a
 * conditional "I'll book it once you confirm". Best-effort per language: English +
 * Dutch (the platform's primary non-English audience) patterns below; the prompt
 * rule is the backstop for languages not covered. NOTE: a fully language-agnostic
 * claim detector needs an LLM classifier — tracked as a follow-up.
 */
function claimsBookingDone(text: string): boolean {
  const t = text.toLowerCase();
  // Narrow, "the bot just did / is about to do it" phrasings. We deliberately
  // avoid ambiguous wording like "your appointment is confirmed" that could refer
  // to an EXISTING booking — the bookingRecorded flag already prevents firing on a
  // legitimate fresh confirmation, so the patterns only need to catch the
  // hallucinated "I did this" claims.
  return [
    // English
    /\bi'?ve (successfully )?(booked|scheduled|requested|submitted|placed|created)\b/,
    /\bi'?ll (go ahead and (book|request|submit|schedule)|proceed( with (the|your|this))?)\b/,
    /\bsuccessfully (requested|booked|scheduled|submitted|created)\b/,
    /\byour (booking|request) (has been|is) (submitted|created|placed|received|sent|booked)\b/,
    // Dutch (best-effort — mirrors the English "I did it" / "your booking is done" shapes)
    /\bik heb (je|uw|het|de|een)?\s?(afspraak|reservering|boeking)?\s?(ge(boekt|reserveerd|pland)|ingepland|aangevraagd|vastgelegd)\b/,
    /\b(je|uw|de) (afspraak|reservering|boeking) (is|staat) (ge(boekt|reserveerd|pland)|ingepland|bevestigd|vastgelegd|aangevraagd)\b/,
  ].some((re) => re.test(t));
}

/**
 * Times the reply NAMES that were never offered.
 *
 * The sibling of `claimsBookingDone`, for the other half of the same lie. That one catches a
 * booking the model says it made; this catches a time the model says is free. Seen in production:
 * the chips carried 9:00, 9:30, 12:30, 13:00, 13:30, 14:00, 14:30, 15:00 while the sentence above
 * them read "09:30, 11:30, 12:00, 12:30, 13:00, 13:30, and 14:00" — two times nobody could book,
 * and three real ones left out. A customer reading the words asks for a slot that does not exist.
 *
 * NARROW ON PURPOSE, because the cost of firing wrongly is replacing a good reply. It only looks
 * at replies that are ENUMERATING (two or more clock times), and only ever compares against a list
 * we just offered. A single time in prose — "we open at 9:00" — is left alone.
 */
export function unofferedTimesIn(text: string, offeredLocal: string[]): string[] {
  // `9:00`, `09:30`, `1:30 PM`, `13.00`. Requires minutes, so a bare "9" or a price is not a time.
  const found = [...text.matchAll(/\b(\d{1,2})[:.](\d{2})\s*([ap]\.?m\.?)?/gi)];
  if (found.length < 2) return [];

  const offered = new Set(offeredLocal);
  const named: string[] = [];
  for (const m of found) {
    let hour = Number(m[1]);
    const minute = Number(m[2]);
    if (hour > 23 || minute > 59) continue;
    const suffix = (m[3] ?? '').toLowerCase().replace(/\./g, '');
    if (suffix === 'pm' && hour < 12) hour += 12;
    if (suffix === 'am' && hour === 12) hour = 0;
    const key = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    // A 12-hour time with no suffix is ambiguous — "1:30" could be 13:30. Accept either reading,
    // so an unsuffixed time only counts as unoffered when NEITHER interpretation was offered.
    const alt = hour < 12 ? `${String(hour + 12).padStart(2, '0')}:${String(minute).padStart(2, '0')}` : key;
    if (!offered.has(key) && !(suffix === '' && offered.has(alt))) named.push(m[0].trim());
  }
  return named;
}

const BELGIAN_COUNTRY_TOKENS = new Set(['be', 'belgie', 'belgique', 'belgien', 'belgium']);

function addressTokens(value: string): string[] {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('en')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Whether a reply contains the authoritative Belgian address as one intact token sequence.
 *
 * Country suffixes and a recognisable Belgian postcode are presentation details, so the model may
 * omit them. Street and door number are not: keeping both in the sequence makes `1` different from
 * `12`, and refuses a street-only paraphrase when the authoritative address has a door number.
 */
export function addressClaimIn(text: string, authoritativeAddress: string): boolean {
  const segments = authoritativeAddress.split(',');
  const localitySegments = segments.slice(1);
  const authoritativeTokens = addressTokens(authoritativeAddress);
  const delimitedPostcode = localitySegments
    .flatMap(addressTokens)
    .find((token) => /^\d{4}$/.test(token));
  // Without commas, only discard a four-digit token when another number already established the
  // door before it. `Langeweg 2000 Gent` stays a door; `Kerkstraat 12 2000 Antwerpen` has a
  // distinct door and postcode.
  const inferredPostcode = authoritativeTokens.find((token, index) =>
    /^\d{4}$/.test(token) &&
    authoritativeTokens.slice(1, index).some((prior) => /\d/.test(prior)) &&
    authoritativeTokens.slice(index + 1).some((later) => /\p{L}/u.test(later) && !BELGIAN_COUNTRY_TOKENS.has(later))
  );
  const postcode = delimitedPostcode ?? inferredPostcode;
  const ignored = new Set(BELGIAN_COUNTRY_TOKENS);
  if (postcode) ignored.add(postcode);

  const expected = authoritativeTokens.filter((token) => !ignored.has(token));
  if (!expected.length) return false;
  const actual = addressTokens(text).filter((token) => !ignored.has(token));

  outer: for (let start = 0; start <= actual.length - expected.length; start++) {
    for (let offset = 0; offset < expected.length; offset++) {
      if (actual[start + offset] !== expected[offset]) continue outer;
    }
    return true;
  }
  return false;
}

function sameAddress(left: string, right: string): boolean {
  return addressClaimIn(left, right) && addressClaimIn(right, left);
}

function validAddressReply(text: string, fact: BookingAddressReplyFact): boolean {
  if (!addressClaimIn(text, fact.address)) return false;
  return !fact.alternatives.some(
    (alternative) => !sameAddress(alternative, fact.address) && addressClaimIn(text, alternative)
  );
}

function mergeAddressFacts(
  current: BookingAddressReplyFact | null,
  next: BookingAddressReplyFact
): { fact: BookingAddressReplyFact; conflict: boolean } {
  if (!current) return { fact: next, conflict: false };
  if (!sameAddress(current.address, next.address)) return { fact: current, conflict: true };
  return {
    fact: {
      ...next,
      alternatives: [...new Set([...current.alternatives, ...next.alternatives])],
    },
    conflict: false,
  };
}

function addressCorrectionNote(fact: BookingAddressReplyFact): string {
  const action = fact.use === 'availability'
    ? 'the availability was checked for'
    : fact.use === 'confirmed_booking'
      ? 'the booking was confirmed for'
      : 'the appointment request was sent for';
  return `(Internal note, not from the customer.) Your previous reply did not accurately state the address ${action}. Reply again without calling any tools. State this exact address: ${fact.address}. Do not present any earlier address as the one used.`;
}

function addressSafeFallback(fact: BookingAddressReplyFact): string {
  if (fact.use === 'availability') return `Here are the available times for ${fact.address}.`;
  if (fact.use === 'confirmed_booking') return `Your booking is confirmed for ${fact.address}.`;
  return `Your appointment request has been sent for ${fact.address}.`;
}

const ADDRESS_CONFLICT_FALLBACK =
  "Sorry, I can't safely confirm which address was used. Please verify the appointment address with the business.";

/**
 * A reply that lists times is replaced rather than repaired.
 *
 * There is no safe way to edit a sentence that names a wrong time - removing the time leaves
 * grammar nobody wrote, and correcting it means guessing which of the offered slots was meant. The
 * tappable options are attached to this reply and they are authoritative, so pointing at them is
 * both true and enough.
 */
const AVAILABILITY_SAFE_FALLBACK =
  'Here are the times I have available — let me know which one suits you.';

/** Internal nudge (user role — the Anthropic adapter only honours the FIRST system
 *  message) telling the model to actually call the booking tool instead of claiming
 *  a booking it never made. */
const BOOKING_CORRECTION_NOTE =
  "(Internal note, not from the customer.) You just implied to the customer that their booking or request was made, but no booking was recorded this turn. If you HAVE a booking tool and already have the service, the customer's name, and a time, call the correct booking tool now (and only claim it's done once the tool succeeds). If a required detail is missing, ask for it. If you do NOT have a booking tool available, do NOT claim, confirm, or imply any booking — instead offer to take the customer's details so the team can follow up, in the customer's language.";

/** Safe reply when the model keeps claiming a booking that wasn't recorded (after
 *  one correction, or out of iteration budget) — anything but a false confirmation. */
const BOOKING_SAFE_FALLBACK =
  "Sorry, let me just confirm a couple of details before I put that through — could you confirm the date and time you'd like?";

export class AgentService {
  constructor(
    private toolRegistry: ToolRegistry,
    private promptBuilder: PromptBuilder,
    private metering: MeteringService,
    private traceLogger: TraceLogger,
  ) {}

  async run(
    message: string,
    session: ChatSession,
    tenant: Tenant,
    conversationHistory: ChatMessage[],
    images?: AgentImageInput[],
  ): Promise<AgentResult> {
    const runId = crypto.randomUUID();
    // Multi-bot Phase 4 (#16d): resolve the bot config for this session.
    // The behavioural slice (brand voice / guardrails / integrations) lives on
    // Bot.settings; the LLM provider secret stays on Tenant.settings.ai.apiKey
    // and is returned alongside as `apiKey` by this resolver.
    // One resolve for the whole runtime config: bot row + its full settings
    // (the integrations slice the tool registry needs, plus the prompt
    // builder's skills/brandVoice), the AI behavioural slice, and the tenant
    // LLM key — all from a single bot+tenant lookup.
    const { bot, botSettings, botAiSettings, apiKey } = await getLlmRuntimeConfigForSession(session);
    // Tone + policy guardrails come from the bound template (effectiveBotConfig),
    // not the bot. Override the AI slice once so every downstream read (prompt
    // builder, fallback messages) uses the effective values; escalationKeywords
    // and other operational fields are preserved. One resolve → body + config.
    const resolvedTemplates = await resolveBoundTemplates(bot);
    // AC4: surface "the missing vertical" — a bound template that resolved to a
    // fallback (archived/missing/unpublished) is invisible otherwise. Log it with
    // bot+tenant context (the resolver has neither). The superadmin endpoint lists
    // these bots for review.
    const unavailableReason = resolvedTemplates[0] ? templateUnavailabilityReason(resolvedTemplates[0]) : null;
    if (unavailableReason) {
      logger.warn('Bound bot template unavailable — fell back', {
        botId: bot.id,
        tenantId: tenant.id,
        templateId: resolvedTemplates[0].templateId,
        reason: unavailableReason,
      });
    }
    const templateBody = composeTemplateBodies(resolvedTemplates, bot.templateMode ?? 'or');
    const eff = effectiveConfigFromList(resolvedTemplates);
    const aiSettings = botAiSettings ? withEffectiveConfig(botAiSettings, eff) : botAiSettings;
    const effBotSettings = { ...botSettings, ai: aiSettings };
    const trace: AgentTrace = {
      sessionId: session.id,
      tenantId: tenant.id,
      iterations: [],
      finishReason: 'completed',
    };

    try {
      let tools = await this.toolRegistry.getToolsForTenant(tenant, botSettings);
      // Armed from the ENTITLED (pre-gate) tool list, because a template-gated
      // booking bot is exactly the one most likely to be pushed into hallucinating
      // "I've booked you in" — and BOOKING_CORRECTION_NOTE has a branch for a model
      // holding no booking tool. Deliberately NOT `bookingActive` (see below).
      const bookingClaimGuardArmed = tools.some((t) => t.name === 'create_booking');
      // Module prompt contributions (e.g. booking's bookable-services catalog).
      // Each active module builds (and loads data for) its own section; the
      // resolver call hits the same per-tenant caches the tool registry used.
      // Composable-templates: a skill influences the LLM — its TOOLS *and* its PROMPT
      // section — iff its template selected it. Resolve the selection up-front so the
      // module prompt sections below are gated in LOCKSTEP with the tools gated later.
      // Otherwise a no-booking bot still gets booking's "SERVICES (bookable)" catalog +
      // "you MUST call create_booking" text with no tool behind it (LEAK-1). See
      // gatedToolNames — same predicate, applied to the prompt surface.
      const composableEnabled = process.env.COMPOSABLE_TEMPLATES_ENABLED === 'true';
      const expectedModuleIds = resolvedTemplates[0]?.expectedModules;
      // H6: skills come from ALL bound templates (composeTemplateBodies already unions
      // their prompt bodies), not just the primary — else a secondary template's skills
      // silently don't take effect. Union each binding's effective skills.
      const selectedSkillIds = [...new Set(
        resolvedTemplates.flatMap((rt) =>
          selectSkillIds({
            selectedSkillIds: composableEnabled ? (rt.selectedSkillIds ?? null) : null,
            expectedModules: rt.expectedModules ?? [],
          }),
        ),
      )];
      const moduleSections: string[] = [];
      const activeModules = await listActiveModules(tenant.id);
      const activeModuleIds = activeModules.map((a) => a.module.id);
      // Templates are the SOLE source of skills: the bot's skills are exactly what
      // its template composes (∩ entitlements). A Dental template that binds {booking}
      // won't also offer handoff just because the plan allows it; and NO template (or
      // one gone unavailable) → selectedSkillIds is empty → no skills, matching the
      // "answers from your knowledge base only" empty-state. Drop every active skill's
      // tools the template didn't select. Flag-gated (OFF → legacy, entitlement-only).
      //
      // This runs BEFORE anything reads `tools`, because `bookingActive` below is
      // derived from it: gating late let an entitled-but-unselected booking skill
      // pull the AvailabilityRule into {openingHours} and silently discard the
      // tenant's businessHours (which the pre-AI off-hours gate *does* honour, so
      // the two contradicted each other).
      if (composableEnabled) {
        const drop = gatedToolNames(selectedSkillIds, activeModuleIds);
        if (drop.size) tools = tools.filter((tl) => !drop.has(tl.name));
      }
      // Whether the bot can ACTUALLY book — read from the GATED tools. Drives the
      // {openingHours}/{services} sources: a bot that can't book must never quote a
      // booking availability rule it has no skill to use, nor advertise its services.
      const bookingActive = tools.some((t) => t.name === 'create_booking');
      for (const active of activeModules) {
        if (!active.module.buildPromptSection) continue;
        // Prompt gate: skip the section of an active skill the template didn't select.
        if (!skillPromptAllowed(active.module.id, selectedSkillIds, composableEnabled)) continue;
        try {
          const section = await active.module.buildPromptSection({
            tenantId: tenant.id,
            botId: bot.id,
            config: active.config,
          });
          if (section) moduleSections.push(section);
        } catch (error) {
          logger.warn(`Module prompt section failed for ${active.module.id} — skipped`, {
            tenantId: tenant.id,
            error,
          });
        }
      }
      if (bookingActive) {
        const boundAddress = await getBoundAddress(session.id);
        if (boundAddress?.formattedAddress) {
          moduleSections.push(buildBoundAddressSection(boundAddress.formattedAddress));
        }
      }
      // Pre-fill the customer's name from their messaging-channel profile (channel
      // sessions only) so the agent can confirm it rather than ask cold. Widget
      // sessions have no binding/profile name.
      let customerName: string | undefined;
      if (session.channel && session.channel !== 'widget') {
        const binding = await AppDataSource.getRepository(ConversationBinding).findOne({
          where: { sessionId: session.id },
          select: { externalUserName: true },
        });
        customerName = binding?.externalUserName ?? undefined;
      }
      // Anchor the prompt's date context to the booking timezone (booking bots only;
      // one indexed lookup). Non-booking bots fall back to server/UTC as before.
      let bookingTimezone: string | undefined;
      let bookingConfigured = false;
      // Rendered values for the {services} / {openingHours} placeholders. Built from
      // the SAME rows this block already loads (no extra queries).
      let bookingServices = '';
      // Hours prefer the booking availability rule (authoritative for a booking bot)
      // and fall back to the operational businessHours — which until now never
      // reached the prompt at all, leaving non-booking bots blind to opening hours.
      let openingHours = '';
      if (bookingActive) {
        try {
          // Full row: the placeholder formatter needs availabilityMode/weeklyHours,
          // not just the timezone.
          const rule = await AppDataSource.getRepository(AvailabilityRule).findOne({
            where: { botId: bot.id },
          });
          bookingTimezone = rule?.timezone || undefined;
          openingHours = formatHoursForPlaceholder(rule);
          // ponytail: rule existence is treated as "hours set up". A rule with empty
          // weeklyHours would still pass here (ceiling) — fine for the phantom-booking
          // case we target (no rule at all); tighten later if empty-hours configs appear.
          // "Bookable online" = active AND online-bookable; an inactive or
          // phone-only service must not flip this true (it isn't bookable via
          // the chat). isActive matches the catalog's own filter.
          // Full rows: the placeholder formatter needs name/duration/price. These are
          // the genuinely bookable services (active + online-bookable), which is what
          // {services} should advertise.
          const services = await AppDataSource.getRepository(ServiceType).find({
            where: { botId: bot.id, isActive: true, onlineBookable: true },
            order: { sortOrder: 'ASC', createdAt: 'ASC' },
          });
          bookingConfigured = isBookingConfigured(services, !!rule);
          bookingServices = formatServicesForPlaceholder(services);
        } catch (error) {
          // Fail OPEN: on a lookup error don't suppress booking — a transient DB blip
          // must not falsely decline a CONFIGURED tenant. Worst case is the prior
          // behavior (unconfigured tenant may still over-offer), never a regression.
          logger.warn('booking config check failed — treating booking as usable', { tenantId: tenant.id, error });
          bookingConfigured = true;
        }
      }
      // No booking availability rule (or no booking skill at all) → fall back to the
      // tenant's operational business hours, which previously only drove the pre-AI
      // off-hours gate and never reached the prompt. Exactly ONE hours source per bot,
      // so the booking rule and businessHours can never contradict each other.
      if (!openingHours) openingHours = formatBusinessHoursForPlaceholder(effBotSettings.businessHours);
      // Where the business travels, for {serviceArea}. Loaded for EVERY bot, not just
      // booking ones: like opening hours this is a business fact a template author may
      // want to state, and it is one indexed lookup that returns nothing for the bots
      // (the overwhelming majority) with no area configured. Fails open to ''.
      let serviceArea = '';
      try {
        const bookingSettings = await AppDataSource.getRepository(BookingSettings).findOne({
          where: { botId: bot.id },
        });
        serviceArea = describeServiceArea(
          Array.isArray(bookingSettings?.serviceArea) ? bookingSettings.serviceArea : [],
        );
      } catch (error) {
        logger.warn('service area lookup failed — {serviceArea} left empty', { tenantId: tenant.id, error });
      }
      // Template body (layer 2) + effective tone/guardrails both come from the
      // one resolve above (effBotSettings carries the effective AI slice).
      // SpecialtyCatalog (S2/S4): scope to the bound template's vertical (category),
      // resolve the bot's effective specialties, and pass them to the composer so a
      // requiresSpecialPrompt specialty injects its exception block.
      const vertical = resolvedTemplates[0]?.category ?? null;
      const selectedSpecialtyDefs = effectiveSelectedSpecialties(effBotSettings.ai?.selectedSpecialties, vertical);
      const specialties = resolveSpecialties(selectedSpecialtyDefs);
      const specialtyTerms = specialtyRetrievalTerms(selectedSpecialtyDefs);
      // composableEnabled / boundSkillIds / expectedModuleIds / selectedSkillIds are
      // hoisted above (so the module prompt sections are gated in lockstep with tools).
      // Resolve each selected/active skill's STATE for the trace; Phase 3b (behind
      // SKILL_STATE_ENABLED) then drops a non-ready skill's tools (no phantom bookings).
      const skillStates = resolveSkillStates({
        selected: selectedSkillIds,
        active: activeModuleIds,
        gateKind: (id) => getModule(id)?.gate.kind,
        readiness: (id) => readinessRefinement(id, { bookingConfigured }),
      });
      // (The template tool-gate ran above, before `bookingActive` was read.)
      // Per-template skill prose: the version's OVERRIDE if set, else the skill's
      // code-default (defaultProse). Only for skills that resolved `ready`, so an
      // unconfigured skill contributes no prose. Behind the flag (OFF → unchanged).
      // H6: merge prose overrides across all bound templates (primary wins on conflict —
      // it's applied last), so a secondary template's skill still gets its authored prose.
      const skillProseOverrides = Object.assign({}, ...[...resolvedTemplates].reverse().map((rt) => rt.skillProse ?? {})) as Record<string, string>;
      const skillProse = composableEnabled
        ? selectedSkillIds
            .filter((id) => skillStates[id] === 'ready')
            .map((id) => ({ id, prose: (skillProseOverrides?.[id] ?? getModule(id)?.defaultProse ?? '').trim() }))
            .filter((sp) => sp.prose.length > 0)
        : [];
      // Template variables — apply the bound template's declared DEFAULTS under the
      // bot's own tenant-filled values (bot value wins), so a declared {placeholder}
      // with a default substitutes even before a tenant fills it in.
      // Every DECLARED variable resolves to a value — its default, else empty — so an
      // unfilled one renders as blank rather than leaking a literal {key} to the model.
      const varDefaults: Record<string, string> = {};
      for (const v of resolvedTemplates[0]?.variables ?? []) {
        varDefaults[v.key] = typeof v.default === 'string' ? v.default : '';
      }
      if (aiSettings && Object.keys(varDefaults).length) {
        const av = aiSettings as { templateVariables?: Record<string, string> };
        av.templateVariables = { ...varDefaults, ...(av.templateVariables ?? {}) };
      }
      // Phase 3b (behind SKILL_STATE_ENABLED, default OFF). ON → drop a non-ready
      // skill's tools before the model sees them, so an entitled-but-unconfigured
      // booking bot physically cannot call create_booking (no phantom bookings);
      // the existing tool-driven composer then renders "BOOKING (NOT AVAILABLE)".
      // OFF → unchanged (the prompt drives off bookingConfigured, as before).
      if (process.env.SKILL_STATE_ENABLED === 'true') {
        tools = dropUnreadySkillTools(tools, skillStates, (id) => getModule(id)?.tools.map((t) => t.name) ?? []);
      }
      const proactiveAsk = await this.mayAskForContact(session, tools);
      const kbContext = await this.prefetchKbContext({
        message, session, tenantId: tenant.id, tools, conversationHistory, specialtyTerms,
      });
      const { prompt: systemPrompt, ledger } = this.promptBuilder.build(tenant, effBotSettings, tools, kbContext, moduleSections, customerName, templateBody, bookingTimezone, bookingConfigured, session.channel, specialties, skillProse, { services: bookingServices, openingHours, serviceArea }, { proactiveAsk });
      // Merge the composer's block ledger with agent.service's module knowledge
      // (the composer can't name modules) onto the trace — nests in trace.jsonb,
      // no migration. Persisted on every fire-and-forget save below.
      trace.prompt = buildPromptTrace(ledger, {
        activeModuleIds,
        expectedModuleIds,
        skillStates,
        resolvedTemplateId: resolvedTemplates[0]?.templateId,
        resolvedTemplateVersion: resolvedTemplates[0]?.resolvedVersion,
      });
      // Model/provider are platform-standardised — always the platform default,
      // never per-bot/tenant (see llm/defaults).
      const provider = getProvider(DEFAULT_PROVIDER, apiKey ?? undefined);
      const model = DEFAULT_MODEL;

      const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        ...conversationHistory,
        { role: 'user', content: buildUserContent(message, images) },
      ];

      const toolsCalled: string[] = [];
      // Latest availability offered this run — surfaced as slot chips on the
      // reply, unless a booking mutation later consumes/invalidates the offer.
      let pendingAvailability: PendingAvailability | null = null;
      /** #80: the availability call these slots came from, so a surfaced call can be told from a
       *  discarded one. Null when the row could not be written - a missing link, never a fault. */
      let pendingAvailabilityCallId: string | null = null;
      /**
       * A control a tool asked the CLIENT to offer, carried past the model rather than through it.
       *
       * A run-local, following `pendingAvailability` - which is the only existing way anything
       * reaches the reply without the model's involvement, and it exists because the model must
       * not be the one deciding what appears on screen. The whole address design rests on that
       * rule: only a server-observed event may move the binding, so only the server may put the
       * control that produces one in front of the customer.
       *
       * Last writer wins. Two tools raising an affordance in one run is one screen and one
       * customer, and the later call is the better-informed one.
       */
      let pendingAffordance: Affordance | null = null;
      // Egress guard state: was a booking/request actually recorded this run, and
      // have we already nudged the model once for claiming one that wasn't?
      let bookingRecorded = false;
      // #7: per-run guard — a side-effecting tool must not execute twice with
      // identical args within one agent run (a model re-emitting the same call).
      // Cross-run re-invocation (the coalescer re-arming a turn) is already
      // neutralised by the booking provider's idempotency window + DB constraints
      // for create/request; reschedule/cancel re-runs are self-idempotent (same
      // target = no new effect).
      const sideEffectsInvoked = new Set<string>();
      let correctionAttempted = false;
      let pendingAddressFact: BookingAddressReplyFact | null = null;
      let addressFactConflict = false;
      let addressCorrectionAttempted = false;
      let addressCorrectionOnly = false;

      for (let i = 0; i < MAX_ITERATIONS; i++) {
        // Budget check
        if (await this.metering.isOverBudget(tenant.id, (aiSettings as any)?.dailyTokenBudget)) {
          trace.finishReason = 'budget_exceeded';
          void this.traceLogger.save(trace); // fire-and-forget: keeps the trace write off the response path
          return {
            type: 'budget_exceeded',
            fallbackMessage: aiSettings?.guardrails?.fallbackMessage || 'I apologize, but I am temporarily unavailable.',
          };
        }

        // Build tool definitions for LLM
        const toolDefs: ToolDefinition[] | undefined = !addressCorrectionOnly && tools.length > 0
          ? tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))
          : undefined;

        // Call LLM
        const startMs = Date.now();
        const timeoutMs = 30000; // 30 seconds
        const response = await Promise.race([
          provider.chat(messages, { model, maxTokens: 1000, temperature: 0.3, jsonMode: false, tools: toolDefs }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('LLM request timeout after 30s')), timeoutMs)),
        ]);
        const latencyMs = Date.now() - startMs;

        // Record metering
        await this.metering.record(tenant.id, response.usage);

        // Build trace entry
        const traceEntry: AgentTrace['iterations'][0] = {
          llmCall: { model, ...response.usage, latencyMs },
          toolCalls: [],
        };

        // No tool calls — final response
        if (response.finishReason === 'stop' || !response.toolCalls?.length || addressCorrectionOnly) {
          trace.iterations.push(traceEntry);
          let finalContent = response.content ?? '';
          if (addressFactConflict) {
            logger.warn('[agent] conflicting authoritative booking addresses in one run; returning safe fallback', {
              sessionId: session.id,
            });
            finalContent = ADDRESS_CONFLICT_FALLBACK;
          } else if (pendingAddressFact && !validAddressReply(finalContent, pendingAddressFact)) {
            if (!addressCorrectionAttempted && i < MAX_ITERATIONS - 1) {
              addressCorrectionAttempted = true;
              addressCorrectionOnly = true;
              logger.warn('[agent] blocked inaccurate booking address reply; requesting correction', {
                sessionId: session.id,
              });
              messages.push({ role: 'assistant', content: finalContent });
              messages.push({ role: 'user', content: addressCorrectionNote(pendingAddressFact) });
              continue;
            }
            logger.warn('[agent] persistent inaccurate booking address reply; returning safe fallback', {
              sessionId: session.id,
            });
            finalContent = addressSafeFallback(pendingAddressFact);
          }
          // Egress guard (issue #35): never let the model tell the customer a
          // booking/request happened unless one was actually recorded this run.
          if (bookingClaimGuardArmed && !bookingRecorded && claimsBookingDone(finalContent)) {
            if (!correctionAttempted && i < MAX_ITERATIONS - 1) {
              correctionAttempted = true;
              logger.warn('[agent] blocked unrecorded booking claim; nudging model to act', { sessionId: session.id });
              messages.push({ role: 'assistant', content: finalContent });
              messages.push({ role: 'user', content: BOOKING_CORRECTION_NOTE });
              continue; // re-run: model should call the tool or ask for the missing detail
            }
            trace.finishReason = 'completed';
            void this.traceLogger.save(trace);
            logger.warn('[agent] persistent unrecorded booking claim; returning safe fallback', { sessionId: session.id });
            // The affordance rides even the safe fallback. This branch fires when the model kept
            // claiming a booking nobody recorded, so the content is thrown away - but whether the
            // customer's address needs verifying is a fact about the conversation, not about the
            // sentence, and it is still true. Dropping it in the early return is the exact shape
            // #82 records two files over: attached only at the last exit, shipped from none of
            // the others.
            return { type: 'response', content: BOOKING_SAFE_FALLBACK, ...(pendingAffordance ? { affordance: pendingAffordance } : {}) };
          }
          trace.finishReason = 'completed';
          void this.traceLogger.save(trace); // fire-and-forget: keeps the trace write off the response path
          const slotChips = buildSlotQuickReplies(pendingAvailability);

          // A reply that NAMES a time nobody can book is the availability twin of a false
          // confirmation, and it reaches the customer as plain prose above perfectly correct
          // chips. Compared against what the chips actually carry, not the whole slot list -
          // a time truncated away by the channel is one the customer cannot take either.
          let safeContent = finalContent;
          if (slotChips?.length && pendingAvailability) {
            // The chips are the first N slots, in order, so the prefix IS the delivered set. Read
            // with the SAME expression `buildSlotQuickReplies` uses, so what is compared against is
            // by construction what the customer can tap.
            const offeredTimes = pendingAvailability.slots
              .slice(0, slotChips.length)
              .map((slot) => DateTime.fromISO(slot.start).setZone(pendingAvailability!.timezone));
            // FAIL SAFE on anything unreadable. A slot that will not parse is not evidence the
            // reply is wrong, and every time would then look unoffered — throwing away a good
            // answer, which is worse than letting a bad one through.
            const offeredLocal = offeredTimes.every((t) => t.isValid)
              ? offeredTimes.map((t) => t.toFormat('HH:mm'))
              : null;
            const bogus = offeredLocal ? unofferedTimesIn(finalContent, offeredLocal) : [];
            if (bogus.length) {
              logger.warn('[agent] reply named times that were never offered; replacing it', {
                sessionId: session.id,
                named: bogus.slice(0, 6),
                offered: offeredLocal,
              });
              safeContent = AVAILABILITY_SAFE_FALLBACK;
            }
          }

          return {
            type: 'response',
            content: safeContent,
            quickReplies: slotChips,
            ...(pendingAffordance ? { affordance: pendingAffordance } : {}),
            // #80 (LP3): rides along so the DISPATCH boundary can record what was actually
            // delivered. It cannot be measured here - channels truncate quick replies and drop
            // them where unsupported - and dispatch knows none of this context on its own.
            ...(slotChips?.length && pendingAvailability
              ? {
                  offer: {
                    botId: bot.id,
                    serviceId: pendingAvailability.serviceId ?? null,
                    availabilityCallId: pendingAvailabilityCallId,
                    locationMode: pendingAvailability.locationMode ?? null,
                    slotStarts: pendingAvailability.slots.slice(0, slotChips.length).map((s) => s.start),
                    // #81 (LP4): the whole scoring, not the delivered prefix of it. What was
                    // truncated is decided at dispatch, and the counterfactual order is a
                    // statement about the list the scorer saw.
                    ...(pendingAvailability.grouping ? { scoring: pendingAvailability.grouping } : {}),
                    ...(pendingAvailability.groupingPilot ? { groupingPilot: true } : {}),
                    ...(pendingAvailability.grouped ? { grouped: pendingAvailability.grouped } : {}),
                    ...(pendingAvailability.groupingPreviousOrder
                      ? { groupingPreviousOrder: pendingAvailability.groupingPreviousOrder }
                      : {}),
                  },
                }
              : {}),
          };
        }

        // Process tool calls
        // Append assistant message WITH toolCalls BEFORE processing tool results
        messages.push({ role: 'assistant', content: response.content || '', toolCalls: response.toolCalls });

        for (const toolCall of response.toolCalls) {
          const tool = tools.find((t) => t.name === toolCall.name);
          const toolStartMs = Date.now();

          if (!tool) {
            messages.push({ role: 'tool', content: JSON.stringify({ error: `Unknown tool: ${toolCall.name}` }), toolCallId: toolCall.id });
            continue;
          }

          // Precondition check
          if (tool.preconditions?.toolsCalled) {
            const missing = tool.preconditions.toolsCalled.filter((t) => !toolsCalled.includes(t));
            if (missing.length > 0) {
              const errorMsg = `Must call ${missing.join(', ')} before ${tool.name}`;
              messages.push({ role: 'tool', content: JSON.stringify({ error: errorMsg }), toolCallId: toolCall.id });
              traceEntry.toolCalls.push({ name: tool.name, args: toolCall.arguments, result: { success: false, error: errorMsg }, latencyMs: 0 });
              continue;
            }
          }

          // #7: dedupe side-effecting tools within this run — an identical (tool,
          // args) call a second time, AFTER it already succeeded, does NOT re-execute;
          // the model is told it was already performed. Marked only on success (below)
          // so a failed first attempt can still be retried. (Cross-run dedupe is the
          // provider's idempotency job.)
          const sideEffectSig = tool.hasSideEffects
            ? `${tool.name}:${JSON.stringify(toolCall.arguments)}`
            : null;
          if (sideEffectSig && sideEffectsInvoked.has(sideEffectSig)) {
            messages.push({ role: 'tool', content: JSON.stringify({ note: 'already_performed', tool: tool.name }), toolCallId: toolCall.id });
            traceEntry.toolCalls.push({ name: tool.name, args: toolCall.arguments, result: { success: true }, latencyMs: 0 });
            continue;
          }

          // Execute tool
          const ctx: ToolContext = {
            tenantId: tenant.id,
            sessionId: session.id,
            runId,
            channel: session.channel ?? 'widget',
            toolsCalledThisTurn: toolsCalled,
            dataSource: AppDataSource,
            conversationHistory: messages,
            specialtyTerms: specialtyTerms.length ? specialtyTerms : undefined,
          };

          try {
            const result = await tool.execute(toolCall.arguments, ctx);
            toolsCalled.push(tool.name);
            // #7: only now (post-success) is the side-effect "performed" — a failed
            // attempt stays retryable.
            if (sideEffectSig && result.success) sideEffectsInvoked.add(sideEffectSig);
            if (result.success && result.replyFact?.kind === 'booking_address') {
              const merged = mergeAddressFacts(pendingAddressFact, result.replyFact);
              pendingAddressFact = merged.fact;
              addressFactConflict ||= merged.conflict;
            }
            // Harvested for EVERY tool, not just the one that raises it today. The alternative -
            // reading it inside the `check_availability` branch below - would make the next tool
            // that wants an affordance work perfectly and ship nothing, which is the failure this
            // whole area keeps producing.
            if (result.affordance) pendingAffordance = result.affordance;
            // Track offered slots for the chip UI; a booking mutation clears them.
            if (tool.name === 'check_availability' && result.success && result.data) {
              const d = result.data as {
                slots?: Array<{ start: string; end: string }>;
                timezone?: string;
                serviceName?: string;
                serviceId?: string;
                locationMode?: string;
                travel?: {
                  groupingPilot?: boolean;
                  grouped?: { savedMinutes: number };
                  groupingPreviousOrder?: string[];
                };
              };
              if (Array.isArray(d.slots)) {
                pendingAvailability = {
                  slots: d.slots,
                  timezone: d.timezone ?? 'UTC',
                  serviceName: d.serviceName,
                  serviceId: d.serviceId,
                  locationMode: d.locationMode,
                  // #81 (LP4): off `measurement`, never off `data` - `data` is what the model is
                  // shown, and this is deliberately invisible to it.
                  grouping: (result.measurement as { grouping?: OfferScoring } | undefined)?.grouping,
                  groupingPilot: (d.travel as { groupingPilot?: boolean } | undefined)?.groupingPilot === true,
                  grouped: (d.travel as { grouped?: { savedMinutes: number } } | undefined)?.grouped,
                  groupingPreviousOrder: (d.travel as { groupingPreviousOrder?: string[] } | undefined)
                    ?.groupingPreviousOrder,
                };
                // #80 (LP3): every call is recorded, surfaced or not. This is the CALL-level unit,
                // and it exists separately from the offer because a call the model never surfaces
                // still counts in "how often do customers ask across several days" - the number
                // #84's gate turns on. Fire-and-forget: a measurement row is never worth a turn.
                const callArgs = toolCall.arguments as { startDate?: string; endDate?: string; serviceId?: string };
                void import('../booking/offer-record.service')
                  .then((m) =>
                    m.recordAvailabilityCall({
                      tenantId: session.tenantId,
                      botId: bot.id,
                      sessionId: session.id,
                      // The RESOLVED service, not the one the caller named: `check_availability`
                      // picks the sole bookable service when the argument is omitted, and the
                      // record should say which service was actually offered.
                      serviceId: d.serviceId ?? callArgs?.serviceId ?? null,
                      startDate: callArgs?.startDate,
                      endDate: callArgs?.endDate,
                      slotCount: d.slots?.length ?? 0,
                    })
                  )
                  .then((id) => {
                    pendingAvailabilityCallId = id;
                  })
                  .catch(() => undefined);
              }
            } else if (BOOKING_MUTATION_TOOLS.includes(tool.name) && result.success) {
              pendingAvailability = null;
              // The booking consumed the address binding in its own transaction, so an offer to
              // verify one now points at a conversation state that no longer exists. Cleared with
              // the slots, for the same reason the slots are cleared: the offer was about a
              // decision the customer has already made.
              pendingAffordance = null;
              bookingRecorded = true;
            }
            // R31: a tool that fails may return a raw infra error (err.message)
            // as result.error; never forward an UNMARKED error to the model — it
            // could be echoed to the customer. Only errors a tool explicitly
            // marks errorSafeForModel (authored domain errors) pass through; the
            // rest become a generic message. The full result stays in the trace.
            let modelPayload: unknown;
            if (result.success) {
              modelPayload = result.data ?? {};
            } else if (result.errorSafeForModel) {
              modelPayload = { error: result.error };
            } else {
              logger.warn('Agent tool error sanitized for model', {
                sessionId: session.id, tool: tool.name, error: result.error,
              });
              modelPayload = { error: `The ${tool.name} tool couldn't complete that request right now.` };
            }
            let resultJson = JSON.stringify(modelPayload);
            if (resultJson.length > 4000) {
              resultJson = resultJson.substring(0, 4000) + '...[truncated]';
            }
            messages.push({
              role: 'tool',
              content: resultJson,
              toolCallId: toolCall.id,
            });
            const { replyFact: _replyFact, ...traceResult } = result;
            traceEntry.toolCalls.push({
              name: tool.name,
              args: toolCall.arguments,
              result: traceResult,
              latencyMs: Date.now() - toolStartMs,
            });
          } catch (error) {
            // R31: an UNEXPECTED tool exception (SQL error, stack, connection
            // string, internal id) must never reach the model context — the model
            // can echo it to the customer. Log the real error server-side + keep
            // it in the trace, but hand the model a sanitized, generic message.
            // (A tool that RETURNS an error is sanitized at the boundary above
            // unless it set errorSafeForModel; this catch covers tools that THROW.)
            const rawMsg = error instanceof Error ? error.message : 'Tool execution failed';
            logger.error('Agent tool threw', { sessionId: session.id, tool: tool.name, error });
            const safeMsg = `The ${tool.name} tool is temporarily unavailable. Do not retry it this turn.`;
            messages.push({ role: 'tool', content: JSON.stringify({ error: safeMsg }), toolCallId: toolCall.id });
            traceEntry.toolCalls.push({
              name: tool.name,
              args: toolCall.arguments,
              result: { success: false, error: rawMsg },
              latencyMs: Date.now() - toolStartMs,
            });
          }
        }

        trace.iterations.push(traceEntry);
      }

      // Max iterations reached
      trace.finishReason = 'max_iterations';
      void this.traceLogger.save(trace); // fire-and-forget: keeps the trace write off the response path
      return { type: 'max_iterations', fallbackMessage: "Let me connect you with a human agent." };

    } catch (error) {
      trace.finishReason = 'error';
      void this.traceLogger.save(trace); // fire-and-forget: keeps the trace write off the response path
      logger.error('Agent loop error', { sessionId: session.id, error });
      const infraFailure = isUpstreamQuotaExhausted(error) || isUpstreamRateLimit(error);
      if (infraFailure) {
        // Log distinctly: an out-of-credit platform key is an operational
        // emergency across every tenant, not one conversation going wrong.
        logger.error('[agent] upstream provider failure — NOT a bot fault', {
          sessionId: session.id,
          quotaExhausted: isUpstreamQuotaExhausted(error),
        });
      }
      return {
        type: 'error',
        error: error instanceof Error ? error.message : 'Unknown error',
        fallbackMessage: aiSettings?.guardrails?.fallbackMessage || 'Something went wrong. Let me connect you with a human agent.',
        infraFailure,
      };
    }
  }

  /**
   * Seed the OPENING turn with knowledge-base context instead of hoping the model
   * calls `kb_search`.
   *
   * The composer has always accepted a `kbContext` block, but the agent path passed
   * `undefined`, so retrieval depended entirely on the model volunteering the tool.
   * It doesn't reliably: the KNOWLEDGE block already says "you MUST call kb_search
   * BEFORE answering" and the tool description says "Call this FIRST", and a live
   * turn still answered "Valyro biedt diensten aan op het gebied van [specifieke
   * diensten niet vermeld]" — one LLM call, zero tool calls — with the business's
   * own website indexed and attached. Prompt wording is out of road; make the first
   * turn deterministic instead.
   *
   * FIRST TURN ONLY, which is what keeps this cheap and is not arbitrary:
   *   - it's the turn that decides whether the bot can say what the business does,
   *     and the one with no prior context for the model to lean on;
   *   - `searchKnowledge` → `rewriteQuery` short-circuits on empty history, so this
   *     costs ONE embedding + one vector search and no extra LLM call;
   *   - later turns still have `kb_search`, now with a worked example in context.
   *
   * Gated on the tool actually being present, so a bot whose plan or skill selection
   * withheld kb_search cannot be handed KB content through the back door.
   *
   * FAILS OPEN: retrieval problems must never cost the customer a reply — the turn
   * proceeds with no pre-fetched context and the model can still call the tool.
   */
  private async prefetchKbContext(args: {
    message: string;
    session: ChatSession;
    tenantId: string;
    tools: ToolAdapter[];
    conversationHistory: ChatMessage[];
    specialtyTerms: string[];
  }): Promise<string | undefined> {
    const { message, session, tenantId, tools, conversationHistory, specialtyTerms } = args;
    if (!tools.some((t) => t.name === 'kb_search')) return undefined;
    if (conversationHistory.length > 0) return undefined;
    if (!message.trim()) return undefined;

    try {
      // Same scoping the tool uses: the session bot's attached KBs. A null botId
      // (legacy/unattributed session) means tenant-wide, matching kb-search.tool.
      const botKbIds = session.botId
        ? await getBotKnowledgeBaseIds(AppDataSource, session.botId)
        : undefined;
      const { chunks } = await searchKnowledge(
        AppDataSource,
        tenantId,
        message,
        [], // first turn by construction — also what keeps rewriteQuery LLM-free
        undefined,
        botKbIds,
        specialtyTerms.length ? specialtyTerms : undefined,
      );
      if (!chunks.length) return undefined;
      return chunks.map((c) => `### ${c.title}\n${c.content}`).join('\n\n');
    } catch (err) {
      logger.warn('[agent] KB pre-fetch failed; falling back to the kb_search tool', {
        sessionId: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  /**
   * May this turn carry ONE polite request for a contact route we don't have?
   * (Story 3, Pro — "proactive lead capture".)
   *
   * FAILS CLOSED: any error means the bot stays passive. Soliciting personal data from
   * an EU consumer because an entitlement lookup threw is not a failure mode worth
   * having, and the passive behaviour is what every tier had before this existed.
   *
   * Marks the session as ASKED at decision time rather than after observing the model
   * ask. We cannot reliably tell whether it complied, and the two errors are not
   * symmetric: marking early can cost us one missed opportunity, marking late can ask
   * the same person twice. `shouldAskForContact` therefore returns true at most once
   * per conversation, which makes "never pushy" structural rather than a prompt rule.
   */
  private async mayAskForContact(session: ChatSession, tools: ToolAdapter[]): Promise<boolean> {
    // No capture tool ⇒ nowhere to put an answer, so asking would be pure friction.
    if (!tools.some((t) => t.name === 'capture_lead')) return false;
    try {
      const { features } = await getEntitlements(session.tenantId);
      const state = readAskState(session);

      // Any identified lead on this conversation means we already have a way to reach
      // them. Mirrors the old chip gate's query so the two never disagreed about
      // "do we have contact"; the tombstone guard keeps an erased lead from counting.
      const rows: Array<{ n: number }> = await AppDataSource.query(
        `SELECT count(*)::int AS n
           FROM chatbot_leads
          WHERE tenant_id = $1 AND session_id = $2 AND deleted_at IS NULL
            AND (email IS NOT NULL OR phone IS NOT NULL)`,
        [session.tenantId, session.id],
      );

      const ask = shouldAskForContact({
        enabled: features.proactiveLeadCapture === true,
        isChannel: !!session.channel && session.channel !== 'widget',
        hasContact: (rows[0]?.n ?? 0) > 0,
        customerTurns: session.messageCount ?? 0,
        state,
      });
      if (!ask) return false;

      // Persist BEFORE the model sees the instruction, so a crash mid-turn cannot
      // leave the conversation eligible to be asked again.
      //
      // Written as an atomic jsonb MERGE rather than a read-modify-write of the whole
      // blob: the turn coalescer writes its watermark to this same column, and a
      // last-writer-wins update from here would silently drop it.
      const askedAt = new Date().toISOString();
      await AppDataSource.query(
        `UPDATE chat_sessions SET metadata = coalesce(metadata, '{}'::jsonb) || $2::jsonb WHERE id = $1`,
        [session.id, JSON.stringify({ [ASK_STATE_KEY]: { askedAt } })],
      );
      // Keep the in-memory session consistent for the rest of this turn.
      session.metadata = withAskState(
        session.metadata as Record<string, unknown> | null,
        { askedAt },
      ) as ChatSession['metadata'];
      return true;
    } catch (error) {
      logger.warn('[proactive-ask] decision failed — staying passive', { sessionId: session.id, error });
      return false;
    }
  }
}
