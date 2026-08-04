/**
 * Escalating a Copilot conversation to a person.
 *
 * The assistant is read-only and, by design, says "I don't know" rather than inventing.
 * Without a way out, that honesty is a dead end — the customer is told nobody can help
 * them and left to find an address themselves.
 *
 * WHAT THIS SENDS, and why it is not a mailto: link. The value is not the customer's
 * sentence, which they could email unaided. It is the CONTEXT they cannot be expected to
 * type: which workspace, which plan, and what they had just been asking the assistant.
 * That is the difference between a ticket support can act on and one that starts with
 * three clarifying questions.
 *
 * The transcript is the customer's own conversation with the assistant, sent because they
 * asked for help with it. Nothing else is attached — no visitor conversations, no lead
 * records, no configuration. Support gets the question, not the workspace.
 *
 * PRIORITY. Enterprise contracts include a human support agent and priority response, so
 * the tier is stated in the subject rather than left for someone to look up. Pro gets the
 * same route with a normal subject, which is what the plan promises.
 */
import { AppDataSource } from '../database/data-source';
import { Tenant } from '../database/entities/Tenant';
import { User } from '../database/entities/User';
import { getEmailService } from '../automations';
import { logger } from '../utils/logger';

export const SUPPORT_INBOX = process.env.SUPPORT_EMAIL?.trim() || 'support@axentrio.com';

/**
 * The platform operator, copied on every escalation.
 *
 * A shared support inbox is where a request goes to be handled; it is not where
 * anyone notices that requests have stopped arriving. Copying a named human
 * means a broken escalation path is visible immediately rather than the next
 * time somebody thinks to check the inbox.
 *
 * Reuses PLATFORM_ALERT_EMAIL — the same operator who gets the outage alerts.
 * Unset means no cc, never an empty recipient.
 *
 * Read per send, not captured at module load: a config change should take effect
 * without waiting for a process restart to notice it.
 */
const operatorCc = (): string | undefined => process.env.PLATFORM_ALERT_EMAIL?.trim() || undefined;

/**
 * How much of the conversation goes in the ticket. Enough to see the thread, not a dump.
 * Exported so the route can select exactly this many MOST-RECENT turns rather than
 * fetching a window and trimming it to the wrong end.
 */
export const ESCALATION_TRANSCRIPT_TURNS = 10;

/** Guards against a pasted essay becoming an unreadable email. */
const MAX_MESSAGE_CHARS = 4000;

export interface EscalationTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface EscalationInput {
  tenantId: string;
  userId: string;
  /** What the customer wants a person to look at. */
  message: string;
  transcript: EscalationTurn[];
}

export interface EscalationResult {
  delivered: boolean;
  /** Echoed back so the UI can tell the customer where it went. */
  inbox: string;
  priority: boolean;
}

function renderTranscript(turns: EscalationTurn[]): string {
  if (turns.length === 0) return '(The customer had not asked the assistant anything yet.)';
  return turns
    .slice(-ESCALATION_TRANSCRIPT_TURNS)
    .map((t) => `${t.role === 'user' ? 'Customer' : 'Assistant'}: ${t.content}`)
    .join('\n\n');
}

export async function escalateToSupport(input: EscalationInput): Promise<EscalationResult> {
  const [tenant, user] = await Promise.all([
    AppDataSource.getRepository(Tenant).findOne({
      where: { id: input.tenantId },
      select: ['id', 'name', 'tier'],
    }),
    AppDataSource.getRepository(User).findOne({
      where: { id: input.userId },
      select: ['id', 'name', 'email'],
    }),
  ]);
  if (!tenant) throw new Error(`escalateToSupport: tenant ${input.tenantId} not found`);

  const priority = tenant.tier === 'enterprise';
  const subject = `${priority ? '[PRIORITY] ' : ''}Support request from ${tenant.name}`;

  const body = [
    `Workspace: ${tenant.name}`,
    `Plan: ${tenant.tier}${priority ? ' (priority response)' : ''}`,
    `Raised by: ${user?.name || 'unknown'} <${user?.email ?? 'unknown'}>`,
    '',
    'What they need help with:',
    input.message.slice(0, MAX_MESSAGE_CHARS),
    '',
    `Their conversation with the assistant (last ${ESCALATION_TRANSCRIPT_TURNS} turns):`,
    renderTranscript(input.transcript),
  ].join('\n');

  const result = await getEmailService().send({
    to: SUPPORT_INBOX,
    // cc, not a second `to`: support owns the request, the operator is only
    // watching. Also keeps replyTo pointing the handler at the customer.
    ...((): { cc?: string } => {
      const cc = operatorCc();
      // Never cc the address we are already sending to — a duplicate copy in the
      // same thread reads as a bug to whoever opens it.
      return cc && cc !== SUPPORT_INBOX ? { cc } : {};
    })(),
    subject,
    body,
    // So support hits Reply and reaches the customer, not the platform.
    replyTo: user?.email ?? undefined,
  });

  if (!result.success) {
    // Surfaced to the caller as a failure: telling someone their request reached a
    // human when it did not is the one outcome worse than not offering the button.
    logger.error('[copilot] support escalation failed to send', {
      tenantId: input.tenantId,
      error: result.error,
    });
  }

  return { delivered: result.success, inbox: SUPPORT_INBOX, priority };
}
