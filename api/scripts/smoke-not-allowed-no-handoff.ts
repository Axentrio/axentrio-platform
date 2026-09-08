/**
 * Smoke: policy `not_allowed` reschedule/cancel must refuse without offering a human.
 *
 * SAFE BY DEFAULT — static prompt/error seams only; no prod DB writes.
 *
 * Usage (static only — safe anywhere):
 *   cd api && npm run smoke:not-allowed-handoff
 *
 * Usage (isolated ephemeral fixture — local or internal tenant with bookings already on):
 *   cd api && SMOKE_ISOLATED=1 LOCAL_REDIS_URL=redis://127.0.0.1:6379 npm run smoke:not-allowed-handoff
 *
 * Env:
 *   SMOKE_ISOLATED=1            create a dedicated smoke session + booking, tear down fully in finally
 *   SMOKE_TENANT_ID=<uuid>      internal allowlisted tenant only (default: achraf test account)
 *   SMOKE_SKIP_E2E=1            skip tool execute
 *   SMOKE_SKIP_CONVERSATION=1   skip live AgentService conversation turn
 *   LOCAL_REDIS_URL=...         override Railway internal Redis when running locally
 *
 * NEVER:
 *   - mutate an existing tenant tier, service policy, or customer session
 *   - point at a real customer booking/session (no SMOKE_BOOKING_ID, no SMOKE_SEED)
 *   - run against WaterFix or any non-allowlisted tenant
 */
import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { initializeDatabase, closeDatabase, AppDataSource } from '../src/database/data-source';
import { initializeRedis, getRedisClient, closeRedis } from '../src/config/redis';
import { Booking } from '../src/database/entities/Booking';
import { ServiceType } from '../src/database/entities/ServiceType';
import { ChatSession } from '../src/database/entities/ChatSession';
import { Message } from '../src/database/entities/Message';
import { Participant } from '../src/database/entities/Participant';
import { HandoffRequest } from '../src/database/entities/HandoffRequest';
import { Bot } from '../src/database/entities/Bot';
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
import { getEntitlements } from '../src/billing/entitlements';

/** Internal tenants only — never WaterFix or real customer orgs. */
const ALLOWED_SMOKE_TENANT_IDS = new Set([
  '4191ca91-f05a-4c3b-acb2-57d67d07bfda', // achraf test account
]);

const DEFAULT_SMOKE_TENANT_ID = '4191ca91-f05a-4c3b-acb2-57d67d07bfda';

const NO_HANDOFF = /do not offer to connect them with the team/i;
const INSIST_LADDER = /keep insisting after you have explained the cutoff/i;
const HANDOFF_OFFER =
  /(wil je dat ik (je )?verbind|zou je (willen )?dat ik (je )?(verbind|doorverbind)|connect you with (a |the )?(human|person|team|someone)|would you like (me )?to connect you|spreek.*(medewerker|iemand)|human agent|met (ons|het) team spreken)/i;

type EphemeralFixture = {
  tenant: Tenant;
  bot: Bot;
  session: ChatSession;
  service: ServiceType;
  booking: Booking;
  userParticipant: Participant;
  botParticipant: Participant;
};

function pass(label: string, detail?: string): void {
  console.log(`✓ ${label}${detail ? ` — ${detail}` : ''}`);
}

