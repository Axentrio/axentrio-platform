import crypto from 'crypto';
import type { OfferScoring } from '../booking/travel/score-offer';
import { DateTime } from 'luxon';
import { collapseAppointmentSpans, latestCustomerTimeText, localClockTimes, namesSingleOfferedTime, parseClockTimes, unofferedSingleTimeIn, unofferedTimesIn } from './clock-times';
import type { OfferMeasurement } from '../channels/response.types';
import { ToolRegistry } from './tool-registry';
import { PromptBuilder } from './prompt-builder';
import { MeteringService } from './metering.service';
import { TraceLogger, AgentTrace, terminalErrorFrom, type TerminalErrorKind } from './trace-logger';
import { ToolContext } from './tool-adapter';
import { getProvider } from '../llm/provider-factory';
import { buildPromptTrace } from '../llm/block-ledger';
import { localizeMessage } from '../llm/localize';
import { effectiveSelectedSpecialties, resolveSpecialties, specialtyRetrievalTerms } from '../llm/specialty-catalog';
import { DEFAULT_MODEL } from '../llm/defaults';
import { ChatMessage, ContentPart, ToolDefinition, contentToText, type LLMProvider, type LLMOptions, type LLMResponse, type ToolCall } from '../llm/llm.types';
import { ChatSession } from '../database/entities/ChatSession';
import type { Bot, BotSettings } from '../database/entities/Bot';
import { getEntitlements } from '../billing/entitlements';
import type { FeatureKey } from '../billing/types';
import { shouldAskForContact } from '../leads/proactive/should-ask';
import type { ToolAdapter, Affordance, BookingAddressReplyFact, ToolResult } from './tool-adapter';
import { readAskState, withAskState, ASK_STATE_KEY } from '../leads/proactive/ask-state';
import { ConversationBinding } from '../database/entities/ConversationBinding';
import { AvailabilityRule } from '../database/entities/AvailabilityRule';
import { BookingSettings } from '../database/entities/BookingSettings';
import { describeServiceArea } from '../contracts/service-area';
import { formatVenueLine } from '../contracts/venue-address';
import { resolveQuotedAddress } from '../account/quoted-address';
import { ServiceType } from '../database/entities/ServiceType';
import { Tenant } from '../database/entities/Tenant';
import { AppDataSource } from '../database/data-source';
import { listActiveModules } from '../modules';
import { getModule, gatedToolNames, skillPromptAllowed, featureGatedSkillIds } from '../modules/module-catalog';
import { resolveSkillStates, dropUnreadySkillTools } from '../modules/skill-state';
import { readinessRefinement } from '../llm/skill-readiness';
import { logger } from '../utils/logger';
import { getLlmRuntimeConfigForSession } from '../services/bot-config.service';
import { resolveBoundTemplates, composeTemplateBodies, effectiveConfigFromList, withEffectiveConfig, templateUnavailabilityReason, effectiveSkillIds, type ResolvedTemplate } from '../templates/template-resolver';
import { isBookingConfigured } from '../scheduler/booking-readiness';
import { buildBoundAddressSection, formatServicesForPlaceholder, formatHoursForPlaceholder } from '../modules/booking.module';
import { getBoundAddress } from '../booking/travel/address-binding';
import { formatBusinessHoursForPlaceholder, isBusinessHoursConfigured, isOutsideBusinessHours } from '../utils/format-business-hours';
import { isUpstreamQuotaExhausted, isUpstreamRateLimit, isUpstreamServerError, isUpstreamUnreachable, isRetryableUpstream, UpstreamUnreachableError } from '../llm/upstream-error';
import { searchKnowledge } from '../llm/rag.service';
import { getBotKnowledgeBaseIds } from '../knowledge/bot-knowledge-bases';
import {
  claimsBookingDone,
  claimsDatedUnavailability,
  containsCurrencyAmount,
  type OutputValidationContext,
} from '../guardrails/output-validation';
import { renderMemoryForPrompt } from '../memory/memory-store';

/** A tappable suggestion rendered by the widget (e.g. an appointment slot). */
export interface QuickReply {
  title: string;
  value: string;
}

export type AgentResult =
  | {
      type: 'response';
      content: string;
      /**
       * The customer explicitly asked for a human and `escalate_to_human` executed
       * successfully this run. TERMINAL on every variant: a tool success followed by
       * a LATER provider failure must not lose the request, so even an `error` exit
       * carries it. The forwarding result mappings consume it to fire exactly ONE
       * real handoff (`escalation_trigger`) after reply finalization — with
       * precedence over the per-result `bot_error` / infraFailure rules.
       */
      handoffRequested?: boolean;
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
      validationContext?: OutputValidationContext;
    }
  | { type: 'awaiting_confirmation'; toolCallId: string; toolName: string; preview: Record<string, unknown>; message: string; handoffRequested?: boolean; validationContext?: OutputValidationContext }
  | { type: 'max_iterations'; fallbackMessage: string; handoffRequested?: boolean }
  | { type: 'budget_exceeded'; fallbackMessage: string; handoffRequested?: boolean }
  | {
      type: 'error';
      error: string;
      fallbackMessage: string;
      /** See the `response` variant — a successful escalation survives the error exit. */
      handoffRequested?: boolean;
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

/** Broader than the hard output gate: future intent is useful for correcting the
 * model inside the Agent loop, but is not proof enough to replace a reply. */
function claimsBookingForAgentNudge(text: string): boolean {
  const t = text.toLowerCase();
  return claimsBookingDone(t) || [
    /\bi'?ve (successfully )?(booked|scheduled|requested|submitted|placed|created)\b/,
    /\bi'?ll (go ahead and (book|request|submit|schedule)|proceed( with (the|your|this))?)\b/,
    /\bsuccessfully (requested|booked|scheduled|submitted|created)\b/,
    /\byour (booking|request) (has been|is) (submitted|created|placed|received|sent|booked)\b/,
    /\bik heb (je|uw|het|de|een)?\s?(afspraak|reservering|boeking)?\s?(ge(boekt|reserveerd|pland)|ingepland|aangevraagd|vastgelegd)\b/,
    /\b(je|uw|de) (afspraak|reservering|boeking) (is|staat) (ge(boekt|reserveerd|pland)|ingepland|bevestigd|vastgelegd|aangevraagd)\b/,
  ].some((re) => re.test(t));
}

/** Diary words, in the three languages this platform serves. Deliberately NOT generic "time": a
 *  support bot asked about a delivery time is not asking about the diary. */
const AVAILABILITY_SUBJECT =
  /\b(?:beschikbaar|beschikbaarheid|vrij|agenda|tijdstip|tijden|slot|slots|afspraak|available|availability|calendar|diary|opening hours|booking|appointment|disponib\w*|cr[eé]neau\w*|horaire\w*|rendez-vous)\b/;

/**
 * Another domain's nouns. A reply about one of these is not about the diary, whatever clock the
 * customer happened to mention - "I called at 10:00 about my invoice" must not make "let me check
 * your invoice" a diary promise.
 *
 * ADDRESS IS DELIBERATELY ABSENT. A travelling service asks for the customer's address as part of
 * booking, so "let me check the times for your address" is a diary promise, and excluding the word
 * would silence this guard on exactly the services that need it most.
 */
const OTHER_DOMAIN_SUBJECT =
  /\b(?:invoice|factuur|facturen|bill|order|orders|bestelling|commande|delivery|levering|livraison|payment|betaling|paiement|quote|offerte|devis|refund|terugbetaling)\b/;

/**
 * A reply that PROMISES to look at the DIARY, on a turn that never looked.
 *
 * Observed on production 2026-08-26, session 4d3f6473, 18:04:18Z: asked "Kan het om 09:15 op
 * woensdag 2 september 2026?", the bot's final reply was "Ik controleer even of woensdag 2
 * september 2026 om 09:15 uur beschikbaar is voor 30 minuten 🔧" - and the turn made ZERO tool
 * calls. Nothing schedules a continuation, so that promise is the last thing the customer ever
 * receives: they wait for an answer that no code path will ever produce.
 *
 * The two guards below it judge a CLAIM the model had no right to make. This one judges the
 * opposite failure: no claim, no answer, and no work either.
 *
 * WHAT IT IS NOT ABOUT. Being armed means the bot HAS booking tools, not that this turn is about
 * booking - a plumber's bot answers invoices and orders too. So a promise only counts when it is
 * about the diary, and never when the reply is plainly about another domain: an invoice reply
 * cannot become an instruction to go and read a calendar, whatever clock time the customer's own
 * message contained.
 *
 * "CONFIRM" IS NOT A LOOK. A reply promising to confirm a BOOKING belongs to the guard above, and
 * nudging it toward `check_availability` would point it at the wrong tool.
 */
function promisesAvailabilityCheck(text: string, customerText: string): boolean {
  const t = text.toLowerCase();
  const promises = [
    // NL: "ik controleer even", "ik ga even kijken", "ik check het even", "ik kijk snel".
    /\bik (?:ga )?(?:het |dat |even |snel |meteen )*(?:controleer|controleren|kijk|kijken|check|checken|zoek|zoeken)\b/,
    // EN: "let me check", "I'll just look", "I'm going to verify", "one moment while I check".
    /\b(?:let me|i'?ll|i will|i'?m going to|while i)\s+(?:just\s+|quickly\s+)?(?:check|look|see|verify)\b/,
    // FR: "je vérifie", "je vais regarder".
    /\bje (?:vais )?(?:v[eé]rifie|v[eé]rifier|regarde|regarder|consulte|consulter)\b/,
  ].some((re) => re.test(t));
  if (!promises) return false;
  if (OTHER_DOMAIN_SUBJECT.test(t)) return false;
  return (
    AVAILABILITY_SUBJECT.test(t) ||
    parseClockTimes(text).length > 0 ||
    parseClockTimes(customerText).length > 0
  );
}

interface PendingAvailability {
  slots: Array<{ start: string; end: string }>;
  /**
   * Travel times offered as a REQUEST, never as a chip (`buildSlotQuickReplies` reads `slots`
   * only, because a tap leads to create_booking and these cannot be auto-confirmed).
   *
   * Carried because the reply guards judge what the customer may take, and a requestable time is
   * one the tool told the model to offer in prose.
   */
  requestableSlots: Array<{ start: string; end: string }>;
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
 * when tapped — a natural-language, absolute date+time the LLM can re-book
 * from. Slot identity rides on the offer's ISO `slotStarts`, not this text.
 * (Telegram's 64-byte callback_data limit doesn't constrain this: quick
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
      value: `Book ${forService}${dt.toFormat('cccc d LLLL')} at ${dt.toFormat('h:mm a')}`,
    };
  });
}

