/**
 * Live smoke: policy `not_allowed` reschedule/cancel must refuse without offering a human.
 *
 * Usage (local):
 *   cd api && npm run smoke:not-allowed-handoff
 *
 * Usage (prod VPS env):
 *   PROD_SSH_HOST=deploy@<prod-ip> scripts/prod-env.sh npx tsx scripts/smoke-not-allowed-no-handoff.ts
 *
 * Env:
 *   SMOKE_BOOKING_ID=<uuid>   booking on a not_allowed service; else auto-discover
 *   SMOKE_SKIP_E2E=1          skip tool execute against live DB
 */
import 'reflect-metadata';
import { initializeDatabase, AppDataSource } from '../src/database/data-source';
import { initializeRedis, getRedisClient } from '../src/config/redis';
import { Booking } from '../src/database/entities/Booking';
import { ServiceType } from '../src/database/entities/ServiceType';
import { logger } from '../src/utils/logger';
import { customerChangeNotAllowedError } from '../src/booking/customer-change-policy';
import { buildServicesSection } from '../src/modules/booking.module';
import { handoffSkill } from '../src/modules/catalog-skills';
import { ListBookingsTool, RescheduleBookingTool, CancelBookingTool } from '../src/agent/tools/booking.tool';
import type { ToolContext } from '../src/agent/tool-adapter';

const NO_HANDOFF = /do not offer to connect them with the team/i;
const INSIST_LADDER = /keep insisting after you have explained the cutoff/i;

function pass(label: string, detail?: string): void {
  console.log(`✓ ${label}${detail ? ` — ${detail}` : ''}`);
}

function fail(label: string, detail?: string): never {
  console.error(`✗ ${label}${detail ? ` — ${detail}` : ''}`);
  process.exit(1);
}

function assertPolicyRefusal(text: string, label: string): void {
  if (!NO_HANDOFF.test(text)) fail(`${label}: missing no-handoff clause`, text.slice(0, 240));
  if (!/not a request for a person/i.test(text)) fail(`${label}: missing insist-is-not-handoff`, text.slice(0, 240));
  if (INSIST_LADDER.test(text)) fail(`${label}: cutoff insist ladder leaked into policy path`, text.slice(0, 240));
  pass(label);
}

function makeCtx(sessionId: string): ToolContext {
  return {
    tenantId: 'smoke',
    sessionId,
    runId: 'smoke-run',
    channel: 'widget',
    toolsCalledThisTurn: [],
    dataSource: AppDataSource,
    conversationHistory: [{ role: 'user', content: 'ik wil mijn afspraak verzetten' }],
  };
}

async function pickPolicyForbiddenBooking(): Promise<{ booking: Booking; service: ServiceType; kind: 'reschedule' | 'cancel' }> {
  const id = process.env.SMOKE_BOOKING_ID?.trim();
  if (id) {
    const booking = await AppDataSource.getRepository(Booking).findOne({ where: { id } });
    if (!booking) fail('SMOKE_BOOKING_ID not found', id);
    const service = await AppDataSource.getRepository(ServiceType).findOne({ where: { id: booking.eventTypeId } });
    if (!service) fail('Service missing for SMOKE_BOOKING_ID', booking.eventTypeId);
    if (service.rescheduleMode === 'not_allowed') return { booking, service, kind: 'reschedule' };
    if (service.cancelMode === 'not_allowed') return { booking, service, kind: 'cancel' };
    fail('SMOKE_BOOKING_ID service is not policy not_allowed', `${service.name} reschedule=${service.rescheduleMode} cancel=${service.cancelMode}`);
  }

  const services = await AppDataSource.getRepository(ServiceType).find({
    where: [{ rescheduleMode: 'not_allowed' as const }, { cancelMode: 'not_allowed' as const }],
    order: { updatedAt: 'DESC' },
    take: 20,
  });
  for (const service of services) {
    const booking = await AppDataSource.getRepository(Booking).findOne({
      where: { eventTypeId: service.id, status: 'confirmed' as const },
      order: { startTime: 'DESC' },
    });
    if (!booking?.sessionId) continue;
    const kind = service.rescheduleMode === 'not_allowed' ? 'reschedule' : 'cancel';
    return { booking, service, kind };
  }
  fail('No confirmed booking on a policy not_allowed service — set SMOKE_BOOKING_ID or configure a test service');
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

async function assertToolE2E(booking: Booking, kind: 'reschedule' | 'cancel'): Promise<void> {
  if (process.env.SMOKE_SKIP_E2E === '1') {
    console.warn('\n⚠ SMOKE_SKIP_E2E=1 — skipping live tool execute');
    return;
  }

  console.log('\n--- live tool execute ---');
  const ctx = makeCtx(booking.sessionId);

  const list = await new ListBookingsTool().execute({}, ctx);
  if (!list.success) fail('list_bookings failed', list.error);
  const guidance = (list.data as { guidance?: string } | undefined)?.guidance ?? '';
  if (!guidance) fail('list_bookings returned no guidance for not_allowed booking');
  assertPolicyRefusal(guidance, 'list_bookings guidance');

  if (kind === 'reschedule') {
    const result = await new RescheduleBookingTool().execute(
      { bookingId: booking.id, newStartTime: booking.startTime.toISOString() },
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

async function main(): Promise<void> {
  console.log('Smoke: policy not_allowed — no human handoff on first refusal\n');
  assertStaticSeams();

  await initializeDatabase();
  await initializeRedis();
  getRedisClient();

  const { booking, service, kind } = await pickPolicyForbiddenBooking();
  pass('template booking', `${booking.id} · ${service.name} · ${kind}=not_allowed`);

  await assertToolE2E(booking, kind);
  console.log('\nAll smoke checks passed.');
}

main().catch((err) => {
  logger.error('[smoke-not-allowed-no-handoff] failed', err);
  process.exit(1);
});
