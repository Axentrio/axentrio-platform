/**
 * Copilot tool: getBusinessHours
 *
 * The assistant had no way to read the tenant's configured opening hours, so
 * "what are my opening hours?" fell through to getSetupProgress and answered
 * from the onboarding wizard state ("setup not complete → none configured")
 * even when hours WERE configured. This reads the actual value.
 *
 * Source of truth is the anchor bot's `settings.businessHours` (BotSettings).
 * Returns the schedule as plain open/close times — operational config the
 * admin owns and is safe to surface (not prompt-adjacent; invariant #8 only
 * hides brand-voice / system-prompt content).
 */
import { IsNull } from 'typeorm';
import { Bot } from '../../database/entities/Bot';
import type { CopilotTool, CopilotToolContext } from './types';

export interface BusinessHoursResult {
  /** TRUE when hours are enabled AND at least one day is open. The answer to
   *  "are my opening hours set up?" — never derive this from setup progress. */
  configured: boolean;
  /** The raw enabled flag. FALSE means the bot quotes no hours to visitors. */
  enabled: boolean;
  /** IANA timezone the hours are expressed in, or null when unset. */
  timezone: string | null;
  /** Per-day opening hours. Empty when nothing is configured. */
  schedule: Array<{ day: string; open: string; close: string; closed: boolean }>;
  /** TRUE when closed-day / holiday exceptions sit on top of the weekly schedule. */
  hasDateOverrides: boolean;
}

const EMPTY: BusinessHoursResult = {
  configured: false,
  enabled: false,
  timezone: null,
  schedule: [],
  hasDateOverrides: false,
};

export const getBusinessHours: CopilotTool<Record<string, never>, BusinessHoursResult> = {
  name: 'getBusinessHours',
  description:
    "Return the tenant's configured opening/business hours from the ANCHOR bot: configured, enabled, timezone, a per-day schedule (day, open, close, closed), and hasDateOverrides. This is the ONLY source of truth for opening hours — when asked 'what are my opening hours?' or 'are my hours set up?', call THIS, never infer from getSetupProgress (a skipped or not-yet-reached setup step does NOT mean hours are unset). configured=true means hours are enabled and at least one day is open; report the schedule. configured=false with a non-empty schedule means the hours exist but are turned off. No free-text — times only.",
  parameters: { type: 'object', properties: {}, additionalProperties: false },

  async execute(_args, ctx: CopilotToolContext): Promise<BusinessHoursResult> {
    const bot = await ctx.manager.findOne(Bot, {
      where: { tenantId: ctx.tenantId, isDefault: true, deletedAt: IsNull() },
      select: ['id', 'settings'],
    });

    const bh = bot?.settings?.businessHours;
    if (!bh) return EMPTY;

    const schedule = Array.isArray(bh.schedule)
      ? bh.schedule.map((s) => ({
          day: s.day,
          open: s.open,
          close: s.close,
          closed: s.closed === true,
        }))
      : [];

    return {
      configured: bh.enabled === true && schedule.some((s) => !s.closed),
      enabled: bh.enabled === true,
      timezone:
        typeof bh.timezone === 'string' && bh.timezone.trim().length > 0 ? bh.timezone : null,
      schedule,
      hasDateOverrides: Array.isArray(bh.dateOverrides) && bh.dateOverrides.length > 0,
    };
  },
};
