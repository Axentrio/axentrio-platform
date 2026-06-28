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
  type WeeklyHours,
  type TimeWindow,
} from '../../database/entities/AvailabilityRule';
import { BotTemplateVersion } from '../../database/entities/BotTemplateVersion';
import { loadActiveCredential } from '../../scheduler/calendar-provider';
import { isBookingConfigured } from '../../scheduler/booking-readiness';
import { resolveBoundTemplates } from '../../templates/template-resolver';
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
    (o) => o.date >= today && !o.closed && Array.isArray(o.windows) && o.windows.some(isValidWindow),
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

/**
 * Does any resolved bound template expect the booking module? Computed from the
 * RESOLVED bound version(s) (`resolveBoundTemplates` → the pinned/latest version
 * each binding actually uses), NOT a union across all published versions — an
 * older published version expecting booking while the resolved one does not must
 * NOT falsely mark the nudge active.
 */
async function resolvedBookingTemplateActive(bot: ReadinessBotCtx['bot']): Promise<boolean> {
  const resolved = await resolveBoundTemplates(bot);
  const pairs = resolved
    .filter((r) => r.templateId != null && r.resolvedVersion != null)
    .map((r) => ({ templateId: r.templateId as string, resolvedVersion: r.resolvedVersion as number }));
  if (pairs.length === 0) return false;
  const repo = AppDataSource.getRepository(BotTemplateVersion);
  for (const { templateId, resolvedVersion } of pairs) {
    const row = await repo.findOne({
      where: { templateId, version: resolvedVersion },
      select: { expectedModules: true },
    });
    if ((row?.expectedModules ?? []).includes('booking')) return true;
  }
  return false;
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
    // select only bookingMode). The gate-vs-catalog onlineBookable asymmetry is a
    // known pre-existing item — readiness mirrors the gate, does not fix it.
    const [services, rule] = await Promise.all([
      AppDataSource.getRepository(ServiceType).find({
        where: { botId, isActive: true, onlineBookable: true },
        select: { id: true, bookingMode: true },
      }),
      AppDataSource.getRepository(AvailabilityRule).findOne({ where: { botId } }),
    ]);

    const hasRule = !!rule;
    const hasAutoService = services.some((s) => s.bookingMode !== 'request');

    // `live` mirrors the runtime gate verbatim (the anti-lying guarantee).
    const live = isBookingConfigured(services, hasRule);

    // The nudge field — computed from the RESOLVED bound version(s) (Decision 4).
    const bookingTemplateActive = await resolvedBookingTemplateActive(ctx.bot);

    const missingSteps: ReadinessResult['missingSteps'] = [];
    const attention: NonNullable<ReadinessResult['attention']> = [];
    const detail: Record<string, unknown> = { bookingTemplateActive };

    if (!live) {
      // not_ready: ordered PATH TO LIVE only.
      if (services.length === 0) {
        missingSteps.push({ id: 'add_service', label: 'Add a bookable service', cta: CTA_ADD_SERVICE });
      } else {
        // Services exist but all are auto-mode with no rule → the rule IS the
        // path to live here (auto-only with no rule is genuinely not_ready).
        missingSteps.push({ id: 'set_hours', label: 'Set availability hours', cta: CTA_SET_HOURS });
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
      const today = DateTime.now()
        .setZone(rule?.timezone || 'UTC')
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
