/**
 * Live smoke: policy `not_allowed` reschedule/cancel must refuse without offering a human.
 *
 * Usage (local):
 *   cd api && npm run smoke:not-allowed-handoff
 *
 * Usage (prod DB + LLM via Railway env):
 *   cd api && railway service chatbot-api && railway run -- npx ts-node --transpile-only scripts/smoke-not-allowed-no-handoff.ts
 *
 * Usage (prod VPS env):
 *   PROD_SSH_HOST=deploy@<prod-ip> scripts/prod-env.sh npx tsx scripts/smoke-not-allowed-no-handoff.ts
 *
 * Env:
 *   SMOKE_BOOKING_ID=<uuid>        booking on a not_allowed service; else auto-discover
 *   SMOKE_SEED=1                   temporarily set rescheduleMode=not_allowed on the service (restored in finally)
 *   SMOKE_SKIP_E2E=1               skip tool execute against live DB
 *   SMOKE_SKIP_CONVERSATION=1      skip live AgentService conversation turn
 */
import 'reflect-metadata';
import { initializeDatabase, AppDataSource } from '../src/database/data-source';
import { initializeRedis, getRedisClient } from '../src/config/redis';
import { Booking } from '../src/database/entities/Booking';
import { ServiceType } from '../src/database/entities/ServiceType';
import { ChatSession } from '../src/database/entities/ChatSession';
import { Message } from '../src/database/entities/Message';
import { Participant } from '../src/database/entities/Participant';
import { HandoffRequest } from '../src/database/entities/HandoffRequest';
import { Tenant } from '../src/database/entities/Tenant';
import { logger } from '../src/utils/logger';
import { customerChangeNotAllowedError } from '../src/booking/customer-change-policy';
import { buildServicesSection } from '../src/modules/booking.module';
import { handoffSkill } from '../src/modules/catalog-skills';
import { ListBookingsTool, RescheduleBookingTool, CancelBookingTool } from '../src/agent/tools/booking.tool';
import type { ToolContext } from '../src/agent/tool-adapter';
import { AgentService } from '../src/agent/agent.service';
import { ToolRegistry } from '../src/agent/tool-registry';
import { PromptBuilder } from '../src/agent/prompt-builder';
import { MeteringService } from '../src/agent/metering.service';
import { TraceLogger } from '../src/agent/trace-logger';
import { forwardMessageToN8n, initializeAgentService } from '../src/services/message-forwarding.service';
import { decrypt } from '../src/utils/encryption';

const NO_HANDOFF = /do not offer to connect them with the team/i;
const INSIST_LADDER = /keep insisting after you have explained the cutoff/i;
const HANDOFF_OFFER =
  /(wil je dat ik (je )?verbind|zou je (willen )?dat ik (je )?(verbind|doorverbind)|connect you with (a |the )?(human|person|team|someone)|would you like (me )?to connect you|spreek.*(medewerker|iemand)|human agent|met (ons|het) team spreken)/i;

function pass(label: string, detail?: string): void {
  console.log(`✓ ${label}${detail ? ` — ${detail}` : ''}`);
}

function fail(label: string, detail?: string): never {
  console.error(`✗ ${label}${detail ? ` — ${detail}` : ''}`);
  process.exit(1);
}

function isWaterFixTenant(name: string | undefined | null): boolean {
  return !!name && /waterfix/i.test(name);
}

function assertPolicyRefusal(text: string, label: string): void {
  if (!NO_HANDOFF.test(text)) fail(`${label}: missing no-handoff clause`, text.slice(0, 240));
  if (!/not a request for a person/i.test(text)) fail(`${label}: missing insist-is-not-handoff`, text.slice(0, 240));
  if (INSIST_LADDER.test(text)) fail(`${label}: cutoff insist ladder leaked into policy path`, text.slice(0, 240));
  pass(label);
}

function makeCtx(sessionId: string, tenantId: string): ToolContext {
  return {
    tenantId,
    sessionId,
    runId: 'smoke-run',
    channel: 'widget',
    toolsCalledThisTurn: [],
    dataSource: AppDataSource,
    conversationHistory: [{ role: 'user', content: 'ik wil mijn afspraak verzetten' }],
  };
}

async function assertTenantAllowed(tenantId: string, label: string): Promise<Tenant> {
  const tenant = await AppDataSource.getRepository(Tenant).findOne({ where: { id: tenantId } });
  if (!tenant) fail(`${label}: tenant missing`, tenantId);
  if (isWaterFixTenant(tenant.name)) fail(`${label}: refusing WaterFix tenant`, tenant.name);
  return tenant;
}

type PolicyForbiddenFixture = {
  booking: Booking;
  service: ServiceType;
  tenant: Tenant;
  kind: 'reschedule' | 'cancel';
  restore?: () => Promise<void>;
};

