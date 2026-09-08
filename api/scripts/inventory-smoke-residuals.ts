/**
 * READ-ONLY inventory of prod residuals from unsafe smoke-not-allowed-no-handoff runs.
 * Does not delete anything. See cleanup-smoke-residuals-aquafin.ts for approved deletion.
 */
import 'reflect-metadata';
import { initializeDatabase, AppDataSource } from '../src/database/data-source';
import { decrypt } from '../src/utils/encryption';

/** Exact IDs from the two Aquafin conversation smoke runs on 2026-09-07. */
export const AQUAFIN_SMOKE_MESSAGE_IDS = [
  { id: '3e60a9d4-e32b-440d-9018-bf40a052b424', createdAt: '2026-09-07T20:08:22.163Z', role: 'user' },
  { id: '8d7e6865-e4e9-41fc-a235-9f4729edb3c4', createdAt: '2026-09-07T20:08:43.860Z', role: 'bot' },
  { id: '51d7055e-d66a-47eb-9dad-4dc2730abc71', createdAt: '2026-09-07T20:12:14.340Z', role: 'user' },
  { id: '085363e2-285a-4469-a7bb-e759dd484375', createdAt: '2026-09-07T20:12:35.858Z', role: 'bot' },
] as const;

export const AQUAFIN_SMOKE_TRACE_IDS = [
  { id: 'dec9c070-88a0-4fb9-829b-0ca91e6ba700', createdAt: '2026-09-08T04:08:43.679Z' },
  { id: '1bcb9a44-946f-468c-bb0d-f5f3438ac8db', createdAt: '2026-09-08T04:12:35.674Z' },
] as const;

const FIXTURES = [
  {
    label: 'aquafin (two live smoke conversation runs — RESIDUALS REMAIN)',
    tenantId: '16cdb37f-1114-4ef5-a041-fefa6f34f282',
    serviceId: '15fbf1ae-23f6-495a-a66d-5b57523fac94',
    bookingId: '04a15e87-f877-4fb9-a6cc-88298c4a70aa',
    sessionId: 'd1ccb046-484d-44f5-ac10-c52b570f5dcf',
    expectedSmokeMessageIds: AQUAFIN_SMOKE_MESSAGE_IDS.map((m) => m.id),
    expectedSmokeTraceIds: AQUAFIN_SMOKE_TRACE_IDS.map((t) => t.id),
  },
  {
    label: 'onboard cal barber 0820 (tier seed attempt only — no smoke messages)',
    tenantId: '5a0bf4a9-7eda-4713-99c5-7a1c30c5a87b',
    serviceId: '875b31f2-ef7e-44f7-8119-d89a456f61b5',
    bookingId: 'cc4a9c74-0eb1-454e-9918-bcc927fa8680',
    sessionId: 'bd929b84-ef31-481a-875a-7b4cfe6b080f',
    expectedSmokeMessageIds: [] as string[],
    expectedSmokeTraceIds: [] as string[],
  },
];

async function inventoryOne(f: (typeof FIXTURES)[0]) {
  const tenant = await AppDataSource.query('SELECT id, name, tier, status, updated_at FROM tenants WHERE id = $1', [f.tenantId]);
  const service = await AppDataSource.query('SELECT id, name, reschedule_mode, cancel_mode, updated_at FROM chatbot_service_types WHERE id = $1', [f.serviceId]);
  const booking = await AppDataSource.query('SELECT id, session_id, status, start_utc FROM chatbot_bookings WHERE id = $1', [f.bookingId]);
  const session = await AppDataSource.query('SELECT id, status, ownership, updated_at, ended_at FROM chat_sessions WHERE id = $1', [f.sessionId]);

  const msgs = await AppDataSource.query(
    `SELECT m.id, m.created_at, p.type AS participant_type, p.name AS participant_name, m.content, m.content_encrypted
     FROM messages m JOIN participants p ON p.id = m.participant_id
     WHERE m.id = ANY($1) ORDER BY m.created_at`,
    [f.expectedSmokeMessageIds.length ? f.expectedSmokeMessageIds : ['00000000-0000-0000-0000-000000000000']],
  );

  const decoded = f.expectedSmokeMessageIds.length
    ? msgs.map((m: { id: string; created_at: string; participant_type: string; participant_name: string | null; content: string | null; content_encrypted: boolean }) => ({
        id: m.id,
        createdAt: m.created_at,
        participant_type: m.participant_type,
        participant_name: m.participant_name,
        content: m.content_encrypted ? decrypt(m.content ?? '') : m.content,
      }))
    : [];

  const traces = f.expectedSmokeTraceIds.length
    ? await AppDataSource.query(
        'SELECT id, "createdAt", "messageId", "finishReason" FROM agent_traces WHERE id = ANY($1) ORDER BY "createdAt"',
        [f.expectedSmokeTraceIds],
      )
    : [];

  return {
    label: f.label,
    tenant: tenant[0],
    service: service[0],
    booking: booking[0],
    session: session[0],
    smokeMessagesPresent: decoded,
    smokeMessagesMissing: f.expectedSmokeMessageIds.filter((id) => !decoded.some((m: { id: string }) => m.id === id)),
    smokeTracesPresent: traces,
    smokeTracesMissing: f.expectedSmokeTraceIds.filter((id) => !traces.some((t: { id: string }) => t.id === id)),
  };
}

async function main() {
  await initializeDatabase();
  const out = [];
  for (const f of FIXTURES) out.push(await inventoryOne(f));
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
