import type { Request, Response } from 'express';
import type { BotSettings } from '../database/entities/Bot';
import {
  getAnchorBotConfig,
  updateAnchorBotSettings,
} from '../services/bot-config.service';
import { updateWidgetAppearanceSchema } from '../schemas/widget-appearance.schema';
import { sendSuccess } from '../utils/response';

type AppearanceResponse = {
  primaryColor: string | null;
  avatarUrl: string | null;
  launcherPosition: 'bottom-right' | 'bottom-left';
  launcherLabel: string | null;
};

function toResponse(settings: BotSettings): AppearanceResponse {
  const theme = settings.theme ?? {};
  const widget = settings.widget ?? {};
  return {
    primaryColor: theme.primaryColor ?? null,
    avatarUrl: widget.avatarUrl ?? null,
    launcherPosition: widget.launcherPosition ?? 'bottom-right',
    launcherLabel: widget.launcherLabel ?? null,
  };
}

export async function getWidgetAppearance(req: Request, res: Response) {
  const tenantId = (req as any).tenantId as string;
  // Multi-bot Phase 4 (#16d): read from anchor Bot.settings, not Tenant.settings.
  const { settings } = await getAnchorBotConfig(tenantId);
  sendSuccess(res, toResponse(settings));
}

export async function updateWidgetAppearance(req: Request, res: Response) {
  const tenantId = (req as any).tenantId as string;
  const data = updateWidgetAppearanceSchema.parse(req.body);

  // Read current anchor settings so we can do per-key presence updates.
  // `updateAnchorBotSettings` already does section-level deep merge, but we
  // still need to compute `null` semantics for empty-string normalization
  // before handing the patch over.
  const { settings: existing } = await getAnchorBotConfig(tenantId);
  const existingTheme = (existing.theme ?? {}) as NonNullable<BotSettings['theme']>;
  const existingWidget = (existing.widget ?? {}) as NonNullable<BotSettings['widget']>;

  const themePatch: NonNullable<BotSettings['theme']> = { ...existingTheme };
  const widgetPatch: NonNullable<BotSettings['widget']> = { ...existingWidget };

  if (Object.prototype.hasOwnProperty.call(data, 'primaryColor') && data.primaryColor !== undefined) {
    themePatch.primaryColor = data.primaryColor;
  }
  if (Object.prototype.hasOwnProperty.call(data, 'avatarUrl')) {
    widgetPatch.avatarUrl = data.avatarUrl === '' ? null : data.avatarUrl ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(data, 'launcherPosition') && data.launcherPosition !== undefined) {
    widgetPatch.launcherPosition = data.launcherPosition;
  }
  if (Object.prototype.hasOwnProperty.call(data, 'launcherLabel')) {
    widgetPatch.launcherLabel = data.launcherLabel === '' ? null : data.launcherLabel ?? null;
  }

  const updated = await updateAnchorBotSettings(tenantId, {
    theme: themePatch,
    widget: widgetPatch,
  });

  sendSuccess(res, toResponse(updated.settings ?? {}));
}
