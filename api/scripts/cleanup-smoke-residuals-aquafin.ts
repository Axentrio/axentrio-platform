/**
 * TARGETED cleanup for Aquafin prod residuals left by the unsafe smoke-not-allowed runs
 * on 2026-09-07. Does NOT touch tier, service policy, session status, or real June messages.
 *
 * READ-ONLY unless CLEANUP_APPROVE matches exactly:
 *   CLEANUP_APPROVE=aquafin-smoke-2026-09-07
 */
import 'reflect-metadata';
import { initializeDatabase, AppDataSource } from '../src/database/data-source';
import { decrypt } from '../src/utils/encryption';

const APPROVAL_TOKEN = 'aquafin-smoke-2026-09-07';
const SESSION_ID = 'd1ccb046-484d-44f5-ac10-c52b570f5dcf';
const TENANT_ID = '16cdb37f-1114-4ef5-a041-fefa6f34f282';

const SMOKE_MESSAGE_IDS = [
  '3e60a9d4-e32b-440d-9018-bf40a052b424',
  '8d7e6865-e4e9-41fc-a235-9f4729edb3c4',
  '51d7055e-d66a-47eb-9dad-4dc2730abc71',
  '085363e2-285a-4469-a7bb-e759dd484375',
] as const;

const SMOKE_TRACE_IDS = [
  'dec9c070-88a0-4fb9-829b-0ca91e6ba700',
  '1bcb9a44-946f-468c-bb0d-f5f3438ac8db',
] as const;

async function inventory(): Promise<void> {
  const msgs = await AppDataSource.query(
    `SELECT m.id, m.created_at, p.type AS participant_type, m.content, m.content_encrypted
     FROM messages m JOIN participants p ON p.id = m.participant_id
     WHERE m.id = ANY($1) ORDER BY m.created_at`,
    [SMOKE_MESSAGE_IDS],
  );
  const decoded = msgs.map((m: any) => ({
    id: m.id,
    created_at: m.created_at,
    participant_type: m.participant_type,
    content: m.content_encrypted ? decrypt(m.content ?? '') : m.content,
  }));
  const traces = await AppDataSource.query(
    `SELECT id, "createdAt", "messageId", "finishReason" FROM agent_traces WHERE id = ANY($1) ORDER BY "createdAt"`,
    [SMOKE_TRACE_IDS],
  );
  const session = await AppDataSource.query('SELECT id, status, ownership, updated_at FROM chat_sessions WHERE id = $1', [SESSION_ID]);
  const tenant = await AppDataSource.query('SELECT id, name, tier, updated_at FROM tenants WHERE id = $1', [TENANT_ID]);
  const service = await AppDataSource.query(
    'SELECT id, name, reschedule_mode, cancel_mode, updated_at FROM chatbot_service_types WHERE id = $1',
    ['15fbf1ae-23f6-495a-a66d-5b57523fac94'],
  );
  console.log(JSON.stringify({ tenant: tenant[0], service: service[0], session: session[0], smokeMessages: decoded, smokeTraces: traces }, null, 2));
}

async function executeCleanup(): Promise<void> {
  if (process.env.CLEANUP_APPROVE !== APPROVAL_TOKEN) {
    console.error(`Refusing deletion — set CLEANUP_APPROVE=${APPROVAL_TOKEN}`);
    process.exit(1);
  }
  await AppDataSource.query('DELETE FROM agent_traces WHERE id = ANY($1)', [SMOKE_TRACE_IDS]);
  await AppDataSource.query('DELETE FROM messages WHERE id = ANY($1) AND session_id = $2', [SMOKE_MESSAGE_IDS, SESSION_ID]);
  console.log('Deleted smoke traces and messages. NOT modified: tier, service policy, session, June messages, participants.');
}

async function main(): Promise<void> {
  await initializeDatabase();
  console.log('--- inventory ---');
  await inventory();
  if (process.env.CLEANUP_APPROVE === APPROVAL_TOKEN) {
    console.log('\n--- executing approved cleanup ---');
    await executeCleanup();
    console.log('\n--- post-cleanup inventory ---');
    await inventory();
  } else {
    console.log(`\nDry run only. To delete, re-run with CLEANUP_APPROVE=${APPROVAL_TOKEN}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
