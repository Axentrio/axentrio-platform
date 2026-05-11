import type { Request, Response } from 'express';
import { AppDataSource } from '../database/data-source';
import { Tenant } from '../database/entities/Tenant';
import { updateWidgetAppearanceSchema } from '../schemas/widget-appearance.schema';

type AppearanceResponse = {
  primaryColor: string | null;
  avatarUrl: string | null;
  launcherPosition: 'bottom-right' | 'bottom-left';
  launcherLabel: string | null;
};

function toResponse(tenant: Tenant): AppearanceResponse {
  const theme = (tenant.settings?.theme ?? {}) as { primaryColor?: string };
  const widget = (tenant.settings?.widget ?? {}) as {
    avatarUrl?: string | null;
    launcherPosition?: 'bottom-right' | 'bottom-left';
    launcherLabel?: string | null;
  };
  return {
    primaryColor: theme.primaryColor ?? null,
    avatarUrl: widget.avatarUrl ?? null,
    launcherPosition: widget.launcherPosition ?? 'bottom-right',
    launcherLabel: widget.launcherLabel ?? null,
  };
}

export async function getWidgetAppearance(req: Request, res: Response) {
  const tenantId = (req as any).tenantId as string;
  const tenantRepo = AppDataSource.getRepository(Tenant);
  const tenant = await tenantRepo.findOneOrFail({ where: { id: tenantId } });
  res.json(toResponse(tenant));
}

export async function updateWidgetAppearance(req: Request, res: Response) {
  const tenantId = (req as any).tenantId as string;
  const data = updateWidgetAppearanceSchema.parse(req.body);

  const tenantRepo = AppDataSource.getRepository(Tenant);
  const tenant = await tenantRepo.findOneOrFail({ where: { id: tenantId } });

  const existingTheme = (tenant.settings?.theme ?? {}) as Record<string, unknown>;
  const existingWidget = (tenant.settings?.widget ?? {}) as Record<string, unknown>;

  const nextTheme = { ...existingTheme };
  const nextWidget = { ...existingWidget };

  if (Object.prototype.hasOwnProperty.call(data, 'primaryColor') && data.primaryColor !== undefined) {
    nextTheme.primaryColor = data.primaryColor;
  }
  if (Object.prototype.hasOwnProperty.call(data, 'avatarUrl')) {
    nextWidget.avatarUrl = data.avatarUrl === '' ? null : data.avatarUrl ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(data, 'launcherPosition') && data.launcherPosition !== undefined) {
    nextWidget.launcherPosition = data.launcherPosition;
  }
  if (Object.prototype.hasOwnProperty.call(data, 'launcherLabel')) {
    nextWidget.launcherLabel = data.launcherLabel === '' ? null : data.launcherLabel ?? null;
  }

  tenant.settings = {
    ...(tenant.settings ?? {}),
    theme: nextTheme,
    widget: nextWidget,
  } as Tenant['settings'];

  await tenantRepo.save(tenant);

  res.json(toResponse(tenant));
}
