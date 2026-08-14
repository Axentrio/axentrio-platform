/**
 * Booking capability readiness (.scratch/plan-capability-readiness-framework.md,
 * Decision 4 booking). The MVP capability that proves the framework.
 *
 * The anti-lying guarantee: `live` is computed via the SAME predicate the agent
 * runtime uses (`isBookingConfigured`), so the portal can never claim booking is
 * live when the runtime gate would decline it. The calendar/health/auto-confirm
 * enrichment is endpoint-only (calendar is checked at booking time, never on the
 * agent hot path) and is SCOPED to bots that have an auto service — a
 * request-only-only bot is `live` with no calendar/sync/hours noise.
 */
import { DateTime } from 'luxon';
import { AppDataSource } from '../../database/data-source';
import { ServiceType } from '../../database/entities/ServiceType';
import {
  AvailabilityRule,
  isRelevantOn,
  type WeeklyHours,
  type TimeWindow,
} from '../../database/entities/AvailabilityRule';
import { loadActiveCredential } from '../../scheduler/calendar-provider';
import { getBotBusinessTimezone } from '../../booking/business-timezone';
import { isBookingConfigured } from '../../scheduler/booking-readiness';
import { resolveBoundTemplates, effectiveSkillIds } from '../../templates/template-resolver';
import { featureGatedSkillIds } from '../../modules/module-catalog';
import {
  registerCapability,
  type CapabilityReadiness,
  type ReadinessBotCtx,
  type ReadinessResult,
} from '../registry';

// ── Effective-hours helpers (mirror the slot engine's NUMERIC HH:MM parse) ───
//
// REUSE the slot engine's exact parser semantics (booking-providers/slot-engine.ts):
// numeric minutes-since-midnight, start < end, "24:00" allowed as an end marker —
// NOT lexicographic string compare (so "9:00" vs "17:00" compares correctly).

/** Minutes since midnight, or null if un-parseable. Mirrors slot-engine `parseHHMM`. */
export function parseHHMM(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 24 || min < 0 || min > 59 || (h === 24 && min !== 0)) return null; // allow 24:00
  return h * 60 + min;
}

/** A window is valid iff both times parse AND start < end numerically. */
export function isValidWindow(w: TimeWindow | undefined | null): boolean {
  if (!w) return false;
  const s = parseHHMM(w.start);
  const e = parseHHMM(w.end);
  return s != null && e != null && s < e;
}

/** ≥1 weekday key maps to a non-empty array containing ≥1 VALID window. */
export function hasNonEmptyWeeklyHours(weeklyHours: WeeklyHours | null | undefined): boolean {
  if (!weeklyHours) return false;
  return Object.values(weeklyHours).some(
    (windows) => Array.isArray(windows) && windows.some(isValidWindow),
  );
}

/**
 * A future (today-or-later, in the rule's timezone) non-closed date override
 * with ≥1 valid window OPENS a day in EVERY mode (slot-engine `windowsForDay`),
 * so a tenant running purely on date overrides must NOT be flagged hours-missing.
 */
export function hasUpcomingOpenOverride(rule: AvailabilityRule, today: string): boolean {
  return (rule.dateOverrides || []).some(
    // A RANGE stays relevant until its LAST day, not its first. Testing only `o.date` told a
    // business running on an in-progress open range that its hours were missing from day two,
    // while the engine kept opening every remaining day of that range.
    (o) =>
      isRelevantOn(o, today) &&
      !o.closed &&
      Array.isArray(o.windows) &&
      o.windows.some(isValidWindow),
  );
}

/**
 * Effective bookable hours exist — the STRICTER conjunct auto-confirm requires
 * (NOT just `hasRule`). `always_open` is always open; `business_hours` needs a
 * non-empty/valid weekly schedule; a future open date override satisfies it in
 * any mode.
 */
export function hasEffectiveHours(rule: AvailabilityRule | null, today: string): boolean {
  if (rule == null) return false;
  return (
    rule.availabilityMode === 'always_open' ||
    (rule.availabilityMode === 'business_hours' && hasNonEmptyWeeklyHours(rule.weeklyHours)) ||
    hasUpcomingOpenOverride(rule, today)
  );
}

export type CalendarState = 'none' | 'reauth_required' | 'healthy';