function fail(label: string, detail?: string): never {
  console.error(`✗ ${label}${detail ? ` — ${detail}` : ''}`);
  throw new Error(`smoke failed: ${label}${detail ? ` — ${detail}` : ''}`);
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

async function resolveAllowlistedTenant(): Promise<Tenant> {
  const tenantId = (process.env.SMOKE_TENANT_ID?.trim() || DEFAULT_SMOKE_TENANT_ID);
  if (!ALLOWED_SMOKE_TENANT_IDS.has(tenantId)) {
    fail('SMOKE_TENANT_ID is not on the internal smoke allowlist', tenantId);
  }
  const tenant = await AppDataSource.getRepository(Tenant).findOne({ where: { id: tenantId } });
  if (!tenant) fail('allowlisted smoke tenant missing', tenantId);
  if (isWaterFixTenant(tenant.name)) fail('refusing WaterFix tenant', tenant.name);
  return tenant;
}

async function assertBookingsEntitled(tenantId: string): Promise<void> {
  const entitlements = await getEntitlements(tenantId);
  if (!entitlements.features.bookings) {
    fail(
      'tenant does not have bookings entitled — configure bookings on the internal smoke tenant permanently; this script never mutates tier or feature toggles',
      `${entitlements.planId} billable=${entitlements.billable}`,
    );
  }
}

async function createEphemeralFixture(): Promise<EphemeralFixture> {
  const tenant = await resolveAllowlistedTenant();
  await assertBookingsEntitled(tenant.id);

  const bot =
    (await AppDataSource.getRepository(Bot).findOne({ where: { tenantId: tenant.id, isDefault: true } })) ??
    fail('allowlisted smoke tenant has no default bot', tenant.id);

  const runTag = randomUUID();
  const session = await AppDataSource.getRepository(ChatSession).save(
    AppDataSource.getRepository(ChatSession).create({
      tenantId: tenant.id,
      botId: bot.id,
      visitorId: `smoke-not-allowed-${runTag}`,
      status: 'bot',
      ownership: 'bot_owned',
      source: 'widget',
      messageCount: 0,
      unreadCount: 0,
      startedAt: new Date(),
      lastActivityAt: new Date(),
    }),
  );

  const service = await AppDataSource.getRepository(ServiceType).save(
    AppDataSource.getRepository(ServiceType).create({
      tenantId: tenant.id,
      botId: bot.id,
      name: `Smoke not_allowed ${runTag.slice(0, 8)}`,
      slug: `smoke-not-allowed-${runTag.slice(0, 8)}`,
      bookingMode: 'auto',
      rescheduleMode: 'not_allowed',
      cancelMode: 'request',
      onlineBookable: true,
      isActive: true,
      durationMin: 30,
      durationMode: 'fixed',
      priceDisplayType: 'none',
      locationType: 'unset',
    }),
  );

  const startUtc = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const endUtc = new Date(startUtc.getTime() + 30 * 60 * 1000);
  const icsUid = `smoke-${runTag}@axentrio.internal`;

  const inserted: Array<{ id: string }> = await AppDataSource.query(
    `
      INSERT INTO chatbot_bookings (
        tenant_id, bot_id, event_type_id, session_id, status,
        start_utc, end_utc, blocked_range, calendar_key, ics_uid, booking_mode, attendee_name
      ) VALUES (
        $1, $2, $3, $4, 'confirmed',
        $5, $6, tstzrange($5::timestamptz, $6::timestamptz, '[)'), $2, $7, 'auto', 'Smoke Customer'
      )
      RETURNING id
    `,
    [tenant.id, bot.id, service.id, session.id, startUtc.toISOString(), endUtc.toISOString(), icsUid],
  );
  const booking = await AppDataSource.getRepository(Booking).findOneOrFail({ where: { id: inserted[0].id } });

  const userParticipant = await AppDataSource.getRepository(Participant).save(
    AppDataSource.getRepository(Participant).create({
      sessionId: session.id,
      type: 'user',
      name: 'Smoke visitor',
      joinedAt: new Date(),
    }),
  );
  const botParticipant = await AppDataSource.getRepository(Participant).save(
    AppDataSource.getRepository(Participant).create({
      sessionId: session.id,
      type: 'bot',
      name: bot.name,
      joinedAt: new Date(),
    }),
  );

  return { tenant, bot, session, service, booking, userParticipant, botParticipant };
}

async function teardownEphemeralFixture(fixture: EphemeralFixture): Promise<void> {
  const { session, service, booking } = fixture;
  await AppDataSource.query('DELETE FROM agent_traces WHERE "sessionId" = $1', [session.id]);
  await AppDataSource.query('DELETE FROM messages WHERE session_id = $1', [session.id]);
  await AppDataSource.query('DELETE FROM handoff_requests WHERE session_id = $1', [session.id]);
  await AppDataSource.query('DELETE FROM participants WHERE session_id = $1', [session.id]);
  await AppDataSource.query('DELETE FROM chatbot_bookings WHERE id = $1', [booking.id]);
  await AppDataSource.query('DELETE FROM chatbot_service_types WHERE id = $1', [service.id]);
  await AppDataSource.query('DELETE FROM chat_sessions WHERE id = $1', [session.id]);
  pass('teardown ephemeral smoke fixture', session.id);
}

async function assertToolE2E(fixture: EphemeralFixture): Promise<void> {
  if (process.env.SMOKE_SKIP_E2E === '1') {
    console.warn('\n⚠ SMOKE_SKIP_E2E=1 — skipping live tool execute');
    return;
  }

  console.log('\n--- live tool execute (isolated fixture) ---');
  const ctx = makeCtx(fixture.session.id, fixture.tenant.id);

  const list = await new ListBookingsTool().execute({}, ctx);
  if (!list.success) fail('list_bookings failed', list.error);
  const guidance = (list.data as { guidance?: string } | undefined)?.guidance ?? '';
  if (!guidance) fail('list_bookings returned no guidance for not_allowed booking');
  assertPolicyRefusal(guidance, 'list_bookings guidance');

  const result = await new RescheduleBookingTool().execute(
    { bookingId: fixture.booking.id, newStartTime: fixture.booking.startUtc.toISOString() },
    ctx,
  );
  if (result.success) fail('reschedule_booking should refuse policy not_allowed');
  assertPolicyRefusal(result.error ?? '', 'reschedule_booking CHANGE_NOT_ALLOWED');
}

async function assertConversationE2E(fixture: EphemeralFixture): Promise<void> {
  if (process.env.SMOKE_SKIP_CONVERSATION === '1') {
    console.warn('\n⚠ SMOKE_SKIP_CONVERSATION=1 — skipping live conversation');
    return;
  }
  if (!process.env.OPENAI_API_KEY) fail('OPENAI_API_KEY required for live conversation smoke');

  console.log('\n--- live conversation (isolated AgentService session) ---');
  process.env.AGENT_BURST_DEBOUNCE_MS = '0';

  const redis = getRedisClient();
  const agentSvc = new AgentService(
    new ToolRegistry(),
    new PromptBuilder(),
    new MeteringService(redis as never),
    new TraceLogger(),
  );
  initializeAgentService(agentSvc);

  const handoffsBefore = await AppDataSource.getRepository(HandoffRequest).count({
    where: { sessionId: fixture.session.id, status: 'requested' as const },
  });

  const userText = 'Kan ik mijn afspraak verzetten naar volgende week?';
  const msg = await AppDataSource.getRepository(Message).save(
    AppDataSource.getRepository(Message).create({
      sessionId: fixture.session.id,
      tenantId: fixture.tenant.id,
      participantId: fixture.userParticipant.id,
      type: 'text',
      content: userText,
      status: 'sent',
    }),
  );

  const freshSession = await AppDataSource.getRepository(ChatSession).findOneOrFail({
    where: { id: fixture.session.id },
  });
  const forwarded = await forwardMessageToN8n(freshSession, msg);
  if (!forwarded) fail('forwardMessageToN8n returned false — AI off or agent not wired?');

  const botMsg = await AppDataSource.getRepository(Message)
    .createQueryBuilder('m')
    .innerJoin('m.participant', 'p')
    .where('m.sessionId = :sessionId', { sessionId: fixture.session.id })
    .andWhere("p.type = 'bot'")
    .andWhere('m.createdAt > :since', { since: msg.createdAt })
    .orderBy('m.createdAt', 'DESC')
    .getOne();

  const reply = botMsg ? (botMsg.contentEncrypted ? decrypt(botMsg.content) : botMsg.content) : '';
  if (!reply.trim()) fail('no bot reply after conversation turn');
  console.log(`Bot reply (${fixture.tenant.name}): ${reply.slice(0, 400)}${reply.length > 400 ? '...' : ''}`);

  if (HANDOFF_OFFER.test(reply)) fail('bot offered human handoff on policy refusal', reply.slice(0, 300));

  const handoffsAfter = await AppDataSource.getRepository(HandoffRequest).count({
    where: { sessionId: fixture.session.id, status: 'requested' as const },
  });
  if (handoffsAfter > handoffsBefore) fail('handoff row opened during smoke conversation');

  pass('live conversation: polite refusal without handoff offer');
}

/** Release Redis + DB pool so isolated smoke exits instead of hanging until killed. */
async function shutdownConnections(): Promise<void> {
  try {
    await closeRedis();
  } catch (error) {
    logger.warn('[smoke-not-allowed-no-handoff] closeRedis failed', { error });
  }
  try {
    await closeDatabase();
  } catch (error) {
    logger.warn('[smoke-not-allowed-no-handoff] closeDatabase failed', { error });
  }
}

async function main(): Promise<void> {
  if (process.env.LOCAL_REDIS_URL) process.env.REDIS_URL = process.env.LOCAL_REDIS_URL;

  console.log('Smoke: policy not_allowed — no human handoff on first refusal\n');
  assertStaticSeams();

  if (process.env.SMOKE_ISOLATED !== '1') {
    console.log('\nStatic seams passed. Set SMOKE_ISOLATED=1 to run isolated tool/conversation checks on an internal tenant with bookings entitled.');
    console.log('This script never mutates real customer sessions, tier, or service policy.');
    return;
  }

  let fixture: EphemeralFixture | undefined;
  try {
    await initializeDatabase();
    await initializeRedis();
    getRedisClient();

    fixture = await createEphemeralFixture();
    pass(
      'ephemeral fixture',
      `${fixture.session.id} · ${fixture.tenant.name} · ${fixture.service.name}`,
    );
    await assertToolE2E(fixture);
    await assertConversationE2E(fixture);
    console.log('\nAll smoke checks passed.');
  } finally {
    if (fixture) {
      try {
        await teardownEphemeralFixture(fixture);
      } catch (error) {
        logger.warn('[smoke-not-allowed-no-handoff] fixture teardown failed', { error });
      }
    }
    await shutdownConnections();
  }
}

main().catch((err) => {
  logger.error('[smoke-not-allowed-no-handoff] failed', err);
  process.exitCode = 1;
});