async function pickConfirmedBookingForSeed(): Promise<Booking> {
  const id = process.env.SMOKE_BOOKING_ID?.trim();
  if (id) {
    const booking = await AppDataSource.getRepository(Booking).findOne({ where: { id } });
    if (!booking) fail('SMOKE_BOOKING_ID not found', id);
    if (booking.status !== 'confirmed') fail('SMOKE_BOOKING_ID is not confirmed', booking.status);
    if (!booking.sessionId) fail('SMOKE_BOOKING_ID has no session_id');
    return booking;
  }

  const rows: Array<{ id: string }> = await AppDataSource.query(
    `
      SELECT b.id
      FROM chatbot_bookings b
      JOIN tenants t ON t.id = b.tenant_id
      WHERE b.status = $1
        AND b.session_id IS NOT NULL
        AND lower(t.name) NOT LIKE $2
      ORDER BY b.created_at DESC
      LIMIT 1
    `,
    ['confirmed', '%waterfix%'],
  );
  if (!rows[0]?.id) fail('SMOKE_SEED: no confirmed booking with session on a non-WaterFix tenant — set SMOKE_BOOKING_ID');
  return AppDataSource.getRepository(Booking).findOneOrFail({ where: { id: rows[0].id } });
}

async function seedTemporaryNotAllowed(): Promise<PolicyForbiddenFixture> {
  const booking = await pickConfirmedBookingForSeed();
  const service = await AppDataSource.getRepository(ServiceType).findOne({ where: { id: booking.eventTypeId ?? '' } });
  if (!service) fail('SMOKE_SEED: service missing for booking', booking.eventTypeId ?? 'null');
  const tenant = await assertTenantAllowed(service.tenantId, 'SMOKE_SEED');

  const originalRescheduleMode = service.rescheduleMode;
  const originalCancelMode = service.cancelMode;
  const kind: 'reschedule' | 'cancel' =
    originalRescheduleMode === 'not_allowed' ? 'reschedule' : originalCancelMode === 'not_allowed' ? 'cancel' : 'reschedule';

  let seeded = false;
  if (kind === 'reschedule' && service.rescheduleMode !== 'not_allowed') {
    service.rescheduleMode = 'not_allowed';
    await AppDataSource.getRepository(ServiceType).save(service);
    seeded = true;
  } else if (kind === 'cancel' && service.cancelMode !== 'not_allowed') {
    service.cancelMode = 'not_allowed';
    await AppDataSource.getRepository(ServiceType).save(service);
    seeded = true;
  }

  return {
    booking,
    service,
    tenant,
    kind,
    restore: seeded
      ? async () => {
          await AppDataSource.getRepository(ServiceType).update(service.id, {
            rescheduleMode: originalRescheduleMode,
            cancelMode: originalCancelMode,
          });
        }
      : undefined,
  };
}

async function pickPolicyForbiddenBooking(): Promise<PolicyForbiddenFixture> {
  if (process.env.SMOKE_SEED === '1') return seedTemporaryNotAllowed();
  const id = process.env.SMOKE_BOOKING_ID?.trim();
  if (id) {
    const booking = await AppDataSource.getRepository(Booking).findOne({ where: { id } });
    if (!booking) fail('SMOKE_BOOKING_ID not found', id);
    const service = await AppDataSource.getRepository(ServiceType).findOne({ where: { id: booking.eventTypeId } });
    if (!service) fail('Service missing for SMOKE_BOOKING_ID', booking.eventTypeId);
    const tenant = await assertTenantAllowed(service.tenantId, 'SMOKE_BOOKING_ID');
    if (service.rescheduleMode === 'not_allowed') return { booking, service, tenant, kind: 'reschedule' };
    if (service.cancelMode === 'not_allowed') return { booking, service, tenant, kind: 'cancel' };
    fail(
      'SMOKE_BOOKING_ID service is not policy not_allowed',
      `${service.name} reschedule=${service.rescheduleMode} cancel=${service.cancelMode}`,
    );
  }

  const services = await AppDataSource.getRepository(ServiceType).find({
    where: [{ rescheduleMode: 'not_allowed' as const }, { cancelMode: 'not_allowed' as const }],
    order: { updatedAt: 'DESC' },
    take: 50,
  });
  for (const service of services) {
    const tenant = await AppDataSource.getRepository(Tenant).findOne({ where: { id: service.tenantId } });
    if (isWaterFixTenant(tenant?.name)) continue;

    const booking = await AppDataSource.getRepository(Booking).findOne({
      where: { eventTypeId: service.id, status: 'confirmed' as const },
      order: { startUtc: 'DESC' },
    });
    if (!booking?.sessionId) continue;
    const kind = service.rescheduleMode === 'not_allowed' ? 'reschedule' : 'cancel';
    return { booking, service, tenant: tenant!, kind };
  }
  fail('No confirmed booking on a policy not_allowed service (non-WaterFix) — set SMOKE_BOOKING_ID');
}

