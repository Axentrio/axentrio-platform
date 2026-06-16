// Global AI Workflow Guardrails — the inbound gate.
//
// Runs BEFORE any AI reasoning (agent / RAG / custom n8n) at the agent-entry
// chokepoints (runTurn, forwardMessageToN8n). Composes the pure classifier +
// bot-loop detector, then in ENFORCE mode blocks + disables auto-reply + logs +
// notifies; in SHADOW mode it only logs (no behaviour change). A blocked message
// is marked `guardrail_flagged` so it's excluded from "unanswered/pending" and
// history queries — i.e. it never becomes a turn or leaks into later context.
// See .scratch/plan-global-ai-guardrails.md §1/§4/§6.

import { createHash } from 'crypto';
import { AppDataSource } from '../database/data-source';
import { ChatSession } from '../database/entities/ChatSession';
import { Message } from '../database/entities/Message';
import { Tenant } from '../database/entities/Tenant';
import { SpamScamLog } from '../database/entities/SpamScamLog';
import { returningRows } from '../utils/raw-sql';
import { cached } from '../utils/cache';
import { logger } from '../utils/logger';
import { notificationService } from '../services/notification.service';
import { classifyMessage } from './classify';
import { detectBotLoop } from './loop-detector';
import { redisLoopStore } from './loop-store';
import { GuardrailCategory } from './types';

export interface InboundGateInput {
  session: ChatSession;
  tenantId: string;
  /** The inbound user message (used for ids + flagging). */
  message: Message;
  /** Decrypted text content of the message. */
  content: string;
  /** Originating channel (widget | whatsapp | messenger | …). */
  channel: string;
}

/** `proceed: false` ⇒ the caller must NOT run the agent / forward the message. */
export interface InboundGateResult {
  proceed: boolean;
  category: GuardrailCategory;
}

/** Tenant-scoped enforce flag (cached 60s). Default shadow (false). A toggle
 *  takes effect within the TTL. Used by every ingress path. */
export async function isGuardrailsEnforcing(tenantId: string): Promise<boolean> {
  try {
    return await cached(`guardrails:enforce:${tenantId}`, 60, async () => {
      const t = await AppDataSource.getRepository(Tenant).findOne({
        where: { id: tenantId },
        select: { id: true, settings: true } as never,
      });
      return t?.settings?.guardrails?.enforce === true;
    });
  } catch {
    return false;
  }
}

function normalizedHash(text: string): string {
  return createHash('sha1').update(text.trim().toLowerCase().replace(/\s+/g, ' ')).digest('hex');
}

async function markMessageFlagged(messageId: string): Promise<void> {
  try {
    await AppDataSource.getRepository(Message).update(messageId, { guardrailFlagged: true, guardrailChecked: true });
  } catch (err) {
    logger.warn('[guardrails] failed to mark message flagged', { messageId, err });
  }
}

/** Atomically claim this message for gating (exactly-once). Returns true if THIS
 *  call claimed it (proceed to classify); false if it was already gated. */
async function claimMessage(messageId: string): Promise<boolean> {
  const rows = returningRows<{ id: string }>(
    await AppDataSource.query(
      `UPDATE messages SET guardrail_checked = true WHERE id = $1 AND guardrail_checked = false RETURNING id`,
      [messageId],
    ),
  );
  return rows.length === 1;
}

/** Re-read whether a message was flagged (for the already-gated idempotent path). */
async function readFlagged(messageId: string): Promise<boolean> {
  const m = await AppDataSource.getRepository(Message).findOne({
    where: { id: messageId }, select: { id: true, guardrailFlagged: true } as never,
  });
  return m?.guardrailFlagged === true;
}

/** Atomic, idempotent session flip — only the FIRST flip returns true (so a burst
 *  can't double-notify). */
async function atomicDisableAutoReply(sessionId: string, category: GuardrailCategory): Promise<boolean> {
  const rows = returningRows<{ id: string }>(
    await AppDataSource.query(
      `UPDATE chat_sessions
          SET ai_auto_reply_enabled = false, guardrail_status = $2
        WHERE id = $1 AND ai_auto_reply_enabled = true
      RETURNING id`,
      [sessionId, category],
    ),
  );
  return rows.length === 1;
}

async function writeSpamLog(args: {
  session: ChatSession;
  channel: string;
  messageId: string;
  category: GuardrailCategory;
  reasons: string[];
  score: number | null;
  suspiciousLink: boolean;
  repeated: boolean;
  botLoop: boolean;
  enforced: boolean;
  notified: boolean;
}): Promise<void> {
  try {
    await AppDataSource.getRepository(SpamScamLog).save(
      AppDataSource.getRepository(SpamScamLog).create({
        tenantId: args.session.tenantId,
        conversationId: args.session.id,
        sourceChannel: args.channel,
        suspiciousMessageId: args.messageId,
        detectedCategory: args.category,
        suspiciousLinksDetected: args.suspiciousLink,
        repeatedMessageDetected: args.repeated,
        botLoopDetected: args.botLoop,
        aiAutoReplyDisabled: args.enforced,
        notificationSent: args.notified,
        score: args.score,
        reasons: args.reasons,
        enforced: args.enforced,
      }),
    );
  } catch (err) {
    logger.warn('[guardrails] failed to write spam/scam log', { sessionId: args.session.id, err });
  }
}

