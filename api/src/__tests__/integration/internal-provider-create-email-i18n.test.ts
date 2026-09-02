/**
 * Proves the provider's confirmed-booking email i18n stack end-to-end:
 *   audienceLanguages → getBookingCopy → buildCustomerEventDescription / ownerDetail → sendBookingEmail
 * inside mirrorCreatedBooking, against real Postgres.
 *
 * The local smoke script (`scripts/smoke-booking-email-language.ts`) often cannot reach this path:
 * when Google free/busy is unavailable it downgrades to request mode and the script calls
 * sendBookingEmail by hand — that fallback never exercises mirrorCreatedBooking wiring.
 *
 * Only external services are doubled: Google free/busy, the booking-copy translation LLM,
 * and the Resend transport. Everything inside the booking path — audienceLanguages,
 * getBookingCopy's validate/merge/cache, buildCustomerEventDescription, ownerDetail,
 * sendBookingEmail and emailDeliveryService — is the real implementation.
 */
import { createHash, randomBytes } from 'crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const getGoogleBusyForBot = vi.fn().mockResolvedValue([]);

vi.mock('../../integrations/google/google-calendar.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../integrations/google/google-calendar.service')>();
  return {
    ...actual,
    getGoogleBusyForBot: (...args: unknown[]) => getGoogleBusyForBot(...args),
  };
});

/**
 * Deterministic stand-in for the booking-copy translator. Real getBookingCopy logic
 * (placeholder validation, merge, cache write) still runs on this output.
 */
const NL_PATCH: Record<string, string> = {
  'customer.subject_confirmed': 'Bevestigd: {summary}',
  'customer.lead_confirmed': 'Uw afspraak is bevestigd.',
};
const FR_PATCH: Record<string, string> = {
  'owner.subject_new': 'Nouveau : {summary}',
};

const copyChat = vi.fn(async (messages: Array<{ role: string; content: string }>) => {
  const system = messages.find((m) => m.role === 'system')?.content ?? '';
  const lang = /code "([a-z]{2,3})"/.exec(system)?.[1] ?? 'en';
  const english = JSON.parse(messages.find((m) => m.role === 'user')!.content) as Record<string, string>;
  const patch = lang === 'nl' ? NL_PATCH : lang === 'fr' ? FR_PATCH : {};
  return { content: JSON.stringify({ ...english, ...patch }) };
});

vi.mock('../../llm/provider-factory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../llm/provider-factory')>();
  return {
    ...actual,
    getProvider: (opts: { path?: string }) =>
      opts?.path === 'booking_copy' ? { chat: copyChat } : actual.getProvider(opts as never),
  };
});

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('../../automations', () => ({
  getEmailService: () => ({ send }),
  initializeAutomations: vi.fn(),
}));

import { AppDataSource } from '../../database/data-source';
import { AvailabilityRule } from '../../database/entities/AvailabilityRule';
import { CalendarCredential } from '../../database/entities/CalendarCredential';
import { ChatSession } from '../../database/entities/ChatSession';
import { EmailDelivery } from '../../database/entities/EmailDelivery';
import { ServiceType } from '../../database/entities/ServiceType';
import { Booking } from '../../database/entities/Booking';
import type { Bot } from '../../database/entities/Bot';
import type { Tenant } from '../../database/entities/Tenant';
import { InternalProvider } from '../../booking/booking-providers/internal.provider';
import type { BookingContext } from '../../booking/booking-providers/types';
import {
  BOOKING_COPY_EN,
  fill,
  __resetBookingCopyCache,
} from '../../booking/booking-copy';
import { invalidateEntitlements } from '../../billing/entitlements';
import { getRedisClient } from '../../config/redis';
import { createTestTenant, createTestUser, createTestAnchorBot } from '../helpers/factories';

const CATALOG_HASH = createHash('sha256').update(JSON.stringify(BOOKING_COPY_EN)).digest('hex').slice(0, 12);
const OFFERED_START = '2026-06-10T07:00:00.000Z';

let tenant: Tenant;
let bot: Bot;
let ctx: BookingContext;
let serviceId: string;
let ownerEmail: string;

/**
 * A cached translation from an earlier run (possibly from the live model) would shadow
 * the deterministic double, so drop the keys this catalog version owns.
 */
async function clearCachedBookingCopy(langs: string[]): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  await Promise.all(langs.map((lang) => redis.del(`booking-copy:${CATALOG_HASH}:${lang}`)));
}

