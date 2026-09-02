import { AppDataSource } from '../database/data-source';
import { Tenant } from '../database/entities/Tenant';
import { User } from '../database/entities/User';
import type { BotSettings } from '../database/entities/Bot';
import { resolveBotLanguage } from '../config/bot-language';
import { SUPPORTED_LOCALES, type SupportedLocale } from '../schemas/user.schema';
import { logger } from '../utils/logger';

const languageDisplayNames =
  typeof Intl !== 'undefined' && typeof Intl.DisplayNames === 'function'
    ? new Intl.DisplayNames(['en'], { type: 'language' })
    : null;

/** True when Intl recognises the subtag (not an opaque echo like "not" for junk input). */
function isRecognizedLanguageSubtag(base: string): boolean {
  try {
    const [canonical] = Intl.getCanonicalLocales(base);
    if (!canonical) return false;
    if (!languageDisplayNames) return true;
    const canonicalBase = canonical.toLowerCase().split('-')[0];
    const label = languageDisplayNames.of(base) ?? languageDisplayNames.of(canonicalBase);
    if (!label) return false;
    return label.toLowerCase() !== base.toLowerCase();
  } catch {
    return false;
  }
}

/** 'nl-BE' -> 'nl', 'FR' -> 'fr'. Null when unknown or not a recognised ISO 639 subtag. */
export function normalizeLanguageCode(input: unknown): string | null {
  if (input == null) return null;
  const base = String(input).trim().toLowerCase().split(/[-_]/)[0];
  if (!/^[a-z]{2,3}$/.test(base)) return null;
  return isRecognizedLanguageSubtag(base) ? base : null;
}

function isSupportedLocale(value: string | null | undefined): value is SupportedLocale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/** Stored chat language, else the bot's default reply language. Never null. */
export function customerLanguageFor(
  row: { customerLanguage?: string | null },
  botSettings: Pick<BotSettings, 'ai'>,
): string {
  return normalizeLanguageCode(row.customerLanguage) ?? resolveBotLanguage(botSettings.ai?.language);
}

/** Portal language of the person who reads the owner mailbox. */
export async function resolveOwnerLanguage(tenantId: string, supportEmail?: string | null): Promise<string> {
  try {
    const userRepo = AppDataSource.getRepository(User);
    const trimmed = supportEmail?.trim();
    if (trimmed) {
      const match = await userRepo
        .createQueryBuilder('user')
        .where('user.tenant_id = :tenantId', { tenantId })
        .andWhere('LOWER(user.email) = LOWER(:email)', { email: trimmed })
        .andWhere('user.is_active = true')
        .andWhere('user.deleted_at IS NULL')
        .getOne();
      if (match?.locale && isSupportedLocale(match.locale)) return match.locale;
    }

    const admin = await userRepo
      .createQueryBuilder('user')
      .where('user.tenant_id = :tenantId', { tenantId })
      .andWhere('user.role IN (:...roles)', { roles: ['admin', 'super_admin'] })
      .andWhere('user.is_active = true')
      .andWhere('user.deleted_at IS NULL')
      .orderBy('user.created_at', 'ASC')
      .limit(1)
      .getOne();
    if (admin?.locale && isSupportedLocale(admin.locale)) return admin.locale;

    const tenant = await AppDataSource.getRepository(Tenant).findOne({ where: { id: tenantId } });
    const onboardingLang = tenant?.settings?.onboarding?.language;
    if (onboardingLang && isSupportedLocale(onboardingLang)) return onboardingLang;

    return 'en';
  } catch (err) {
    logger.warn('[booking-language] resolveOwnerLanguage failed — using English', {
      tenantId,
      err: err instanceof Error ? err.message : String(err),
    });
    return 'en';
  }
}