async function notifyOwner(session: ChatSession, category: GuardrailCategory, reasons: string[]): Promise<void> {
  try {
    await notificationService.createForTenant({
      tenantId: session.tenantId,
      type: 'guardrail.flagged',
      title: 'A conversation was flagged for review',
      message: `A conversation was paused (${category}). Review it in the inbox and re-enable AI replies if it's legitimate.`,
      dedupeBase: `guardrail:${session.id}`,
      data: { sessionId: session.id, category, reasons },
    });
  } catch (err) {
    logger.warn('[guardrails] owner notification failed', { sessionId: session.id, err });
  }
}

/**
 * Evaluate an inbound user message. Must be called under the caller's per-session
 * lock (runTurn under the coalescer lock; the legacy path is best-effort). Returns
 * `proceed: false` only in ENFORCE mode when the message is spam/scam/bot-loop or
 * the session is already guardrail-disabled.
 */
export async function runInboundGate(input: InboundGateInput): Promise<InboundGateResult> {
  const { session, tenantId, message, content, channel } = input;
  const enforce = await isGuardrailsEnforcing(tenantId);

  // Fast-exit: an already guardrail-disabled session never re-runs the agent.
  // Re-read the flag from the DB (not the possibly-stale in-memory session) so a
  // concurrent flip on a sibling burst message is respected (codex review). Mark
  // this inbound so it can't leak into history after reactivation.
  if (enforce) {
    const fresh = await AppDataSource.getRepository(ChatSession).findOne({
      where: { id: session.id },
      select: { id: true, aiAutoReplyEnabled: true, guardrailStatus: true } as never,
    });
    if (fresh && fresh.aiAutoReplyEnabled === false) {
      await markMessageFlagged(message.id);
      session.aiAutoReplyEnabled = false;
      session.guardrailStatus = fresh.guardrailStatus;
      return { proceed: false, category: (fresh.guardrailStatus as GuardrailCategory) || 'spam' };
    }
  }

  // Idempotency: claim the message exactly once. If it was already gated (legacy
  // entry + coalescer window can both reach a message; a 'stale' re-run re-scans
  // the window), return the prior outcome without re-classifying / re-logging /
  // double-counting loop counters.
  if (!(await claimMessage(message.id))) {
    const flagged = await readFlagged(message.id);
    return { proceed: !flagged, category: flagged ? 'spam' : 'clean' };
  }

  const c = classifyMessage(content, channel);
  const flaggedByContent = c.category !== 'clean';
  const suspiciousLink = c.category === 'suspicious_link' || (c.links.length > 0 && flaggedByContent);

  let loopHit = false;
  let loopReasons: string[] = [];
  try {
    const r = await detectBotLoop(redisLoopStore, session.id, {
      hash: normalizedHash(content),
      // Genuine progress = a clean, substantive message; flagged/empty or an
      // exact repeat (handled in the reducer) counts as non-progressing.
      meaningful: !flaggedByContent && content.trim().length > 0,
      hasSuspiciousLink: suspiciousLink,
    });
    loopHit = r.isLoop;
    loopReasons = r.reasons;
  } catch {
    /* fail open — never block a turn because loop detection errored */
  }

  if (!flaggedByContent && !loopHit) return { proceed: true, category: 'clean' };

  const category: GuardrailCategory = flaggedByContent ? c.category : 'bot_loop';
  const reasons = flaggedByContent ? c.reasons : loopReasons;
  const repeated = loopReasons.some((r) => r.includes('repeated'));

  if (!enforce) {
    // Shadow mode: observe + log only. No flag, no disable, no behaviour change.
    await writeSpamLog({
      session, channel, messageId: message.id, category, reasons,
      score: flaggedByContent ? c.score : null,
      suspiciousLink, repeated, botLoop: loopHit, enforced: false, notified: false,
    });
    return { proceed: true, category: 'clean' };
  }

  // Enforce: mark the message, atomically disable the session (first flip notifies).
  await markMessageFlagged(message.id);
  const firstFlip = await atomicDisableAutoReply(session.id, category);
  if (firstFlip) {
    session.aiAutoReplyEnabled = false;
    session.guardrailStatus = category;
    await notifyOwner(session, category, reasons);
  }
  await writeSpamLog({
    session, channel, messageId: message.id, category, reasons,
    score: flaggedByContent ? c.score : null,
    suspiciousLink, repeated, botLoop: loopHit, enforced: true, notified: firstFlip,
  });

  logger.info('[guardrails] blocked inbound message', {
    sessionId: session.id, category, reasons, firstFlip,
  });
  return { proceed: false, category };
}