async function seedCalendarCredential(t: Tenant, botId: string): Promise<void> {
  const repo = AppDataSource.getRepository(CalendarCredential);
  await repo.save(
    repo.create({
      tenantId: t.id,
      botId,
      provider: 'google',
      status: 'active',
      accountEmail: `owner+${botId.slice(0, 6)}@example.com`,
      accessTokenEnc: 'enc:test',
      refreshTokenEnc: 'enc:test',
      calendarId: 'primary',
      tokenExpiry: new Date(Date.now() + 3_600_000),
    }),
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  send.mockResolvedValue({ success: true, messageId: 'mirror-create-1' });
  getGoogleBusyForBot.mockResolvedValue([]);
  __resetBookingCopyCache();

  await clearCachedBookingCopy(['nl', 'fr']);

  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-06-05T00:00:00Z'));

  tenant = await createTestTenant({ tier: 'pro' });
  ownerEmail = `owner-${randomBytes(4).toString('hex')}@example.test`;
  await createTestUser(tenant.id, { role: 'admin', email: ownerEmail, locale: 'fr' });

  bot = await createTestAnchorBot(tenant, {
    settings: {
      ai: {
        enabled: true,
        supportEmail: ownerEmail,
      },
    } as Bot['settings'],
  });

  await seedCalendarCredential(tenant, bot.id);

  const rules = AppDataSource.getRepository(AvailabilityRule);
  await rules.save(
    rules.create({
      tenantId: tenant.id,
      botId: bot.id,
      timezone: 'Europe/Brussels',
      availabilityMode: 'always_open',
    }),
  );

  const services = AppDataSource.getRepository(ServiceType);
  const service = await services.save(
    services.create({
      tenantId: tenant.id,
      botId: bot.id,
      name: 'Integratie consult',
      slug: `svc-${randomBytes(4).toString('hex')}`,
      durationMin: 60,
      isActive: true,
      onlineBookable: true,
      bookingMode: 'auto',
      customerEmailRequired: true,
    }),
  );
  serviceId = service.id;

  const sessions = AppDataSource.getRepository(ChatSession);
  const session = await sessions.save(
    sessions.create({
      tenantId: tenant.id,
      botId: bot.id,
      visitorId: `visitor-${randomBytes(4).toString('hex')}`,
      status: 'active',
      source: 'widget',
      channel: 'widget',
      messageCount: 0,
      unreadCount: 0,
      startedAt: new Date(),
      lastActivityAt: new Date(),
    }),
  );

  ctx = { session, tenant, bot, botSettings: bot.settings };
  invalidateEntitlements(tenant.id);
});

afterEach(() => vi.useRealTimers());

describe('InternalProvider.createBooking · mirrorCreatedBooking email i18n', () => {
  it('stores customer_language and ledgers localized customer + owner booking_email rows', async () => {
    const attendeeEmail = `customer-${randomBytes(4).toString('hex')}@example.test`;
    const provider = new InternalProvider();

    const result = await provider.createBooking(
      ctx,
      `idem-i18n-${randomBytes(4).toString('hex')}`,
      OFFERED_START,
      { name: 'Marie', email: attendeeEmail },
      'integration mirror path',
      serviceId,
      undefined,
      { language: 'nl-BE' },
    );

    expect(result.success).toBe(true);
    expect(result.requested).toBeFalsy();
    const bookingId = result.booking?.id;
    expect(bookingId).toBeTruthy();

    const row = await AppDataSource.getRepository(Booking).findOneByOrFail({ id: bookingId! });
    expect(row.customerLanguage).toBe('nl');
    expect(row.status).toBe('confirmed');

    expect(getGoogleBusyForBot).toHaveBeenCalled();

    const deliveries = await AppDataSource.getRepository(EmailDelivery).find({
      where: { relatedId: bookingId!, kind: 'booking_email' },
      order: { createdAt: 'ASC' },
    });
    expect(deliveries.length).toBeGreaterThanOrEqual(2);

    const customerDelivery = deliveries.find(
      (d) => d.recipientEmail.toLowerCase() === attendeeEmail.toLowerCase(),
    );
    expect(customerDelivery).toBeDefined();
    expect(customerDelivery!.subject).toBe(
      fill(NL_PATCH['customer.subject_confirmed']!, { summary: 'Integratie consult' }),
    );
    expect(customerDelivery!.payload?.body).toContain(NL_PATCH['customer.lead_confirmed']!);
    // The customer copy must not be the English catalog: proves audienceLanguages resolved
    // the chat language rather than defaulting.
    expect(customerDelivery!.payload?.body).not.toContain(BOOKING_COPY_EN['customer.lead_confirmed']);

    const ownerDelivery = deliveries.find(
      (d) => d.recipientEmail.toLowerCase() === ownerEmail.toLowerCase(),
    );
    expect(ownerDelivery).toBeDefined();
    expect(ownerDelivery!.subject).toBe(
      fill(FR_PATCH['owner.subject_new']!, { summary: 'Integratie consult' }),
    );
    // Owner gets the portal locale (fr), not the customer's chat language (nl).
    expect(ownerDelivery!.subject).not.toBe(
      fill(NL_PATCH['customer.subject_confirmed']!, { summary: 'Integratie consult' }),
    );

    expect(send).toHaveBeenCalled();
    // Real getBookingCopy ran for both audiences through the translator double.
    expect(copyChat).toHaveBeenCalled();
  });
});