/**
 * Times the reply NAMES that were never offered.
 *
 * Re-exported so existing tests keep importing from this module.
 */
export { unofferedTimesIn, namesSingleOfferedTime } from './clock-times';

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

/**
 * A reply that names ONE time nobody offered.
 *
 * TRUE IN BOTH READINGS, which is why one sentence can replace either. A model that invented an
 * opening ("the next valid time is 08:30") and a model refusing the hour the customer asked for
 * are both talking about a time this business cannot book, and the chips underneath carry the
 * times it can.
 */
const UNBOOKABLE_TIME_FALLBACK =
  'That time is not available. Here are the times I have — let me know which one suits you.';

/**
 * The same replacement, for a turn with NOTHING on screen to point at.
 *
 * Two turns reach the guards without chips: an all-requestable travel result (every time needs
 * the owner's say-so, so no time is tappable) and a turn where the customer already chose an
 * offered time. Both fallbacks above promise a list the customer cannot see, so neither can be
 * used - and the guard used to be switched off for exactly that reason, which left the one case
 * with no correction on screen as the one case nothing checked.
 */
const NO_SLOTS_ON_SCREEN_FALLBACK =
  'I cannot confirm that time. Tell me which time suits you and I will check it for you.';

/**
 * A replacement said in the customer's language, but NEVER at the cost of the reply.
 *
 * `localizeMessage` is two sequential LLM calls, and its own header rules it out of "the hot reply
 * path" for good reason: it fails open on an error and NOT on a hang, while `agent.service`'s own
 * provider calls go through `callProviderWithRetry` and this one would not. A customer is waiting
 * here, and a silent turn on a session that still shows the bot as active is a far worse outcome
 * than an English sentence.
 *
 * So it races a deadline. Past it the authored English ships - which is exactly what shipped
 * before localization existed, so the worst case is the old behaviour and never a dead end.
 */
/**
 * MEASURED, not guessed. Production, 2026-08-27 01:16Z: the detection call took 1077ms and the
 * translation 1438ms, so localization finished in 2515ms and lost a 2500ms race by fifteen
 * milliseconds - the customer got the English sentence in a Dutch conversation, which is the
 * defect this whole path exists to fix. The two calls are sequential inside `localizeMessage`.
 *
 * Six seconds is that measurement with room either side. It only ever applies on a turn whose
 * reply is being REPLACED, which is rare, and the fallback is a correct English sentence rather
 * than silence - so the cost of the ceiling being generous is small and the cost of it being
 * tight is a wrong-language reply every time the provider is having an average day.
 */
const LOCALIZE_DEADLINE_MS = 6000;

async function inCustomerLanguage(
  text: string,
  customerText: string,
  session: ChatSession,
): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      localizeMessage(text, customerText, session),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve(text), LOCALIZE_DEADLINE_MS);
      }),
    ]);
  } catch {
    return text; // localizeMessage is fail-open, but never let this path throw a reply away.
  } finally {
    clearTimeout(timer);
  }
}

/** Internal nudge (user role — the Anthropic adapter only honours the FIRST system
 *  message) telling the model to actually call the booking tool instead of claiming
 *  a booking it never made. */
const BOOKING_CORRECTION_NOTE =
  "(Internal note, not from the customer.) You just implied to the customer that their booking or request was made, but no booking was recorded this turn. If you HAVE a booking tool and already have the service, the customer's name, and a time, call the correct booking tool now (and only claim it's done once the tool succeeds). If a required detail is missing, ask for it. If you do NOT have a booking tool available, do NOT claim, confirm, or imply any booking — instead offer to take the customer's details so the team can follow up, in the customer's language.";

/** Nudge for a reply that declared a named date shut or full without ever looking. */
const AVAILABILITY_CORRECTION_NOTE =
  "(Internal note, not from the customer.) You just told the customer a specific date is closed, " +
  "fully booked, or otherwise not possible, but you did not call check_availability this turn, so " +
  "you cannot know that. Opening hours in your instructions do NOT settle a particular date: a " +
  "date override can close a normally open day or open a normally closed one, and bookings and " +
  "daily limits are invisible to you until you look. Call check_availability for that exact date " +
  "now. If it returns times, offer them. If it returns none, follow the guidance the tool gives " +
  "you. Do not offer to submit the appointment as a request, and do not repeat the claim.";

/** Nudge for a reply that promised to look at the diary and then ended the turn. */
const PROMISED_CHECK_NOTE =
  "(Internal note, not from the customer.) You just told the customer you were going to check " +
  "the diary, but you did not call check_availability this turn and nothing will run after this " +
  "reply - so your promise is the last message they get and they are left waiting. Never say you " +
  "are checking: either call check_availability NOW for the date they named and answer with what " +
  "it returns, or, if you are missing something you need for the call, ask them for that one " +
  "detail instead. Do not repeat the promise.";

/**
 * Safe reply when the model promises to check a second time.
 *
 * THE RULE IS NOT "PROMISE NOTHING", it is never describe work no code path will do. The failure
 * being replaced is a promise with NO trigger - "I am checking now", and then the turn ends, so
 * nothing runs unless the customer prods the bot again. A sentence whose trigger IS the customer's
 * next message is the opposite: they answer, the turn runs, the tool is called. Trimming the
 * outcome to a bare question read as a dead end of its own and dropped the one thing the tool's
 * guidance insists on - that the customer is never turned away empty-handed.
 */
const PROMISED_CHECK_FALLBACK =
  'Which day and time would you like? Tell me and I will come back with the times.';

/**
 * Safe reply when the diary COULD NOT BE READ and the model promised to read it.
 *
 * Used only when the call threw - a paused business, a missing calendar, a request-only service.
 * It names the state honestly, asks, and says what happens to the answer: the next turn captures
 * it as a request, which is exactly what `check_availability`'s error guidance asks for. That is a
 * conditioned outcome, not the un-triggered promise this guard exists to remove.
 */
const CHECK_FAILED_FALLBACK =
  'I cannot see the diary at the moment. Which day and time would suit you? I will pass your preference to the business.';

/**
 * Safe reply when the diary WAS read, had nothing confirmable, and the model promised to look.
 *
 * Says only what is true: nothing can be confirmed for that period. It must never say "closed" or
 * "fully booked" - `check_availability`'s own guidance forbids that reading of an empty result -
 * and, like the sentence above, it asks and then names what the answer is for.
 */
const NO_CONFIRMABLE_TIMES_FALLBACK =
  'I have no times I can confirm for that period. Which day and time would suit you? I will pass your preference to the business.';

/** Safe reply when the model keeps claiming a booking that wasn't recorded (after
 *  one correction, or out of iteration budget) — anything but a false confirmation. */
const BOOKING_SAFE_FALLBACK =
  "Sorry, let me just confirm a couple of details before I put that through — could you confirm the date and time you'd like?";

/**
 * Which kind of failure ended this run.
 *
 * The order matters: an upstream 429 also matches nothing else, but the LLM timeout is raised by
 * this file's own `Promise.race` and must not be read as a bot fault — a provider that went slow
 * is a provider problem. Everything unrecognised is `bot_fault`, which is the honest default:
 * claiming a provider outage we cannot demonstrate would send an operator to the wrong dashboard.
 */
function classifyTerminalError(error: unknown): TerminalErrorKind {
  if (isUpstreamQuotaExhausted(error)) return 'upstream_quota';
  if (isUpstreamRateLimit(error)) return 'upstream_rate_limit';
  if (isUpstreamServerError(error)) return 'upstream_server_error';
  // Only the provider call site raises this typed error, so a DB/Redis transport
  // failure is never misread as an LLM-provider outage.
  if (error instanceof UpstreamUnreachableError) return 'upstream_unreachable';
  if (error instanceof Error && /LLM request timeout/i.test(error.message)) return 'llm_timeout';
  return 'bot_fault';
}

/** The whole provider budget for one iteration, before this file gives up on the call. */
const LLM_TIMEOUT_MS = 30000;
/** A short pause before the single retry, so an instant re-hit does not just fail again. */
const UPSTREAM_RETRY_BACKOFF_MS = 400;

/** One provider call, raced against the per-call timeout. */
function callProviderOnce(provider: LLMProvider, messages: ChatMessage[], opts: LLMOptions): Promise<LLMResponse> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('LLM request timeout after 30s')), LLM_TIMEOUT_MS);
  });
  // Clear the timer once the call settles: a fast success must not leave a dormant
  // 30s timer alive, or they accumulate under load.
  return Promise.race([provider.chat(messages, opts), timeout]).finally(() => clearTimeout(timer));
}

/**
 * A provider call with ONE retry on a transient upstream failure (a 429 rate
 * limit, a 5xx, or an unreachable provider). This wraps EVERY provider call in
 * the run, not only the first: a transient blip on any iteration throws out of
 * the loop and loses the whole turn, and the customer gets the handoff fallback.
 * That is exactly the 2026-08-13 booking incident - a booking dropped by a
 * momentary provider failure with no second chance.
 *
 * We do NOT retry the locally enforced 30s timeout (a second wait doubles an
 * already bad latency), a quota-exhausted key (it will not clear), or a 4xx/bot
 * fault (deterministic). On a final transport failure the error is wrapped so
 * the trace names it `upstream_unreachable` rather than the default `bot_fault`.
 */
async function callProviderWithRetry(
  provider: LLMProvider,
  messages: ChatMessage[],
  opts: LLMOptions,
  sessionId: string,
): Promise<LLMResponse> {
  try {
    return await callProviderOnce(provider, messages, opts);
  } catch (error) {
    if (!isRetryableUpstream(error)) throw error;
    logger.warn('[agent] transient upstream error on provider call; retrying once', { sessionId });
    await new Promise((resolve) => setTimeout(resolve, UPSTREAM_RETRY_BACKOFF_MS));
    try {
      return await callProviderOnce(provider, messages, opts);
    } catch (retryError) {
      throw isUpstreamUnreachable(retryError) ? new UpstreamUnreachableError(retryError) : retryError;
    }
  }
}

