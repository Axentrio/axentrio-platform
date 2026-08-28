// Global AI Workflow Guardrails — the OUTPUT gate.
//
// Runs on an AI-GENERATED reply BEFORE it is sent to the customer, at every
// reply boundary (coalescer runTurn, legacy platform-agent path, RAG fallback,
// n8n message.send). Composes the pure validateOutput: in ENFORCE mode it
// replaces an offending reply with the tenant fallback (the caller then hands
// off to a human); in SHADOW mode it only logs (the original reply still goes
// out). Every flagged reply — shadow or enforce — is journaled to
// guardrail_output_logs (AC13). Platform-authored fallbacks (off-hours,
// escalation, agent-error) are NOT routed through here by their callers — only
// genuine AI output is. See .scratch/plan-global-ai-guardrails.md Slice 2 (AC14).

import { AppDataSource } from '../database/data-source';
import { ChatSession } from '../database/entities/ChatSession';
import { GuardrailOutputLog } from '../database/entities/GuardrailOutputLog';
import { logger } from '../utils/logger';
import { validateOutput, type OutputValidationContext } from './output-validation';
import { stripReplyAsterisks } from './strip-reply-asterisks';
import { isGuardrailsEnforcing } from './inbound-guardrails.service';

export type GenerationPath = 'coalescer' | 'legacy' | 'rag' | 'n8n';

export interface OutputGateInput {
  tenantId: string;
  session: ChatSession;
  channel: string;
  /** The AI-generated reply text about to be sent. */
  content: string;
  /** Replacement text to send in ENFORCE mode when the reply is blocked. */
  fallbackMessage: string;
  generationPath: GenerationPath;
  /** Run-local facts used for backend-backed output checks. */
  validationContext?: OutputValidationContext;
  /** Persisted outbound message id, when known (best-effort link for tuning). */
  outboundMessageId?: string | null;
}

export interface OutputGateDecision {
  /** What the caller must send. Use this even when blocked is false. The gate may strip markdown. */
  content: string;
  /** True when an enforced violation replaced the reply with the fallback. */
  blocked: boolean;
}

async function writeOutputLog(args: {
  session: ChatSession;
  channel: string;
  generationPath: GenerationPath;
  families: string[];
  reasons: string[];
  enforced: boolean;
  outboundMessageId?: string | null;
}): Promise<void> {
  try {
    const repo = AppDataSource.getRepository(GuardrailOutputLog);
    await repo.save(
      repo.create({
        tenantId: args.session.tenantId,
        conversationId: args.session.id,
        sourceChannel: args.channel,
        outboundMessageId: args.outboundMessageId ?? null,
        generationPath: args.generationPath,
        families: args.families,
        reasons: args.reasons,
        enforced: args.enforced,
      }),
    );
  } catch (err) {
    logger.warn('[guardrails] failed to write output log', { sessionId: args.session.id, err });
  }
}

/**
 * Validate an AI-generated reply before sending. Returns the content to send and
 * whether it was blocked. FAIL-OPEN: any unexpected error returns the original
 * content with asterisks stripped. We never drop or replace a reply because validation threw.
 *
 * Callers MUST send `decision.content`. The unblocked path is not a no-op: it
 * strips `*` wrappers the model adds around names and prices.
 *
 * Strip runs once, outside the try, so a validation or config error still
 * returns cleaned text. The enforced fallback is owner-authored and stays as written.
 */
export async function applyOutputGuardrails(input: OutputGateInput): Promise<OutputGateDecision> {
  const cleaned = stripReplyAsterisks(input.content);
  try {
    const result = validateOutput(input.content, input.validationContext);
    if (result.ok) return { content: cleaned, blocked: false };

    const families = [...new Set(result.violations.map((v) => v.family))];
    const reasons = result.violations.map((v) => `${v.family}: ${v.evidence}`);
    const enforce = await isGuardrailsEnforcing(input.tenantId);

    await writeOutputLog({
      session: input.session,
      channel: input.channel,
      generationPath: input.generationPath,
      families,
      reasons,
      enforced: enforce,
      outboundMessageId: input.outboundMessageId,
    });

    if (!enforce) {
      logger.info('[guardrails] output flagged (shadow — reply still sent)', {
        sessionId: input.session.id, path: input.generationPath, families,
      });
      return { content: cleaned, blocked: false };
    }

    logger.warn('[guardrails] output blocked — replacing reply with fallback', {
      sessionId: input.session.id, path: input.generationPath, families,
    });
    return { content: input.fallbackMessage, blocked: true };
  } catch (err) {
    logger.warn('[guardrails] output validation errored - sending stripped reply', {
      sessionId: input.session?.id, err,
    });
    return { content: cleaned, blocked: false };
  }
}