// ── Setup CTAs (P1 anchor-scoped; surface restriction handled by the portal) ──
const CTA_ADD_SERVICE = { route: '/bookings/setup', label: 'Add a bookable service' };
const CTA_SET_HOURS = { route: '/bookings/setup', label: 'Set availability hours' };
const CTA_CONNECT_CAL = { route: '/bookings/setup', label: 'Connect a calendar' };
const CTA_RECONNECT_CAL = { route: '/bookings/setup', label: 'Reconnect your calendar' };
/** The template binding is what hands the bot the skill, so that is where this sends them. */
const CTA_ENABLE_BOOKING_SKILL = { route: '/ai/bots', label: 'Give this bot the booking skill' };

/**
 * Does any resolved bound template give this bot the booking skill? Computed from the
 * RESOLVED bound version(s) (`resolveBoundTemplates` → the pinned/latest version
 * each binding actually uses), NOT a union across all published versions — an
 * older published version expecting booking while the resolved one does not must
 * NOT falsely mark the nudge active.
 *
 * Goes through `selectedSkillIdsOf` — the same helper the skill-coverage diagnostic
 * and the agent's own tool gate use. This previously read `expectedModules` directly,
 * which disagreed with the runtime for any version where the two columns differ (the
 * admin API validates them independently, so that is reachable): a version selecting
 * `lead_capture` while expecting `booking` reported booking as active here while the
 * bot was in fact denied the booking tools.
 */
async function resolvedBookingTemplateActive(ctx: ReadinessBotCtx): Promise<boolean> {
  const resolved = await resolveBoundTemplates(ctx.bot);
  // The EFFECTIVE skills (#103): a template whose policy is `inherit_entitled` — Blank — delivers
  // booking without naming it, and reading only the explicit selection would call that bot dead.
  //
  // The inheritable set is built from the entitlements this check ALREADY resolved, never from
  // `listActiveModules`: that re-resolves and swallows failures (Decision 3), which would turn a
  // real entitlement outage into a quiet "booking not delivered" instead of a 5xx.
  return effectiveSkillIds(
    resolved,
    featureGatedSkillIds((f) => ctx.entitlements.features[f] === true),
  ).includes('booking');
}

