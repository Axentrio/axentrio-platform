/**
 * Copilot tool: getOpeningHours
 *
 * Opening hours live on the bot, not in the first-run wizard. Without this
 * tool the assistant only has `getSetupProgress`, so "what are my opening
 * hours?" becomes "you have not finished setup" even when the weekly grid
 * is already saved.
 *
 * Spoken hours (`Bot.settings.businessHours`) win when they are enabled.
 * An explicit disable is a decision: the owner asked the bot not to mention
 * hours, so we do not fall through to the booking rule. The AvailabilityRule
 * is only a fallback when spoken hours were never set.
 *
 * Returns a compact weekly string — no addresses, no bot names, no prompt
 * content (invariant #8).
 */
import { IsNull } from 'typeorm';
import { Bot } from '../../database/entities/Bot';
import { AvailabilityRule, type Weekday } from '../../database/entities/AvailabilityRule';
import {
  formatBusinessHoursForPlaceholder,
  isBusinessHoursConfigured,
  type BusinessHours,
} from '../../utils/format-business-hours';
import type { CopilotTool, CopilotToolContext } from './types';

export type OpeningHoursSource = 'configured' | 'always_on';

export interface OpeningHoursResult {
  source: OpeningHoursSource;
  hours: string | null;
  timezone: string | null;
}

const WEEKDAY_FROM_SHORT: Record<Weekday, string> = {
  mon: 'monday',
  tue: 'tuesday',
  wed: 'wednesday',
  thu: 'thursday',
  fri: 'friday',
  sat: 'saturday',
  sun: 'sunday',
};

export const getOpeningHours: CopilotTool<Record<string, never>, OpeningHoursResult> = {
  name: 'getOpeningHours',
  description:
    "Return the current tenant's ANCHOR bot opening hours as they are configured right now. source=configured with a compact weekly string (e.g. 'Mon 09:00–17:00, Tue closed') when spoken hours are enabled, or when spoken hours were never set and a booking AvailabilityRule exists. source=always_on and hours=null when the owner switched spoken hours off, or when nothing is configured — that is not the same as unfinished setup. Call this for ANY question about opening hours, business hours, or when the business is open. Do not infer hours from getSetupProgress.",
  parameters: { type: 'object', properties: {}, additionalProperties: false },

  async execute(_args, ctx: CopilotToolContext): Promise<OpeningHoursResult> {
    const bot = await ctx.manager.findOne(Bot, {
      where: { tenantId: ctx.tenantId, isDefault: true, deletedAt: IsNull() },
      select: ['id', 'settings', 'businessTimezone'],
    });
    if (!bot) {
      return { source: 'always_on', hours: null, timezone: null };
    }

    const timezone = bot.businessTimezone || 'Europe/Brussels';
    const spoken = bot.settings?.businessHours;
    if (isBusinessHoursConfigured(spoken)) {
      const hours = formatBusinessHoursForPlaceholder(spoken, new Date(), timezone);
      return { source: 'configured', hours: hours || null, timezone };
    }
    if (spoken && spoken.enabled === false) {
      return { source: 'always_on', hours: null, timezone };
    }

    const rule = await ctx.manager.findOne(AvailabilityRule, {
      where: { tenantId: ctx.tenantId, botId: bot.id },
    });
    if (!rule) {
      return { source: 'always_on', hours: null, timezone };
    }
    if (rule.availabilityMode === 'always_open') {
      return { source: 'configured', hours: 'open 24/7', timezone: rule.timezone || timezone };
    }

    const hours = formatBusinessHoursForPlaceholder(
      availabilityRuleToSpokenHours(rule),
      new Date(),
      rule.timezone || timezone,
    );
    return {
      source: 'configured',
      hours: hours || null,
      timezone: rule.timezone || timezone,
    };
  },
};

function availabilityRuleToSpokenHours(rule: AvailabilityRule): BusinessHours {
  const schedule = (Object.keys(WEEKDAY_FROM_SHORT) as Weekday[]).map((short) => {
    const day = WEEKDAY_FROM_SHORT[short];
    const windows = rule.weeklyHours?.[short] ?? [];
    const first = windows[0];
    if (!first || !first.start || !first.end) {
      return { day, open: '', close: '', closed: true };
    }
    return { day, open: first.start, close: first.end, closed: false };
  });
  return {
    enabled: true,
    timezone: rule.timezone,
    schedule,
    dateOverrides: rule.dateOverrides,
  };
}
