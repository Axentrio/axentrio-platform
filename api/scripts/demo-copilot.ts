/**
 * One-off demo: drive `runCopilotTurn` end-to-end with the real
 * OpenAI streaming client, the real lexical retriever against the
 * seeded docs corpus, and the real CopilotToolRegistry — but no
 * HTTP / Clerk layer. Streams events to stdout so you can see the
 * pipeline in action.
 *
 *   npx ts-node scripts/demo-copilot.ts <tenantId> "<question>"
 *
 * Persists a real conversation + assistant row + trace; rolls back
 * if invoked with --dry-run (TODO — for now the rows stay in the
 * DB and can be archived with POST /clear in the portal).
 */
import { AppDataSource } from '../src/database/data-source';
import { runCopilotTurn } from '../src/copilot/agent/loop';
import { OpenAICopilotLlmStream } from '../src/copilot/agent/openai-stream';
import { createCopilotKnowledgeSource } from '../src/copilot/knowledge/factory';
import { buildV1CopilotToolRegistry } from '../src/copilot/tools';
import type { CopilotSSEEvent, CopilotSSESink } from '../src/copilot/agent/sse';

const COLOR_DIM = '\x1b[2m';
const COLOR_CYAN = '\x1b[36m';
const COLOR_YELLOW = '\x1b[33m';
const COLOR_GREEN = '\x1b[32m';
const COLOR_RED = '\x1b[31m';
const COLOR_RESET = '\x1b[0m';

function printEvent(event: CopilotSSEEvent): void {
  switch (event.event) {
    case 'token':
      process.stdout.write(event.data.text);
      return;
    case 'tool_call_start':
      process.stdout.write(`\n${COLOR_CYAN}[tool→ ${event.data.name}]${COLOR_RESET}\n`);
      return;
    case 'tool_call_end':
      process.stdout.write(
        `${COLOR_DIM}[tool✓ ${event.data.name} → ${event.data.outcome}]${COLOR_RESET}\n`,
      );
      return;
    case 'heartbeat':
      process.stdout.write(`${COLOR_DIM}♥${COLOR_RESET}`);
      return;
    case 'error':
      process.stdout.write(
        `\n${COLOR_RED}[error] code=${event.data.code}${COLOR_RESET}\n`,
      );
      return;
    case 'complete':
      process.stdout.write(
        `\n${COLOR_GREEN}[complete] tokensIn=${event.data.tokensIn} tokensOut=${event.data.tokensOut} latencyMs=${event.data.latencyMs}${COLOR_RESET}\n`,
      );
      return;
  }
}

async function main() {
  const tenantId = process.argv[2];
  const question = process.argv[3];
  if (!tenantId || !question) {
    console.error('Usage: npx ts-node scripts/demo-copilot.ts <tenantId> "<question>"');
    process.exit(1);
  }

  await AppDataSource.initialize();

  // Pick a user belonging to the tenant — the demo persists rows
  // under their (tenantId, userId) pair.
  const userRows = await AppDataSource.query(
    `SELECT id FROM users WHERE tenant_id = $1 ORDER BY created_at ASC LIMIT 1`,
    [tenantId],
  );
  if (userRows.length === 0) {
    console.error(`No user found for tenant ${tenantId}`);
    process.exit(1);
  }
  const userId = userRows[0].id as string;

  console.log(`${COLOR_YELLOW}━━━ Copilot demo ━━━${COLOR_RESET}`);
  console.log(`tenant=${tenantId}  user=${userId}`);
  console.log(`Q: ${question}\n${COLOR_DIM}── streaming reply ──${COLOR_RESET}`);

  const events: CopilotSSEEvent[] = [];
  const sink: CopilotSSESink = {
    emit(event) {
      events.push(event);
      printEvent(event);
    },
  };
  const ac = new AbortController();

  const result = await runCopilotTurn({
    dataSource: AppDataSource,
    llm: new OpenAICopilotLlmStream(),
    knowledge: createCopilotKnowledgeSource(AppDataSource.manager),
    toolRegistry: buildV1CopilotToolRegistry(),
    sink,
    abortSignal: ac.signal,
    tenantId,
    userId,
    message: question,
  });

  console.log(`\n${COLOR_DIM}── summary ──${COLOR_RESET}`);
  console.log(`outcome=${result.outcome}`);
  console.log(`conversationId=${result.conversationId}`);
  console.log(`userMsg=${result.userMessageId} (turn ${result.userTurn})`);
  console.log(`assistantMsg=${result.assistantMessageId} (turn ${result.assistantTurn})`);
  console.log(`tokensIn=${result.tokensIn}  tokensOut=${result.tokensOut}  latencyMs=${result.latencyMs}`);
  console.log(`toolsCalled=${JSON.stringify(result.toolsCalled)}`);
  console.log(`events=${events.length} (incl. ${events.filter((e) => e.event === 'token').length} tokens)`);

  await AppDataSource.destroy();
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