export const bookingReadiness: CapabilityReadiness = {
  key: 'booking',

  // Decision 3 / FLAGGED DIVERGENCE: appliesTo = the EFFECTIVE bookings flag,
  // read PURELY from the once-resolved entitlements. Do NOT call
  // listActiveModules/isModuleActive (they re-resolve + swallow failures, which
  // would turn a real resolution failure into a misleading silent-absent).
  appliesTo(ctx: ReadinessBotCtx): boolean {
    return ctx.entitlements.features.bookings === true;
  },

  async check(ctx: ReadinessBotCtx): Promise<ReadinessResult[]> {
    const botId = ctx.bot.id;

    // Services mirror the runtime GATE filter EXACTLY (isActive && onlineBookable;
    // select only bookingMode). The gate, the prompt CATALOG and `resolveService` now all
    // agree on `isActive && onlineBookable` — the asymmetry this comment used to describe as
    // open was closed in booking.module.ts and is pinned by booking-catalog-filter.test.ts.
    const [services, rule] = await Promise.all([
      AppDataSource.getRepository(ServiceType).find({
        where: { botId, isActive: true, onlineBookable: true },
        select: { id: true, bookingMode: true },
      }),
      AppDataSource.getRepository(AvailabilityRule).findOne({ where: { botId } }),
    ]);

    const hasRule = !!rule;
    const hasAutoService = services.some((s) => s.bookingMode !== 'request');

    // Computed from the RESOLVED bound version(s) (Decision 4).
    const bookingTemplateActive = await resolvedBookingTemplateActive(ctx);

    // `live` mirrors the runtime gate verbatim (the anti-lying guarantee) — BOTH halves of it.
    //
    // `isBookingConfigured` is the CONFIGURATION gate. It was the whole of this check until
    // 2026-08-13, when production showed a bot reporting `live` with no missing steps, a healthy
    // calendar and `willAutoConfirm: true`, while telling customers it worked without
    // appointments. The template gate had stripped the booking tools before the agent saw them,
    // and `bookingTemplateActive: false` sat in the same payload as advisory detail.
    //
    // A bot that cannot be handed the tool is not live in any sense an owner means by the word,
    // and this failure on a different skill already cost a paying customer ninety days of leads.
    const configured = isBookingConfigured(services, hasRule);
    const live = configured && bookingTemplateActive;

    const missingSteps: ReadinessResult['missingSteps'] = [];
    const attention: NonNullable<ReadinessResult['attention']> = [];
    const detail: Record<string, unknown> = { bookingTemplateActive };

    if (!live) {
      // not_ready: ordered PATH TO LIVE only. Configuration comes first even when the skill is
      // also missing — sending an owner to a template screen for a bot with nothing bookable
      // asks them to deliver a capability that has no content yet.
      if (!configured) {
        if (services.length === 0) {
          missingSteps.push({ id: 'add_service', label: 'Add a bookable service', cta: CTA_ADD_SERVICE });
        } else {
          // Services exist but all are auto-mode with no rule → the rule IS the
          // path to live here (auto-only with no rule is genuinely not_ready).
          missingSteps.push({ id: 'set_hours', label: 'Set availability hours', cta: CTA_SET_HOURS });
        }
      }
      if (!bookingTemplateActive) {
        missingSteps.push({
          id: 'enable_booking_skill',
          label: 'Give this bot the booking skill',
          cta: CTA_ENABLE_BOOKING_SKILL,
        });
      }
      detail.willAutoConfirm = false;
      return [{ capability: 'booking', state: 'not_ready', missingSteps, attention: undefined, detail }];
    }

    // ── live ──────────────────────────────────────────────────────────────
    // Auto-confirm enrichment is SCOPED to bots that HAVE an auto service. A
    // request-only-ONLY bot is live with willAutoConfirm:false and NO
    // calendar/sync/hours attention (and no calendar query is made).
    let willAutoConfirm = false;

    if (hasAutoService) {
      // Canonical, server-owned business timezone — never the rule's
      // denormalized (historically browser-derived) copy.
      const today = DateTime.now()
        .setZone(await getBotBusinessTimezone(botId))
        .toFormat('yyyy-MM-dd');
      const effectiveHours = hasEffectiveHours(rule, today);

      const cred = await loadActiveCredential(botId);
      const calendarState: CalendarState = !cred
        ? 'none'
        : cred.reauthRequired
          ? 'reauth_required'
          : 'healthy';
      // Read calendarSync PURELY from the once-resolved entitlements (Decision 3) —
      // do NOT call isCalendarSyncAllowed() (it re-resolves + swallows failures).
      const syncAllowed = ctx.entitlements.features.calendarSync === true;

      detail.calendar = { state: calendarState, provider: cred?.provider };
      willAutoConfirm = effectiveHours && calendarState === 'healthy' && syncAllowed;

      // Auto-confirm BLOCKERS are non-blocking attention, never missingSteps
      // (booking is already live as request-capture).
      if (calendarState === 'none') {
        attention.push({
          code: 'calendar_not_connected',
          label: 'Connect a calendar to auto-confirm bookings',
          cta: CTA_CONNECT_CAL,
        });
      } else if (calendarState === 'reauth_required') {
        attention.push({
          code: 'calendar_reauth_required',
          label: 'Reconnect your calendar to auto-confirm bookings',
          cta: CTA_RECONNECT_CAL,
        });
      } else if (!syncAllowed) {
        // Healthy credential but sync disabled by plan — will not actually sync.
        attention.push({
          code: 'calendar_sync_disabled',
          label: 'Calendar connected but sync disabled (plan)',
        });
      }

      // The "set hours" attention is suppressed ONLY in always_open mode; a
      // business_hours rule with empty/malformed weeklyHours (and no upcoming
      // open override) still gets it.
      if (!effectiveHours && rule?.availabilityMode !== 'always_open') {
        attention.push({
          code: 'availability_hours_missing',
          label: 'Set availability hours to auto-confirm bookings',
          cta: CTA_SET_HOURS,
        });
      }
    }

    detail.willAutoConfirm = willAutoConfirm;

    return [
      {
        capability: 'booking',
        state: 'live',
        missingSteps: [],
        attention: attention.length ? attention : undefined,
        detail,
      },
    ];
  },
};

registerCapability(bookingReadiness);