/**
 * The account address {venueLine} falls back to when the bot has no quoted address
 * and no booking venue is set.
 */
function accountAddressOf(tenant: Tenant) {
  const company = tenant.settings?.onboarding?.company;
  return (
    tenant.invoiceAddress ?? {
      street: company?.street,
      postalCode: company?.postalCode,
      city: company?.city,
      country: 'BE',
    }
  );
}

/** The line for {venueLine}: the bot's quoted address, else the booking venue. */
function resolveVenueLine(
  tenant: Tenant,
  effBotSettings: BotSettings,
  bookingSettings: BookingSettings | null,
): string | undefined {
  return (
    resolveQuotedAddress({
      botAddressEnabled: true,
      botAddress: effBotSettings.quotedAddress ?? null,
      accountAddress: accountAddressOf(tenant),
    }) ??
    formatVenueLine({
      street: bookingSettings?.venueStreet,
      postalCode: bookingSettings?.venuePostalCode,
      city: bookingSettings?.venueCity,
      country: bookingSettings?.venueCountry,
    }) ??
    undefined
  );
}

/** Everything one iteration of the agent loop reads and never changes. */
interface RunLoopContext {
  message: string;
  session: ChatSession;
  tenant: Tenant;
  conversationHistory: ChatMessage[];
  runId: string;
  botId: string;
  provider: LLMProvider;
  model: string;
  tools: ToolAdapter[];
  trace: AgentTrace;
  aiSettings: BotSettings['ai'];
  /**
   * Armed from the ENTITLED (pre-gate) tool list — see `prepareRun`. A bot with no
   * way to book or to check is never scolded for not doing either.
   */
  bookingClaimGuardArmed: boolean;
  availabilityClaimGuardArmed: boolean;
  specialtyTerms: string[];
  sessionBotOwned: boolean;
}

/** Everything one iteration of the agent loop may change. */
interface RunLoopState {
  messages: ChatMessage[];
  toolsCalled: string[];
  /**
   * Latest availability offered this run — surfaced as slot chips on the
   * reply, unless a booking mutation later consumes/invalidates the offer.
   */
  pendingAvailability: PendingAvailability | null;
  /** #80: the availability call these slots came from, so a surfaced call can be told from a
   *  discarded one. Null when the row could not be written - a missing link, never a fault. */
  pendingAvailabilityCallId: string | null;
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
  pendingAffordance: Affordance | null;
  /** Egress guard state: was a booking/request actually recorded this run? */
  bookingRecorded: boolean;
  /**
   * #7: per-run guard — a side-effecting tool must not execute twice with
   * identical args within one agent run (a model re-emitting the same call).
   * Cross-run re-invocation (the coalescer re-arming a turn) is already
   * neutralised by the booking provider's idempotency window + DB constraints
   * for create/request; reschedule/cancel re-runs are self-idempotent (same
   * target = no new effect).
   */
  sideEffectsInvoked: Set<string>;
  /** Have we already nudged the model once for claiming a booking that wasn't recorded? */
  correctionAttempted: boolean;
  /** Separate from `correctionAttempted`: each guard gets its own single retry, or one
   *  firing would spend the other's budget and ship the fault it was there to stop. */
  availabilityCorrectionAttempted: boolean;
  /** Same rule again: the promised-check guard owns its own single retry. */
  promisedCheckCorrectionAttempted: boolean;
  /**
   * A `check_availability` call HAPPENED this run, whatever it returned.
   *
   * Distinct from `pendingAvailability`, which is set only when the call SUCCEEDED and came
   * back with slots. A call that threw - paused business, no calendar, request-only service -
   * leaves that null, and a model saying "let me check" on such a turn HAS checked. Nudging it
   * to call again would be an instruction to repeat work that already failed.
   */
  availabilityChecked: boolean;
  pendingAddressFact: BookingAddressReplyFact | null;
  addressFactConflict: boolean;
  addressCorrectionAttempted: boolean;
  addressCorrectionOnly: boolean;
  /** True once `escalate_to_human` executed SUCCESSFULLY this run. Latched, never reset. */
  escalationRequested: boolean;
  priceContextLoaded: boolean;
}

function newRunLoopState(): RunLoopState {
  return {
    messages: [],
    toolsCalled: [],
    pendingAvailability: null,
    pendingAvailabilityCallId: null,
    pendingAffordance: null,
    bookingRecorded: false,
    sideEffectsInvoked: new Set<string>(),
    correctionAttempted: false,
    availabilityCorrectionAttempted: false,
    promisedCheckCorrectionAttempted: false,
    availabilityChecked: false,
    pendingAddressFact: null,
    addressFactConflict: false,
    addressCorrectionAttempted: false,
    addressCorrectionOnly: false,
    escalationRequested: false,
    priceContextLoaded: false,
  };
}

/** Whether the loop owes the model another iteration, or the run is finished. */
type IterationOutcome = { kind: 'continue' } | { kind: 'done'; result: AgentResult };

const CONTINUE_ITERATION: IterationOutcome = { kind: 'continue' };

/**
 * What a reply guard decided: ship this (possibly replaced) content, re-run the
 * loop with a nudge appended, or end the run with a prepared result.
 */
type GuardVerdict =
  | { kind: 'content'; content: string }
  | { kind: 'retry' }
  | { kind: 'result'; result: AgentResult };

/** The verdicts a guard that can only pass or ask for one more iteration returns. */
type ContentOrRetry = Exclude<GuardVerdict, { kind: 'result' }>;

/**
 * Everything the chips and the reply guards need from one availability offer.
 *
 * Kept together because each set answers a different question about the same offer: what the
 * channel delivered, what the tool told the model to offer in prose, and what create_booking
 * would still accept.
 */
interface OfferedTimes {
  /** The 8-chip window in local wall-clock time — what the channel was handed. */
  offeredLocal: string[] | null;
  /**
   * TIMES WITH NO CHIP. A requestable travel time is one the tool told the model to offer
   * in prose and capture with request_appointment, so naming it is doing as it was asked.
   * Both guards must count it as offered, or a mixed result answers a perfectly good
   * sentence with "that time is not available".
   */
  requestableLocal: string[];
  /** What the CHANNEL delivered, plus the prose-only times: the enumeration guard's set. */
  deliverableLocal: string[] | null;
  /**
   * EVERY time the customer may take, delivered or not. Only the single-time guard uses
   * it: a slot further down the list is one create_booking accepts, so a reply confirming
   * it is right, while a time nobody offered is an invention whatever the channel showed.
   */
  everyOfferableLocal: string[] | null;
  /**
   * Every CONFIRMABLE hour, not the 8-chip prefix: 10:00 further down the day is still the
   * time they named. Compared with the chip window, an intake answer that names no clock
   * time re-attached 00:00 / 00:30 / 01:00 above a confirmation of 10:00. Requestable
   * travel times stay out: naming one is not a reason to hide the chip for a time they can
   * actually book.
   */
  confirmableLocal: string[] | null;
  /**
   * HOW LONG AN APPOINTMENT IS HERE, so a confirmation that says the whole span
   * ("16:00 tot 17:00") is read as the one time it names, while a range that is not an
   * appointment ("we are open 9:00 tot 17:00") stays two readings and is left alone.
   */
  slotLengthsMin: number[];
}

function offeredTimeSets(av: PendingAvailability | null): OfferedTimes {
  if (!av) {
    return {
      offeredLocal: null,
      requestableLocal: [],
      deliverableLocal: null,
      everyOfferableLocal: null,
      confirmableLocal: null,
      slotLengthsMin: [],
    };
  }
  const offeredLocal = localClockTimes(av.slots.slice(0, 8), av.timezone);
  const requestableLocal = localClockTimes(av.requestableSlots, av.timezone) ?? [];
  const confirmableLocal = localClockTimes(av.slots, av.timezone);
  return {
    offeredLocal,
    requestableLocal,
    deliverableLocal: offeredLocal ? [...offeredLocal, ...requestableLocal] : null,
    everyOfferableLocal: [...(confirmableLocal ?? []), ...requestableLocal],
    confirmableLocal,
    slotLengthsMin: [
      ...new Set(
        [...av.slots, ...av.requestableSlots]
          .map((s) => Math.round((Date.parse(s.end) - Date.parse(s.start)) / 60_000))
          .filter((min) => min > 0),
      ),
    ],
  };
}

/** #80 (LP3): the offer record dispatch consumes, built from the surfaced chips. */
function buildOfferPayload(
  botId: string,
  av: PendingAvailability,
  availabilityCallId: string | null,
  chipCount: number,
): OfferMeasurement {
  return {
    botId,
    serviceId: av.serviceId ?? null,
    availabilityCallId,
    locationMode: av.locationMode ?? null,
    slotStarts: av.slots.slice(0, chipCount).map((s) => s.start),
    // #81 (LP4): the whole scoring, not the delivered prefix of it. What was
    // truncated is decided at dispatch, and the counterfactual order is a
    // statement about the list the scorer saw.
    ...(av.grouping ? { scoring: av.grouping } : {}),
    ...(av.groupingPilot ? { groupingPilot: true } : {}),
    ...(av.grouped ? { grouped: av.grouped } : {}),
    ...(av.groupingPreviousOrder ? { groupingPreviousOrder: av.groupingPreviousOrder } : {}),
  };
}