function assertStaticSeams(): void {
  console.log('\n--- static prompt / error seams ---');
  assertPolicyRefusal(customerChangeNotAllowedError(undefined, 'cancel').message, 'customerChangeNotAllowedError(cancel)');

  const servicesPrompt = buildServicesSection([
    { id: 'svc-smoke', name: 'Smoke service', rescheduleMode: 'not_allowed', cancelMode: 'request' } as ServiceType,
  ])!;
  if (!NO_HANDOFF.test(servicesPrompt)) fail('SERVICES not_allowed line missing no-handoff');
  if (!/Insisting on the move or cancel is not a request for a person/.test(servicesPrompt)) {
    fail('SERVICES not_allowed line missing insist-is-not-handoff');
  }
  pass('buildServicesSection not_allowed customer-changes line');

  const handoff = handoffSkill.defaultProse ?? '';
  if (/cannot complete a request they made/i.test(handoff)) fail('handoffSkill still triggers on incomplete requests');
  if (!/forbids reschedule or cancel is not a reason to hand off/i.test(handoff)) fail('handoffSkill missing booking-policy carve-out');
  pass('handoffSkill.defaultProse');
}

async function assertToolE2E(booking: Booking, tenantId: string, kind: 'reschedule' | 'cancel'): Promise<void> {
  if (process.env.SMOKE_SKIP_E2E === '1') {
    console.warn('\n⚠ SMOKE_SKIP_E2E=1 — skipping live tool execute');
    return;
  }

  console.log('\n--- live tool execute ---');
  if (!booking.sessionId) fail('booking has no session_id');
  const ctx = makeCtx(booking.sessionId, tenantId);

  const list = await new ListBookingsTool().execute({}, ctx);
  if (!list.success) fail('list_bookings failed', list.error);
  const guidance = (list.data as { guidance?: string } | undefined)?.guidance ?? '';
  if (!guidance) fail('list_bookings returned no guidance for not_allowed booking');
  assertPolicyRefusal(guidance, 'list_bookings guidance');

  if (kind === 'reschedule') {
    const result = await new RescheduleBookingTool().execute(
      { bookingId: booking.id, newStartTime: booking.startUtc.toISOString() },
      ctx,
    );
    if (result.success) fail('reschedule_booking should refuse policy not_allowed');
    assertPolicyRefusal(result.error ?? '', 'reschedule_booking CHANGE_NOT_ALLOWED');
  } else {
    const result = await new CancelBookingTool().execute({ bookingId: booking.id }, ctx);
    if (result.success) fail('cancel_booking should refuse policy not_allowed');
    assertPolicyRefusal(result.error ?? '', 'cancel_booking CHANGE_NOT_ALLOWED');
  }
}

async function assertConversationE2E(
  booking: Booking,
  tenant: Tenant,
  kind: 'reschedule' | 'cancel',
): Promise<void> {
  if (process.env.SMOKE_SKIP_CONVERSATION === '1') {
    console.warn('\n⚠ SMOKE_SKIP_CONVERSATION=1 — skipping live conversation');
    return;
  }
  if (!process.env.OPENAI_API_KEY) fail('OPENAI_API_KEY required for live conversation smoke');

  console.log('\n--- live conversation (AgentService) ---');
  process.env.AGENT_BURST_DEBOUNCE_MS = '0';

  const redis = getRedisClient();
  const agentSvc = new AgentService(
    new ToolRegistry(),
    new PromptBuilder(),
    new MeteringService(redis as never),
    new TraceLogger(),
  );
  initializeAgentService(agentSvc);

  const session = await AppDataSource.getRepository(ChatSession).findOne({ where: { id: booking.sessionId } });
  if (!session) fail('booking session missing', booking.sessionId);
  if (session.status !== 'bot' && session.status !== 'waiting') {
    fail('session not bot-owned — pick another SMOKE_BOOKING_ID', session.status);
  }

  const handoffsBefore = await AppDataSource.getRepository(HandoffRequest).count({
    where: { sessionId: session.id, status: 'requested' as const },
  });

  let user = await AppDataSource.getRepository(Participant).findOne({
    where: { sessionId: session.id, type: 'user' as const },
  });
  if (!user) {
    user = await AppDataSource.getRepository(Participant).save(
      AppDataSource.getRepository(Participant).create({
        sessionId: session.id,
        type: 'user',
        name: 'Smoke visitor',
        joinedAt: new Date(),
      }),
    );
  }

  const userText =
    kind === 'reschedule'
      ? 'Kan ik mijn afspraak verzetten naar volgende week?'
      : 'Ik wil mijn afspraak annuleren.';

  const msg = await AppDataSource.getRepository(Message).save(
    AppDataSource.getRepository(Message).create({
      sessionId: session.id,
      tenantId: session.tenantId,

[You have received this identical output 3 times. Re-reading 'api/scripts/smoke-not-allowed-no-handoff.ts:raw' will not change it — use a narrower selector (path:A-B), or proceed with the edit.]

[Showing lines 1-300 of 367. Use :301 to continue]