/** The model's copy of a tool result, capped so one big payload cannot crowd out the turn. */
function truncateToolPayload(payload: unknown): string {
  const json = JSON.stringify(payload);
  return json.length > 4000 ? json.substring(0, 4000) + '...[truncated]' : json;
}

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
    const { resolvedTemplates, templateBody, aiSettings, effBotSettings } = await this.resolveRunConfig(
      bot,
      tenant,
      botSettings,
      botAiSettings,
    );
    const trace: AgentTrace = {
      sessionId: session.id,
      tenantId: tenant.id,
      iterations: [],
      finishReason: 'completed',
    };
    // The mutable run state (including `escalationRequested`, true once
    // `escalate_to_human` executed SUCCESSFULLY this run) is created outside the
    // try, because the promise must survive the run's own failure: a provider
    // error AFTER the tool succeeded still returns `handoffRequested: true` from
    // the catch below.
    const state = newRunLoopState();
    // Same gate message-forwarding uses to run the bot. Missing ownership
    // (tests / older rows) defaults to bot_owned, matching the DB default.
    const sessionBotOwned =
      (session.ownership ?? 'bot_owned') === 'bot_owned' &&
      (session.status === 'bot' || session.status === 'waiting');

    try {
      const prepared = await this.prepareRun({
        message, session, tenant, conversationHistory, images,
        bot, botSettings, effBotSettings, aiSettings, resolvedTemplates, templateBody, trace,
      });
      state.messages = prepared.messages;
      state.priceContextLoaded = prepared.priceContextLoaded;
      const ctx: RunLoopContext = {
        message,
        session,
        tenant,
        conversationHistory,
        runId,
        botId: bot.id,
        // Model/provider are platform-standardised — always the platform default,
        // never per-bot/tenant (see llm/defaults).
        provider: getProvider({
          path: 'agent_reply',
          tenantId: tenant.id,
          encryptedApiKey: apiKey ?? undefined,
        }),
        model: DEFAULT_MODEL,
        tools: prepared.tools,
        trace,
        aiSettings,
        bookingClaimGuardArmed: prepared.bookingClaimGuardArmed,
        availabilityClaimGuardArmed: prepared.availabilityClaimGuardArmed,
        specialtyTerms: prepared.specialtyTerms,
        sessionBotOwned,
      };

      for (let i = 0; i < MAX_ITERATIONS; i++) {
        const outcome = await this.runIteration(i, ctx, state);
        if (outcome.kind === 'done') return outcome.result;
      }

      // Max iterations reached
      trace.finishReason = 'max_iterations';
      trace.terminal = { result: 'max_iterations' };
      void this.traceLogger.save(trace); // fire-and-forget: keeps the trace write off the response path
      return { type: 'max_iterations', fallbackMessage: "Let me connect you with a human agent.", ...(state.escalationRequested ? { handoffRequested: true } : {}) };

    } catch (error) {
      return this.terminalErrorResult(error, {
        trace,
        session,
        aiSettings,
        escalationRequested: state.escalationRequested,
      });
    }
  }

  /**
   * Bound templates + the effective AI slice for this run.
   *
   * Tone + policy guardrails come from the bound template (effectiveBotConfig),
   * not the bot. Override the AI slice once so every downstream read (prompt
   * builder, fallback messages) uses the effective values; escalationKeywords
   * and other operational fields are preserved. One resolve → body + config.
   */
  private async resolveRunConfig(
    bot: Bot,
    tenant: Tenant,
    botSettings: BotSettings,
    botAiSettings: BotSettings['ai'],
  ) {
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
    return {
      resolvedTemplates,
      templateBody,
      aiSettings,
      effBotSettings: { ...botSettings, ai: aiSettings },
    };
  }

  /**
   * Everything the agent loop needs, resolved once: the gated tool list, the
   * system prompt, and the opening message stack.
   *
   * Runs inside `run`'s try, exactly as this work always has, so a lookup that
   * throws still lands on the terminal-error exit.
   */
  private async prepareRun(args: {
    message: string;
    session: ChatSession;
    tenant: Tenant;
    conversationHistory: ChatMessage[];
    images?: AgentImageInput[];
    bot: Bot;
    botSettings: BotSettings;
    effBotSettings: BotSettings;
    aiSettings: BotSettings['ai'];
    resolvedTemplates: ResolvedTemplate[];
    templateBody: string;
    trace: AgentTrace;
  }) {
    const { message, session, tenant, conversationHistory, images } = args;
    const { bot, botSettings, effBotSettings, aiSettings, resolvedTemplates, templateBody, trace } = args;
    const entitledTools = await this.toolRegistry.getToolsForTenant(tenant, botSettings);
    // Armed from the ENTITLED (pre-gate) tool list, because a template-gated
    // booking bot is exactly the one most likely to be pushed into hallucinating
    // "I've booked you in" — and BOOKING_CORRECTION_NOTE has a branch for a model
    // holding no booking tool. Deliberately NOT `bookingActive` (see below).
    const bookingClaimGuardArmed = entitledTools.some((t) => t.name === 'create_booking');
    // The availability twin. Armed on the tool that could have answered the question, so a bot
    // with no way to check is never scolded for not checking.
    const availabilityClaimGuardArmed = entitledTools.some((t) => t.name === 'check_availability');
    const expectedModuleIds = resolvedTemplates[0]?.expectedModules;
    const selection = await this.resolveSkillSelection(tenant.id, resolvedTemplates, entitledTools);
    let tools = selection.tools;
    // Whether the bot can ACTUALLY book — read from the GATED tools. Drives the
    // {openingHours}/{services} sources: a bot that can't book must never quote a
    // booking availability rule it has no skill to use, nor advertise its services.
    const bookingActive = tools.some((t) => t.name === 'create_booking');
    const moduleSections = await this.buildModuleSections({
      tenant,
      bot,
      session,
      activeModules: selection.activeModules,
      selectedSkillIds: selection.selectedSkillIds,
      composableEnabled: selection.composableEnabled,
      bookingActive,
    });
    const customerName = await this.resolveCustomerName(session);
    const booking = await this.loadBookingRuleContext(bot, tenant, effBotSettings, bookingActive);
    const { serviceArea, venueLine } = await this.loadVenueContext(bot, tenant, effBotSettings);
    // Template body (layer 2) + effective tone/guardrails both come from the
    // one resolve above (effBotSettings carries the effective AI slice).
    // SpecialtyCatalog (S2/S4): scope to the bound template's vertical (category),
    // resolve the bot's effective specialties, and pass them to the composer so a
    // requiresSpecialPrompt specialty injects its exception block.
    const vertical = resolvedTemplates[0]?.category ?? null;
    const selectedSpecialtyDefs = effectiveSelectedSpecialties(effBotSettings.ai?.selectedSpecialties, vertical);
    const specialties = resolveSpecialties(selectedSpecialtyDefs);
    const specialtyTerms = specialtyRetrievalTerms(selectedSpecialtyDefs);
    // Resolve each selected/active skill's STATE for the trace; the tool drop below
    // then removes a non-ready skill's tools (no phantom bookings).
    const skillStates = resolveSkillStates({
      selected: selection.selectedSkillIds,
      active: selection.activeModuleIds,
      gateKind: (id) => getModule(id)?.gate.kind,
      readiness: (id) => readinessRefinement(id, { bookingConfigured: booking.bookingConfigured }),
    });
    // (The template tool-gate ran above, before `bookingActive` was read.)
    const skillProse = this.buildSkillProse(
      resolvedTemplates,
      selection.selectedSkillIds,
      skillStates,
      selection.composableEnabled,
    );
    this.applyTemplateVariables(aiSettings, resolvedTemplates);
    // Skill-state tool drop - ON by default. A non-ready (entitled but
    // UNCONFIGURED) skill's tools are removed before the model sees them, so an
    // unconfigured booking bot physically cannot call create_booking (no phantom
    // bookings). The tool-driven composer then renders "BOOKING (NOT AVAILABLE)"
    // (compose-system-prompt.ts:613, which records `toolAbsent` at :618).
    //
    // SKILL_STATE_ENABLED=false is the break-glass that restores the old
    // prompt-only gating (same pattern as GUARDRAILS_KILL_SWITCH): no deploy
    // needed, the prompt keeps driving off bookingConfigured.
    //
    // The drop only fires for skills PRESENT in `skillStates`, i.e. when the
    // module is entitlement-active. A legacy tenant with no active modules gets
    // an empty state map and dropUnreadySkillTools returns the same array
    // (pinned by skill-state.test.ts "drops nothing for an empty state map").
    if (process.env.SKILL_STATE_ENABLED !== 'false') {
      tools = dropUnreadySkillTools(tools, skillStates, (id) => getModule(id)?.tools.map((t) => t.name) ?? []);
    }
    const proactiveAsk = await this.mayAskForContact(session, tools);
    const kbContext = await this.prefetchKbContext({
      message, session, tenantId: tenant.id, tools, conversationHistory, specialtyTerms,
    });
    // Currently outside opening hours: the composer adds the AVAILABILITY fact so
    // the bot keeps helping and never announces "closed" as a reason to disengage.
    const outsideBusinessHours = isOutsideBusinessHours(effBotSettings.businessHours, bot.businessTimezone);
    const { prompt: systemPrompt, ledger } = this.promptBuilder.build(tenant, effBotSettings, tools, kbContext, moduleSections, customerName, templateBody, booking.bookingTimezone, booking.bookingConfigured, session.channel, specialties, skillProse, { services: booking.bookingServices, openingHours: booking.openingHours, bookingHours: booking.bookingHours, serviceArea, venueLine, hasTravelServices: booking.hasTravelServices }, { proactiveAsk, outsideBusinessHours });
    const memoryBlock = await renderMemoryForPrompt(session);
    const systemPromptWithMemory = memoryBlock ? `${systemPrompt}\n\n${memoryBlock}` : systemPrompt;
    const priceContextLoaded = containsCurrencyAmount(
      [systemPromptWithMemory, ...conversationHistory.map((m) => contentToText(m.content))].join('\n'),
    );
    // Merge the composer's block ledger with agent.service's module knowledge
    // (the composer can't name modules) onto the trace — nests in trace.jsonb,
    // no migration. Persisted on every fire-and-forget save below.
    trace.prompt = buildPromptTrace(ledger, {
      activeModuleIds: selection.activeModuleIds,
      expectedModuleIds,
      skillStates,
      resolvedTemplateId: resolvedTemplates[0]?.templateId,
      resolvedTemplateVersion: resolvedTemplates[0]?.resolvedVersion,
    });
    trace.customerMemory = {
      injected: memoryBlock.length > 0,
      chars: memoryBlock.length,
      factCount: memoryBlock.split('\n').filter((line) => /^[a-z_]+: /.test(line)).length,
    };
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPromptWithMemory },
      ...conversationHistory,
      { role: 'user', content: buildUserContent(message, images) },
    ];
    return { tools, bookingClaimGuardArmed, availabilityClaimGuardArmed, specialtyTerms, priceContextLoaded, messages };
  }

  /**
   * Which skills this bot composes, and the tool list that survives the gate.
   *
   * Composable-templates: a skill influences the LLM — its TOOLS *and* its PROMPT
   * section — iff its template selected it. Resolve the selection up-front so the
   * module prompt sections are gated in LOCKSTEP with the tools gated here.
   * Otherwise a no-booking bot still gets booking's "SERVICES (bookable)" catalog +
   * "you MUST call create_booking" text with no tool behind it (LEAK-1). See
   * gatedToolNames — same predicate, applied to the prompt surface.
   *
   * Templates are the SOLE source of skills: the bot's skills are exactly what
   * its template composes (∩ entitlements). A Dental template that binds {booking}
   * won't also offer handoff just because the plan allows it; and NO template (or
   * one gone unavailable) → selectedSkillIds is empty → no skills, matching the
   * "answers from your knowledge base only" empty-state. Flag-gated (OFF → legacy,
   * entitlement-only).
   *
   * This runs BEFORE anything reads the gated list, because `bookingActive` is
   * derived from it: gating late let an entitled-but-unselected booking skill
   * pull the AvailabilityRule into {openingHours} and silently discard the
   * tenant's businessHours (which the pre-AI off-hours gate *does* honour, so
   * the two contradicted each other).
   */
  private async resolveSkillSelection(
    tenantId: string,
    resolvedTemplates: ResolvedTemplate[],
    tools: ToolAdapter[],
  ) {
    const composableEnabled = process.env.COMPOSABLE_TEMPLATES_ENABLED === 'true';
    // Resolved BEFORE the skill selection, because an `inherit_entitled` template (#103) takes
    // its skills from exactly this list. `listActiveModules` is already entitlement- and
    // preference-filtered, so nothing here can hand a bot a tool its plan does not include.
    const activeModules = await listActiveModules(tenantId);
    const activeModuleIds = activeModules.map((a) => a.module.id);
    const activeFeatures = new Set(
      activeModules
        .map((a) => a.module.gate)
        .filter((g): g is { kind: 'feature'; feature: FeatureKey } => g.kind === 'feature')
        .map((g) => g.feature),
    );
    // Flag OFF is the legacy path: skills come from `expectedModules` alone and nothing
    // inherits, exactly as before. Normalised here rather than inside the shared resolver, so
    // the one function every surface calls stays free of a runtime-only flag.
    const templatesForSkills = composableEnabled
      ? resolvedTemplates
      : resolvedTemplates.map((rt) => ({ ...rt, selectedSkillIds: null, skillPolicy: 'explicit' as const }));
    const selectedSkillIds = effectiveSkillIds(
      templatesForSkills,
      composableEnabled ? featureGatedSkillIds((f) => activeFeatures.has(f)) : [],
    );
    let gated = tools;
    if (composableEnabled) {
      const drop = gatedToolNames(selectedSkillIds, activeModuleIds);
      if (drop.size) gated = gated.filter((tl) => !drop.has(tl.name));
    }
    return { composableEnabled, activeModules, activeModuleIds, selectedSkillIds, tools: gated };
  }

  /**
   * Module prompt contributions (e.g. booking's bookable-services catalog).
   *
   * Each active module builds (and loads data for) its own section; the
   * resolver call hits the same per-tenant caches the tool registry used.
   */
  private async buildModuleSections(args: {
    tenant: Tenant;
    bot: Bot;
    session: ChatSession;
    activeModules: Awaited<ReturnType<typeof listActiveModules>>;
    selectedSkillIds: string[];
    composableEnabled: boolean;
    bookingActive: boolean;
  }): Promise<string[]> {
    const { tenant, bot, session, activeModules, selectedSkillIds, composableEnabled, bookingActive } = args;
    const moduleSections: string[] = [];
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
    return moduleSections;
  }

  /**
   * Pre-fill the customer's name from their messaging-channel profile (channel
   * sessions only) so the agent can confirm it rather than ask cold. Widget
   * sessions have no binding/profile name.
   */
  private async resolveCustomerName(session: ChatSession): Promise<string | undefined> {
    if (!session.channel || session.channel === 'widget') return undefined;
    const binding = await AppDataSource.getRepository(ConversationBinding).findOne({
      where: { sessionId: session.id },
      select: { externalUserName: true },
    });
    return binding?.externalUserName ?? undefined;
  }

  /**
   * The booking facts the prompt quotes: {services}, {openingHours}, {bookingHours}.
   *
   * Anchor "Today is …" to the bot's canonical timezone for EVERY bot. Booking
   * used to be the only path that passed it, so a non-booking bot mixed UTC/server
   * dates and could answer "were you open yesterday?" against the wrong weekday.
   *
   * Spoken hours prefer the operational Bot.settings.businessHours (what the
   * owner set in the bot form). The booking AvailabilityRule is only a fallback
   * for the placeholder — it still solely governs which slots are bookable.
   */
  private async loadBookingRuleContext(
    bot: Bot,
    tenant: Tenant,
    effBotSettings: BotSettings,
    bookingActive: boolean,
  ) {
    const operationalHoursConfigured = isBusinessHoursConfigured(effBotSettings.businessHours);
    let openingHours = operationalHoursConfigured
      ? formatBusinessHoursForPlaceholder(
          effBotSettings.businessHours,
          new Date(),
          bot.businessTimezone,
        )
      : '';
    let bookingTimezone: string | undefined = bot.businessTimezone;
    let bookingConfigured = false;
    // Any bookable service carried out at the customer's address → travel-caveat
    // wording on ## OUR ADDRESS (and no come-in-person invite).
    let hasTravelServices = false;
    let bookingServices = '';
    let bookingHours = '';
    if (!bookingActive) {
      return { bookingTimezone, bookingConfigured, bookingServices, bookingHours, hasTravelServices, openingHours };
    }
    try {
      // Full row: the placeholder formatter needs availabilityMode/weeklyHours,
      // not just the timezone.
      const rule = await AppDataSource.getRepository(AvailabilityRule).findOne({
        where: { botId: bot.id },
      });
      // Canonical, server-owned business timezone (PR 1a): the bot value is
      // authoritative; the rule's denormalized copy is never consulted —
      // including inside the placeholder formatter, which derives "today"
      // (closure relevance) from rule.timezone.
      bookingTimezone = bot.businessTimezone || rule?.timezone || undefined;
      if (rule && bot.businessTimezone) rule.timezone = bot.businessTimezone;
      // Operational hours stay authoritative even when the formatted string is
      // empty (enabled but all-closed). Only fall back when they are not set.
      if (!operationalHoursConfigured) openingHours = formatHoursForPlaceholder(rule);
      // {bookingHours} always uses the AvailabilityRule. Empty when there is no
      // rule. Gated later: a bot that cannot book must not quote these hours.
      bookingHours = formatHoursForPlaceholder(rule);
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
      bookingServices = formatServicesForPlaceholder(services, bookingTimezone, new Date());
      hasTravelServices = services.some((s) => s.customerAddressRequired);
    } catch (error) {
      // Fail OPEN: on a lookup error don't suppress booking — a transient DB blip
      // must not falsely decline a CONFIGURED tenant. Worst case is the prior
      // behavior (unconfigured tenant may still over-offer), never a regression.
      logger.warn('booking config check failed — treating booking as usable', { tenantId: tenant.id, error });
      bookingConfigured = true;
    }
    return { bookingTimezone, bookingConfigured, bookingServices, bookingHours, hasTravelServices, openingHours };
  }

  /**
   * Where the business travels, for {serviceArea}. Loaded for EVERY bot, not just
   * booking ones: like opening hours this is a business fact a template author may
   * want to state, and it is one indexed lookup that returns nothing for the bots
   * (the overwhelming majority) with no area configured. Fails open to ''.
   *
   * The venue address (where the business receives customers) comes from the SAME
   * BookingSettings row — no new query. Gates the come-in-person invite in the
   * BOOKING (NOT AVAILABLE) block; stays undefined for a mobile-only business.
   */
  private async loadVenueContext(
    bot: Bot,
    tenant: Tenant,
    effBotSettings: BotSettings,
  ): Promise<{ serviceArea: string; venueLine?: string }> {
    const out: { serviceArea: string; venueLine?: string } = { serviceArea: '' };
    try {
      const bookingSettings = await AppDataSource.getRepository(BookingSettings).findOne({
        where: { botId: bot.id },
      });
      out.serviceArea = describeServiceArea(
        Array.isArray(bookingSettings?.serviceArea) ? bookingSettings.serviceArea : [],
      );
      const quotedAddressEnabled = effBotSettings.quotedAddress?.enabled !== false;
      out.venueLine = quotedAddressEnabled ? resolveVenueLine(tenant, effBotSettings, bookingSettings) : undefined;
    } catch (error) {
      logger.warn('service area lookup failed — {serviceArea} left empty', { tenantId: tenant.id, error });
    }
    return out;
  }

  /**
   * Per-template skill prose: the version's OVERRIDE if set, else the skill's
   * code-default (defaultProse). Only for skills that resolved `ready`, so an
   * unconfigured skill contributes no prose. Behind the flag (OFF → unchanged).
   *
   * H6: merge prose overrides across all bound templates (primary wins on conflict —
   * it's applied last), so a secondary template's skill still gets its authored prose.
   */
  private buildSkillProse(
    resolvedTemplates: ResolvedTemplate[],
    selectedSkillIds: string[],
    skillStates: ReturnType<typeof resolveSkillStates>,
    composableEnabled: boolean,
  ): Array<{ id: string; prose: string }> {
    if (!composableEnabled) return [];
    const skillProseOverrides = Object.assign(
      {},
      ...[...resolvedTemplates].reverse().map((rt) => rt.skillProse ?? {}),
    ) as Record<string, string>;
    return selectedSkillIds
      .filter((id) => skillStates[id] === 'ready')
      .map((id) => ({ id, prose: (skillProseOverrides?.[id] ?? getModule(id)?.defaultProse ?? '').trim() }))
      .filter((sp) => sp.prose.length > 0);
  }

  /**
   * Template variables — apply the bound template's declared DEFAULTS under the
   * bot's own tenant-filled values (bot value wins), so a declared {placeholder}
   * with a default substitutes even before a tenant fills it in.
   *
   * Every DECLARED variable resolves to a value — its default, else empty — so an
   * unfilled one renders as blank rather than leaking a literal {key} to the model.
   */
  private applyTemplateVariables(aiSettings: BotSettings['ai'], resolvedTemplates: ResolvedTemplate[]): void {
    const varDefaults: Record<string, string> = {};
    for (const v of resolvedTemplates[0]?.variables ?? []) {
      varDefaults[v.key] = typeof v.default === 'string' ? v.default : '';
    }
    if (aiSettings && Object.keys(varDefaults).length) {
      const av = aiSettings as { templateVariables?: Record<string, string> };
      av.templateVariables = { ...varDefaults, ...(av.templateVariables ?? {}) };
    }
  }

  /** One turn of the agent loop: budget, provider call, then tools or the reply. */
  private async runIteration(i: number, ctx: RunLoopContext, state: RunLoopState): Promise<IterationOutcome> {
    // Budget check
    if (await this.metering.isOverBudget(ctx.tenant.id, (ctx.aiSettings as any)?.dailyTokenBudget)) {
      return { kind: 'done', result: this.budgetExceededResult(ctx, state) };
    }

    // Build tool definitions for LLM
    const toolDefs: ToolDefinition[] | undefined = !state.addressCorrectionOnly && ctx.tools.length > 0
      ? ctx.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))
      : undefined;

    // Call LLM (one retry on a transient upstream failure — see callProviderWithRetry).
    const startMs = Date.now();
    const response = await callProviderWithRetry(
      ctx.provider,
      state.messages,
      { model: ctx.model, maxTokens: 1000, temperature: 0.3, jsonMode: false, tools: toolDefs },
      ctx.session.id,
    );
    const latencyMs = Date.now() - startMs;

    // Record metering
    await this.metering.record(ctx.tenant.id, response.usage);

    // Build trace entry
    const traceEntry: AgentTrace['iterations'][0] = {
      llmCall: { model: ctx.model, ...response.usage, latencyMs },
      toolCalls: [],
    };

    // No tool calls — final response
    if (response.finishReason === 'stop' || !response.toolCalls?.length || state.addressCorrectionOnly) {
      ctx.trace.iterations.push(traceEntry);
      return this.finalizeIteration(i, ctx, state, response.content ?? '');
    }

    // Process tool calls
    // Append assistant message WITH toolCalls BEFORE processing tool results
    state.messages.push({ role: 'assistant', content: response.content || '', toolCalls: response.toolCalls });

    for (const toolCall of response.toolCalls) {
      await this.executeToolCall(toolCall, traceEntry, ctx, state);
    }

    ctx.trace.iterations.push(traceEntry);
    return CONTINUE_ITERATION;
  }

  private budgetExceededResult(ctx: RunLoopContext, state: RunLoopState): AgentResult {
    ctx.trace.finishReason = 'budget_exceeded';
    ctx.trace.terminal = { result: 'budget_exceeded' };
    void this.traceLogger.save(ctx.trace); // fire-and-forget: keeps the trace write off the response path
    return {
      type: 'budget_exceeded',
      fallbackMessage: ctx.aiSettings?.guardrails?.fallbackMessage || 'I apologize, but I am temporarily unavailable.',
      ...(state.escalationRequested ? { handoffRequested: true } : {}),
    };
  }

  /**
   * The reply guards, in the order they have always run.
   *
   * Each one either passes the (possibly replaced) content on, asks for one more
   * iteration with a nudge appended, or ends the run with a prepared result.
   */
  private async finalizeIteration(
    i: number,
    ctx: RunLoopContext,
    state: RunLoopState,
    content: string,
  ): Promise<IterationOutcome> {
    const address = this.applyAddressGuard(i, ctx, state, content);
    if (address.kind === 'retry') return CONTINUE_ITERATION;
    const booking = this.applyBookingClaimGuard(i, ctx, state, address.content);
    if (booking.kind === 'retry') return CONTINUE_ITERATION;
    if (booking.kind === 'result') return { kind: 'done', result: booking.result };
    if (this.applyAvailabilityClaimGuard(i, ctx, state, booking.content)) return CONTINUE_ITERATION;
    const promised = await this.applyPromisedCheckGuard(i, ctx, state, booking.content);
    if (promised.kind === 'retry') return CONTINUE_ITERATION;
    if (promised.kind === 'result') return { kind: 'done', result: promised.result };
    return { kind: 'done', result: await this.buildFinalResult(ctx, state, promised.content) };
  }

  /** A reply that states an address the booking was NOT made for. */
  private applyAddressGuard(
    i: number,
    ctx: RunLoopContext,
    state: RunLoopState,
    content: string,
  ): ContentOrRetry {
    if (state.addressFactConflict) {
      logger.warn('[agent] conflicting authoritative booking addresses in one run; returning safe fallback', {
        sessionId: ctx.session.id,
      });
      return { kind: 'content', content: ADDRESS_CONFLICT_FALLBACK };
    }
    const fact = state.pendingAddressFact;
    if (!fact || validAddressReply(content, fact)) return { kind: 'content', content };
    if (!state.addressCorrectionAttempted && i < MAX_ITERATIONS - 1) {
      state.addressCorrectionAttempted = true;
      (ctx.trace.corrections ??= []).push('booking_address_mismatch');
      state.addressCorrectionOnly = true;
      logger.warn('[agent] blocked inaccurate booking address reply; requesting correction', {
        sessionId: ctx.session.id,
      });
      state.messages.push({ role: 'assistant', content });
      state.messages.push({ role: 'user', content: addressCorrectionNote(fact) });
      return { kind: 'retry' };
    }
    logger.warn('[agent] persistent inaccurate booking address reply; returning safe fallback', {
      sessionId: ctx.session.id,
    });
    return { kind: 'content', content: addressSafeFallback(fact) };
  }

  /**
   * Egress guard (issue #35): never let the model tell the customer a
   * booking/request happened unless one was actually recorded this run.
   */
  private applyBookingClaimGuard(
    i: number,
    ctx: RunLoopContext,
    state: RunLoopState,
    content: string,
  ): GuardVerdict {
    if (!ctx.bookingClaimGuardArmed || state.bookingRecorded || !claimsBookingForAgentNudge(content)) {
      return { kind: 'content', content };
    }
    if (!state.correctionAttempted && i < MAX_ITERATIONS - 1) {
      state.correctionAttempted = true;
      (ctx.trace.corrections ??= []).push('unrecorded_booking_claim');
      logger.warn('[agent] blocked unrecorded booking claim; nudging model to act', { sessionId: ctx.session.id });
      state.messages.push({ role: 'assistant', content });
      state.messages.push({ role: 'user', content: BOOKING_CORRECTION_NOTE });
      return { kind: 'retry' }; // re-run: model should call the tool or ask for the missing detail
    }
    ctx.trace.finishReason = 'completed';
    ctx.trace.terminal = { result: 'completed' };
    void this.traceLogger.save(ctx.trace);
    logger.warn('[agent] persistent unrecorded booking claim; returning safe fallback', { sessionId: ctx.session.id });
    // The affordance rides even the safe fallback. This branch fires when the model kept
    // claiming a booking nobody recorded, so the content is thrown away - but whether the
    // customer's address needs verifying is a fact about the conversation, not about the
    // sentence, and it is still true. Dropping it in the early return is the exact shape
    // #82 records two files over: attached only at the last exit, shipped from none of
    // the others.
    return {
      kind: 'result',
      result: {
        type: 'response',
        content: BOOKING_SAFE_FALLBACK,
        ...(state.pendingAffordance ? { affordance: state.pendingAffordance } : {}),
        ...(state.escalationRequested ? { handoffRequested: true } : {}),
      },
    };
  }

  /**
   * The availability twin of the guard above: a NAMED DATE declared shut or full when
   * nothing looked. Observed on production - "woensdag 16 september valt op een
   * sluitingsdag", offered as a manual request, on a turn with zero tool calls and a day
   * that had sixteen free slots. Every other availability guard reads a
   * `check_availability` result, so a turn that never called it is exactly the turn none
   * of them can judge.
   *
   * Nudge only, never a safe fallback. The model is not lying about a mutation it made,
   * it simply answered too early, and one more iteration with the tool is the whole fix.
   * A second offence falls through and ships: a clumsy sentence beats a dead end.
   *
   * Returns true when the run owes the model one more iteration.
   */
  private applyAvailabilityClaimGuard(
    i: number,
    ctx: RunLoopContext,
    state: RunLoopState,
    content: string,
  ): boolean {
    if (!ctx.availabilityClaimGuardArmed || state.pendingAvailability || state.bookingRecorded) return false;
    if (!claimsDatedUnavailability(content)) return false;
    if (state.availabilityCorrectionAttempted || i >= MAX_ITERATIONS - 1) return false;
    state.availabilityCorrectionAttempted = true;
    (ctx.trace.corrections ??= []).push('availability_unchecked_claim');
    logger.warn('[agent] blocked unchecked availability claim; nudging model to check', {
      sessionId: ctx.session.id,
    });
    state.messages.push({ role: 'assistant', content });
    state.messages.push({ role: 'user', content: AVAILABILITY_CORRECTION_NOTE });
    return true; // re-run: the model should call check_availability before answering
  }

  /**
   * THE DEAD-END PROMISE, and the one failure in this family that ends with no answer at
   * all. Production, session 4d3f6473, 18:04:18Z: "Ik controleer even of woensdag 2
   * september 2026 om 09:15 uur beschikbaar is voor 30 minuten" - zero tool calls that
   * turn, and nothing schedules a continuation, so the customer is left holding a promise
   * no code path will keep. The guards above judge a claim the model had no right to make;
   * this judges a turn that made no claim, gave no answer, and did no work.
   *
   * TWO OUTCOMES, and neither may ship the promise. A promise on a turn that never looked
   * is a model that answered too early: one nudge fixes it. A promise on a turn where the
   * call already RAN and came back with nothing - paused business, no calendar,
   * request-only service - must not be nudged, because that is an instruction to repeat
   * work that already failed; but it is the same dead end, and the customer is most likely
   * to be stranded exactly there. So it is replaced instead, with no second call.
   */
  private async applyPromisedCheckGuard(
    i: number,
    ctx: RunLoopContext,
    state: RunLoopState,
    content: string,
  ): Promise<GuardVerdict> {
    const pass: GuardVerdict = { kind: 'content', content };
    if (!ctx.availabilityClaimGuardArmed || state.bookingRecorded) return pass;
    if (!promisesAvailabilityCheck(content, ctx.message)) return pass;
    if (!state.availabilityChecked) return this.promisedCheckNothingRan(i, ctx, state, content);
    // THE CALL RAN. `pendingAvailability` being set means only that it SUCCEEDED - the
    // tool sets `availability` for every success, `slots: []` included - so object
    // truthiness says nothing about whether the customer can see a time. What decides that
    // is the CONFIRMABLE array, because `buildSlotQuickReplies` reads exactly that: with
    // one slot the chips are on screen and a clumsy "let me check" beside them is not a
    // dead end. With none - an empty diary, or a travel result where every time needs the
    // owner's say-so - there is nothing on screen and the promise is the dead end again.
    if (state.pendingAvailability && state.pendingAvailability.slots.length > 0) return pass;
    ctx.trace.finishReason = 'completed';
    ctx.trace.terminal = { result: 'completed' };
    void this.traceLogger.save(ctx.trace);
    // TWO DIFFERENT FACTS, so two sentences. A call that THREW means the diary could not
    // be read; a call that succeeded with nothing confirmable means it was read and had
    // nothing to offer. Saying "I cannot see the diary" about a diary we just read would
    // be a fresh lie, and neither sentence may say "closed" or "fully booked" - the
    // tool's own guidance forbids exactly that.
    const promiseReplacement = state.pendingAvailability
      ? NO_CONFIRMABLE_TIMES_FALLBACK
      : CHECK_FAILED_FALLBACK;
    logger.warn('[agent] reply promised a check with nothing to offer; replacing it', {
      sessionId: ctx.session.id,
      checked: true,
      succeeded: !!state.pendingAvailability,
    });
    return {
      kind: 'result',
      result: {
        type: 'response',
        content: await inCustomerLanguage(promiseReplacement, ctx.message, ctx.session),
        ...(state.pendingAffordance ? { affordance: state.pendingAffordance } : {}),
        ...(state.escalationRequested ? { handoffRequested: true } : {}),
      },
    };
  }

  /** A promise to look at the diary on a turn where nothing looked: nudge once, then ask. */
  private async promisedCheckNothingRan(
    i: number,
    ctx: RunLoopContext,
    state: RunLoopState,
    content: string,
  ): Promise<GuardVerdict> {
    if (!state.promisedCheckCorrectionAttempted && i < MAX_ITERATIONS - 1) {
      state.promisedCheckCorrectionAttempted = true;
      logger.warn('[agent] reply promised a check nothing ran; nudging model to call it', {
        sessionId: ctx.session.id,
      });
      state.messages.push({ role: 'assistant', content });
      state.messages.push({ role: 'user', content: PROMISED_CHECK_NOTE });
      return { kind: 'retry' }; // re-run: call check_availability, or ask for the one missing detail
    }
    ctx.trace.finishReason = 'completed';
    ctx.trace.terminal = { result: 'completed' };
    void this.traceLogger.save(ctx.trace);
    logger.warn('[agent] reply promised a check twice; asking the customer instead', {
      sessionId: ctx.session.id,
    });
    return {
      kind: 'result',
      result: {
        type: 'response',
        content: await inCustomerLanguage(PROMISED_CHECK_FALLBACK, ctx.message, ctx.session),
        ...(state.pendingAffordance ? { affordance: state.pendingAffordance } : {}),
        ...(state.escalationRequested ? { handoffRequested: true } : {}),
      },
    };
  }

  /** The reply that ships: chips, the invented-time guard, and the #80 offer record. */
  private async buildFinalResult(
    ctx: RunLoopContext,
    state: RunLoopState,
    finalContent: string,
  ): Promise<AgentResult> {
    ctx.trace.finishReason = 'completed';
    ctx.trace.terminal = { result: 'completed' };
    void this.traceLogger.save(ctx.trace); // fire-and-forget: keeps the trace write off the response path
    const av = state.pendingAvailability;
    const times = offeredTimeSets(av);
    // THE HOUR THE CUSTOMER THEMSELVES NAMED. Never an allowance - a reply may not confirm
    // it just because they asked ("09:15 is vrij, net als 09:00 en 09:30" is three times, so
    // the single-time guard stands down and the enumeration guard is the only thing left).
    // It only decides WHICH replacement is true: their own hour being unavailable is a
    // sharper sentence than a bare pointer at the list.
    const customerTimeText = latestCustomerTimeText([
      ...ctx.conversationHistory.map((m) => ({
        role: m.role,
        text: contentToText(m.content),
      })),
      { role: 'user', text: ctx.message },
    ]);
    // Chips exist to pick a time. If the customer already named one that we can actually
    // book, or the reply is confirming that one time, attaching hours again is how the
    // WhatsApp loop starts: they tap the same chip, we re-check, we re-attach the chips.
    const alreadyChoseTime = !!(
      times.confirmableLocal &&
      (namesSingleOfferedTime(customerTimeText, times.confirmableLocal) ||
        namesSingleOfferedTime(finalContent, times.confirmableLocal))
    );
    const slotChips = alreadyChoseTime ? undefined : buildSlotQuickReplies(av);
    const safeContent = await this.safeReplyContent({
      ctx, finalContent, av, times, customerTimeText, onScreen: !!slotChips?.length,
    });

    return {
      type: 'response',
      content: safeContent,
      quickReplies: slotChips,
      validationContext: { bookingRecorded: state.bookingRecorded, priceContextLoaded: state.priceContextLoaded },
      ...(state.escalationRequested ? { handoffRequested: true } : {}),
      ...(state.pendingAffordance ? { affordance: state.pendingAffordance } : {}),
      // #80 (LP3): rides along so the DISPATCH boundary can record what was actually
      // delivered. It cannot be measured here - channels truncate quick replies and drop
      // them where unsupported - and dispatch knows none of this context on its own.
      ...(slotChips?.length && av
        ? { offer: buildOfferPayload(ctx.botId, av, state.pendingAvailabilityCallId, slotChips.length) }
        : {}),
    };
  }

  /**
   * A reply that NAMES a time nobody can book is the availability twin of a false
   * confirmation, and it reaches the customer as plain prose - above perfectly correct
   * chips, or above nothing at all. An ENUMERATION is compared against what was actually
   * delivered, not the whole slot list: a time truncated away by the channel is one the
   * customer cannot take.
   *
   * GATED ON THE AVAILABILITY, NOT ON THE CHIPS. A requestable-only result has no chip by
   * design, and that is the turn where an invented time is most dangerous - the tool has
   * just asked the model to read times out in prose, and nothing on screen contradicts it.
   * Skipped only when this call offered NOTHING: with no ground truth every named time
   * reads as invented, including the request-capture flow's job of repeating the time the
   * customer themselves asked for.
   */
  private async safeReplyContent(args: {
    ctx: RunLoopContext;
    finalContent: string;
    av: PendingAvailability | null;
    times: OfferedTimes;
    customerTimeText: string;
    onScreen: boolean;
  }): Promise<string> {
    const { ctx, finalContent, av, times, customerTimeText, onScreen } = args;
    if (!av || !times.deliverableLocal?.length) return finalContent;
    const judged = collapseAppointmentSpans(finalContent, times.slotLengthsMin);
    // THE ENUMERATION GUARD STAYS ON CHIPPED TURNS, which is the only place its rule makes
    // sense: it compares a list against what the channel delivered, and a time truncated
    // away is one the customer cannot tap. With nothing on screen there is no delivered
    // list to contradict, and its 2-or-more floor makes it the wrong instrument anyway.
    const bogus = onScreen ? unofferedTimesIn(judged, times.deliverableLocal) : [];
    // ONE named time is not a stray item in a list, it is the whole recommendation, so it
    // is judged on EVERY turn a time was offered. That exemption shipped "the next valid
    // time is 08:30" - the first slot's UTC instant read as a wall clock - above chips
    // that said 10:30, and shipped it again where no chip existed to contradict it.
    const invented = bogus.length
      ? null
      : unofferedSingleTimeIn(judged, times.everyOfferableLocal ?? times.deliverableLocal);
    const flagged = bogus.length ? bogus : invented ? [invented] : [];
    if (!flagged.length) return finalContent;
    // WHICH SENTENCE IS TRUE. When one of the flagged hours is the one the CUSTOMER
    // named, "that time is not available" answers them; a bare pointer at the list reads
    // as if their question was never heard. Their hour never buys the reply a pass - it
    // only chooses the wording.
    const named = new Set(parseClockTimes(customerTimeText).map((t) => t.key));
    const theirs = flagged.some((w) => parseClockTimes(w).some((t) => named.has(t.key)));
    const replacement = !onScreen
      ? NO_SLOTS_ON_SCREEN_FALLBACK
      : theirs || invented
        ? UNBOOKABLE_TIME_FALLBACK
        : AVAILABILITY_SAFE_FALLBACK;
    logger.warn('[agent] reply named a time nobody offered; replacing it', {
      sessionId: ctx.session.id,
      named: flagged.slice(0, 6),
      offered: times.everyOfferableLocal ?? times.deliverableLocal,
      chips: onScreen,
      customerNamed: theirs,
    });
    // IN THE CUSTOMER'S LANGUAGE. These three are authored in English and they replace a
    // reply the model wrote in the customer's, so shipping them raw answers a Dutch
    // question in English - seen on production on 2026-08-26, driving the real widget.
    // `localizeMessage` fails open: anything it cannot do returns the original.
    return inCustomerLanguage(replacement, ctx.message, ctx.session);
  }

  /** One tool call: preconditions, the per-run side-effect dedupe, then execution. */
  private async executeToolCall(
    toolCall: ToolCall,
    traceEntry: AgentTrace['iterations'][0],
    ctx: RunLoopContext,
    state: RunLoopState,
  ): Promise<void> {
    const tool = ctx.tools.find((t) => t.name === toolCall.name);
    const toolStartMs = Date.now();

    if (!tool) {
      state.messages.push({ role: 'tool', content: JSON.stringify({ error: `Unknown tool: ${toolCall.name}` }), toolCallId: toolCall.id });
      return;
    }

    // Precondition check
    if (tool.preconditions?.toolsCalled) {
      const missing = tool.preconditions.toolsCalled.filter((t) => !state.toolsCalled.includes(t));
      if (missing.length > 0) {
        const errorMsg = `Must call ${missing.join(', ')} before ${tool.name}`;
        state.messages.push({ role: 'tool', content: JSON.stringify({ error: errorMsg }), toolCallId: toolCall.id });
        traceEntry.toolCalls.push({ name: tool.name, args: toolCall.arguments, result: { success: false, error: errorMsg }, latencyMs: 0 });
        return;
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
    if (sideEffectSig && state.sideEffectsInvoked.has(sideEffectSig)) {
      state.messages.push({ role: 'tool', content: JSON.stringify({ note: 'already_performed', tool: tool.name }), toolCallId: toolCall.id });
      traceEntry.toolCalls.push({ name: tool.name, args: toolCall.arguments, result: { success: true }, latencyMs: 0 });
      return;
    }

    // Execute tool
    const toolCtx: ToolContext = {
      tenantId: ctx.tenant.id,
      sessionId: ctx.session.id,
      runId: ctx.runId,
      channel: ctx.session.channel ?? 'widget',
      toolsCalledThisTurn: state.toolsCalled,
      dataSource: AppDataSource,
      conversationHistory: state.messages,
      specialtyTerms: ctx.specialtyTerms.length ? ctx.specialtyTerms : undefined,
      botOwned: ctx.sessionBotOwned,
    };

    try {
      const result = await tool.execute(toolCall.arguments, toolCtx);
      state.toolsCalled.push(tool.name);
      // #7: only now (post-success) is the side-effect "performed" — a failed
      // attempt stays retryable.
      if (sideEffectSig && result.success) state.sideEffectsInvoked.add(sideEffectSig);
      this.absorbToolResult(tool, toolCall, result, ctx, state);
      const resultJson = truncateToolPayload(this.modelPayloadFor(tool, result, ctx, state));
      state.messages.push({
        role: 'tool',
        content: resultJson,
        toolCallId: toolCall.id,
      });
      // The affordance is a client control, not an audit fact. `options[].text` is Google
      // Content (ADR-0014) and `query` is the customer's typed address, which "must never
      // reach a log". Strip it from the trace exactly as replyFact is stripped, so
      // `agent_traces` keeps neither. See #98.
      const { replyFact: _replyFact, affordance: _affordance, ...traceResult } = result;
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
      logger.error('Agent tool threw', { sessionId: ctx.session.id, tool: tool.name, error });
      const safeMsg = `The ${tool.name} tool is temporarily unavailable. Do not retry it this turn.`;
      state.messages.push({ role: 'tool', content: JSON.stringify({ error: safeMsg }), toolCallId: toolCall.id });
      traceEntry.toolCalls.push({
        name: tool.name,
        args: toolCall.arguments,
        result: { success: false, error: rawMsg },
        latencyMs: Date.now() - toolStartMs,
      });
    }
  }

  /** Everything a successful tool result changes about the run's own state. */
  private absorbToolResult(
    tool: ToolAdapter,
    toolCall: ToolCall,
    result: ToolResult,
    ctx: RunLoopContext,
    state: RunLoopState,
  ): void {
    // The customer asked for a human and the escalation tool accepted it.
    // Latched (never reset) so whatever exit this run takes carries
    // `handoffRequested: true` — the forwarding mapping owes them a human.
    if (tool.name === 'escalate_to_human' && result.success && ctx.sessionBotOwned) state.escalationRequested = true;
    if (result.success && result.replyFact?.kind === 'booking_address') {
      const merged = mergeAddressFacts(state.pendingAddressFact, result.replyFact);
      state.pendingAddressFact = merged.fact;
      state.addressFactConflict ||= merged.conflict;
    }
    // Harvested for EVERY tool, not just the one that raises it today. The alternative -
    // reading it inside the `check_availability` branch below - would make the next tool
    // that wants an affordance work perfectly and ship nothing, which is the failure this
    // whole area keeps producing.
    if (result.affordance) state.pendingAffordance = result.affordance;
    // Whatever it returned, the call happened: see `availabilityChecked`.
    if (tool.name === 'check_availability') state.availabilityChecked = true;
    // Track offered slots for the chip UI; a booking mutation clears them.
    //
    // OFF `availability`, never off `data`. `data` speaks the business's wall clock now,
    // because a model handed a `Z` instant reads its digits out loud - so the chips, the
    // offer record and the invented-time guard take the instants from the field the model
    // never sees, exactly as #81's scoring comes off `measurement`.
    if (tool.name === 'check_availability' && result.success && result.availability) {
      this.absorbAvailability(toolCall, result, result.availability, ctx, state);
    } else if (BOOKING_MUTATION_TOOLS.includes(tool.name) && result.success) {
      state.pendingAvailability = null;
      // The booking consumed the address binding in its own transaction, so an offer to
      // verify one now points at a conversation state that no longer exists. Cleared with
      // the slots, for the same reason the slots are cleared: the offer was about a
      // decision the customer has already made.
      state.pendingAffordance = null;
      state.bookingRecorded = true;
    }
  }

  /** A successful `check_availability`: the chip offer, plus the #80 call record. */
  private absorbAvailability(
    toolCall: ToolCall,
    result: ToolResult,
    a: NonNullable<ToolResult['availability']>,
    ctx: RunLoopContext,
    state: RunLoopState,
  ): void {
    if (!Array.isArray(a.slots)) return;
    const slots = a.slots;
    state.pendingAvailability = {
      slots,
      // Prose-only times: no chip carries them, and the reply guards must not treat
      // one the tool asked the model to offer as an invention.
      requestableSlots: Array.isArray(a.requestableSlots) ? a.requestableSlots : [],
      timezone: a.timezone ?? 'UTC',
      serviceName: a.serviceName,
      serviceId: a.serviceId,
      locationMode: a.locationMode,
      // #81 (LP4): off `measurement`, never off `data` - `data` is what the model is
      // shown, and this is deliberately invisible to it.
      grouping: (result.measurement as { grouping?: OfferScoring } | undefined)?.grouping,
      groupingPilot: a.travel?.groupingPilot === true,
      grouped: a.travel?.grouped,
      groupingPreviousOrder: a.travel?.groupingPreviousOrder,
    };
    // #80 (LP3): every call is recorded, surfaced or not. This is the CALL-level unit,
    // and it exists separately from the offer because a call the model never surfaces
    // still counts in "how often do customers ask across several days" - the number
    // #84's gate turns on. Fire-and-forget: a measurement row is never worth a turn.
    const callArgs = toolCall.arguments as { startDate?: string; endDate?: string; serviceId?: string };
    void import('../booking/offer-record.service')
      .then((m) =>
        m.recordAvailabilityCall({
          tenantId: ctx.session.tenantId,
          botId: ctx.botId,
          sessionId: ctx.session.id,
          // The RESOLVED service, not the one the caller named: `check_availability`
          // picks the sole bookable service when the argument is omitted, and the
          // record should say which service was actually offered.
          serviceId: a.serviceId ?? callArgs?.serviceId ?? null,
          startDate: callArgs?.startDate,
          endDate: callArgs?.endDate,
          slotCount: slots.length,
        })
      )
      .then((id) => {
        state.pendingAvailabilityCallId = id;
      })
      .catch(() => undefined);
  }

  /**
   * R31: a tool that fails may return a raw infra error (err.message)
   * as result.error; never forward an UNMARKED error to the model — it
   * could be echoed to the customer. Only errors a tool explicitly
   * marks errorSafeForModel (authored domain errors) pass through; the
   * rest become a generic message. The full result stays in the trace.
   */
  private modelPayloadFor(
    tool: ToolAdapter,
    result: ToolResult,
    ctx: RunLoopContext,
    state: RunLoopState,
  ): unknown {
    if (result.success) {
      const modelPayload = result.data ?? {};
      if (tool.name === 'kb_search' && containsCurrencyAmount(JSON.stringify(modelPayload))) {
        state.priceContextLoaded = true;
      }
      return modelPayload;
    }
    if (result.errorSafeForModel) return { error: result.error };
    logger.warn('Agent tool error sanitized for model', {
      sessionId: ctx.session.id, tool: tool.name, error: result.error,
    });
    return { error: `The ${tool.name} tool couldn't complete that request right now.` };
  }

  /** The run's terminal failure: which kind, recorded, then the caller's fallback. */
  private terminalErrorResult(
    error: unknown,
    args: {
      trace: AgentTrace;
      session: ChatSession;
      aiSettings: BotSettings['ai'];
      escalationRequested: boolean;
    },
  ): AgentResult {
    const { trace, session, aiSettings, escalationRequested } = args;
    trace.finishReason = 'error';
    // WHICH failure, recorded before the save. `finishReason` alone left a production
    // incident with five candidate causes and no way to choose between them.
    const kind = classifyTerminalError(error);
    trace.terminal = { result: 'error', error: terminalErrorFrom(error, kind) };
    void this.traceLogger.save(trace); // fire-and-forget: keeps the trace write off the response path
    logger.error('Agent loop error', { sessionId: session.id, error });
    // Any upstream_* kind is a provider/platform failure, not one conversation
    // going wrong: it must not park the session in a bot_error handoff.
    const infraFailure =
      kind === 'upstream_quota' ||
      kind === 'upstream_rate_limit' ||
      kind === 'upstream_server_error' ||
      kind === 'upstream_unreachable';
    if (infraFailure) {
      // Log distinctly: a provider outage is an operational emergency, often
      // across every tenant at once, not one conversation going wrong.
      logger.error('[agent] upstream provider failure — NOT a bot fault', {
        sessionId: session.id,
        kind,
      });
    }
    return {
      type: 'error',
      error: error instanceof Error ? error.message : 'Unknown error',
      fallbackMessage: aiSettings?.guardrails?.fallbackMessage || 'Something went wrong. Let me connect you with a human agent.',
      infraFailure,
      // A successful escalation earlier in this run survives the failure: the
      // customer explicitly asked for a human, so the handoff must still happen
      // — even (especially) when the provider then fell over.
      ...(escalationRequested ? { handoffRequested: true } : {}),
    };
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
