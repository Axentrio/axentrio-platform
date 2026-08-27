// Global AI Workflow Guardrails — the inbound gate.
//
// Runs BEFORE any AI reasoning (agent / RAG / custom n8n) at the agent-entry
// chokepoints (runTurn, forwardMessageToN8n). Composes the pure classifier +
// bot-loop detector, then in ENFORCE mode hard-blocks high-severity categories
// or returns a neutral reply for low-severity solicitation. In SHADOW mode it
// only logs (no behaviour change). A blocked message is marked
// `guardrail_flagged` so it's excluded from "unanswered/pending" and history
// queries — i.e. it never becomes a turn or leaks into later context.
// See .scratch/plan-global-ai-guardrails.md §1/§4/§6.

import { createHash } from 'crypto';
import { AppDataSource } from '../database/data-source';
import { ChatSession } from '../database/entities/ChatSession';
import { Message } from '../database/entities/Message';
import { Tenant } from '../database/entities/Tenant';
import { SpamScamLog, type GuardrailAction } from '../database/entities/SpamScamLog';
import { returningRows } from '../utils/raw-sql';
import { cached } from '../utils/cache';
import { logger } from '../utils/logger';
import { notificationService } from '../services/notification.service';
import { classifyMessage, inspectLinks, isHighSeverity, isHumanSignal, type LinkInspection } from './classify';
import { detectBotLoop, evaluateLoopState } from './loop-detector';
import { redisLoopStore } from './loop-store';
import { ClassifyResult, GuardrailCategory, GuardrailJournalCategory } from './types';

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

export const SOLICITATION_WARN_REPLIES = {
  en: 'Thank you for reaching out. Your message has been received and can be reviewed by the business owner.',
  nl: 'Bedankt voor uw bericht. Uw bericht is ontvangen en kan door de bedrijfseigenaar worden bekeken.',
  fr: 'Merci de nous avoir contactés. Votre message a bien été reçu et peut être examiné par le propriétaire de l’entreprise.',
} as const;
export const SOLICITATION_WARN_REPLY = SOLICITATION_WARN_REPLIES.en;

/** `proceed: false` ⇒ the caller must NOT run the agent / forward the message. */
export interface InboundGateResult {
  proceed: boolean;
  category: GuardrailCategory;
  /** Platform-authored reply to send instead of running the agent. */
  replyOverride?: string;
}

/** Tenant-scoped enforce flag (cached 60s). Default shadow (false). A toggle
 *  takes effect within the TTL. Used by every ingress path. */
export async function isGuardrailsEnforcing(tenantId: string): Promise<boolean> {
  // Global break-glass: GUARDRAILS_KILL_SWITCH=true instantly disables ALL
  // enforcement (every tenant falls back to shadow), regardless of per-tenant flag.
  if (process.env.GUARDRAILS_KILL_SWITCH === 'true') return false;
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

/** Flag a message so it leaves the unanswered window and the agent's history.
 *  Returns false when the write did not land — callers that treat a flag as
 *  terminal MUST NOT report a block in that case. */
async function markMessageFlagged(messageId: string): Promise<boolean> {
  try {
    await AppDataSource.getRepository(Message).update(messageId, { guardrailFlagged: true, guardrailChecked: true });
    return true;
  } catch (err) {
    logger.error('[guardrails] failed to mark message flagged', { messageId, err });
    return false;
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

async function solicitationWarnReply(tenantId: string): Promise<string> {
  try {
    const tenant = await AppDataSource.getRepository(Tenant).findOne({
      where: { id: tenantId },
      select: { id: true, settings: true } as never,
    });
    const language = tenant?.settings?.onboarding?.language;
    return SOLICITATION_WARN_REPLIES[
      language as keyof typeof SOLICITATION_WARN_REPLIES
    ] ?? SOLICITATION_WARN_REPLY;
  } catch {
    return SOLICITATION_WARN_REPLY;
  }
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
  messageId: string | null;
  category: GuardrailJournalCategory;
  reasons: string[];
  score: number | null;
  suspiciousLink: boolean;
  repeated: boolean;
  botLoop: boolean;
  enforced: boolean;
  action: GuardrailAction;
  notified: boolean;
  aiAutoReplyDisabled?: boolean;
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
        aiAutoReplyDisabled: args.aiAutoReplyDisabled ?? args.enforced,
        notificationSent: args.notified,
        score: args.score,
        reasons: args.reasons,
        enforced: args.enforced,
        action: args.action,
      }),
    );
  } catch (err) {
    logger.warn('[guardrails] failed to write spam/scam log', { sessionId: args.session.id, err });
  }
}

/** Has this message already been journalled with `action`? A warn leaves no flag,
 *  so unlike a block it has no natural dedupe: a replayed solicitation would
 *  journal itself again on every stale turn. */
async function alreadyJournalled(messageId: string, action: GuardrailAction): Promise<boolean> {
  try {
    return await AppDataSource.getRepository(SpamScamLog).existsBy({
      suspiciousMessageId: messageId,
      action,
    });
  } catch (err) {
    // A read failure must not suppress the reply; at worst we journal twice.
    logger.warn('[guardrails] journal lookup failed', { messageId, action, err });
    return false;
  }
}

/** Warn on a low-severity solicitation: journal it once, then answer with the
 *  neutral platform reply instead of running the agent. Shared by the first pass
 *  and by a replay, so a stale turn reports the same warn the first pass would. */
async function warnSolicitation(args: {
  session: ChatSession;
  tenantId: string;
  channel: string;
  messageId: string;
  reasons: string[];
  score: number | null;
  suspiciousLink: boolean;
  repeated: boolean;
  replay?: boolean;
}): Promise<InboundGateResult> {
  const { session, reasons } = args;
  if (!(await alreadyJournalled(args.messageId, 'warn_reply'))) {
    await writeSpamLog({
      session, channel: args.channel, messageId: args.messageId,
      category: 'solicitation', reasons, score: args.score,
      suspiciousLink: args.suspiciousLink, repeated: args.repeated, botLoop: false,
      enforced: false, notified: false, aiAutoReplyDisabled: false,
      action: 'warn_reply',
    });
    logger.info('[guardrails] warned on inbound solicitation', {
      sessionId: session.id, category: 'solicitation', reasons, replay: args.replay === true,
    });
  }
  return {
    proceed: true,
    category: 'solicitation',
    replyOverride: await solicitationWarnReply(args.tenantId),
  };
}

/** Journal a routing-isolation drop. `enforced=true` records the block action. */
export async function writeRoutingDropLog(
  session: ChatSession,
  messageId: string | null,
  category: 'missing_tenant' | 'missing_bot',
  reason: string,
): Promise<void> {
  await writeSpamLog({
    session,
    channel: session.channel,
    messageId,
    category,
    reasons: [reason],
    score: null,
    suspiciousLink: false,
    repeated: false,
    botLoop: false,
    enforced: true,
    action: 'blocked',
    notified: false,
    aiAutoReplyDisabled: false,
  });
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

/** Enforce a block: flag the message, pause the session (only the first flip
 *  notifies the owner), then journal it.
 *
 *  Shared by the first pass and by a replay that reaches the same verdict. A
 *  replay is NOT always a duplicate: a message gated while the tenant was still
 *  in shadow mode carries no flag, so when the owner turns enforcement on, the
 *  replay is the FIRST enforced verdict for that message and owes the whole
 *  epilogue. Re-running it after a concurrent first pass is safe — the flag is
 *  idempotent, `atomicDisableAutoReply` flips once, and the owner notification
 *  dedupes per session — at the cost of at most one duplicate journal row,
 *  which beats an enforced block that nobody can see.
 */
async function enforceBlock(args: {
  session: ChatSession;
  channel: string;
  messageId: string;
  category: GuardrailCategory;
  reasons: string[];
  score: number | null;
  suspiciousLink: boolean;
  repeated: boolean;
  botLoop: boolean;
  replay?: boolean;
}): Promise<InboundGateResult> {
  const { session, category, reasons } = args;
  // The flag is what removes this message from the unanswered window and from
  // history. If it does not land, the caller must NOT report a terminal block:
  // the message would be re-gated forever and the bot would go silent on a
  // session that still shows 'bot'. Throwing lets the coalescer re-arm.
  if (!(await markMessageFlagged(args.messageId))) {
    throw new Error(`[guardrails] could not flag message ${args.messageId} (${category})`);
  }
  const firstFlip = await atomicDisableAutoReply(session.id, category);
  if (firstFlip) {
    session.aiAutoReplyEnabled = false;
    session.guardrailStatus = category;
    await notifyOwner(session, category, reasons);
  }
  await writeSpamLog({
    session, channel: args.channel, messageId: args.messageId, category, reasons,
    score: args.score, suspiciousLink: args.suspiciousLink, repeated: args.repeated,
    botLoop: args.botLoop, enforced: true, notified: firstFlip, action: 'blocked',
  });
  logger.info('[guardrails] blocked inbound message', {
    sessionId: session.id, category, reasons, firstFlip, replay: args.replay === true,
  });
  return { proceed: false, category };
}

/** Fast-exit for an already guardrail-disabled session (ENFORCE only): it never
 *  re-runs the agent. Re-reads the flag from the DB (not the possibly-stale
 *  in-memory session) so a concurrent flip on a sibling burst message is
 *  respected (codex review). Marks this inbound so it can't leak into history
 *  after reactivation. Returns null when the session is not disabled. */
async function disabledSessionResult(
  input: InboundGateInput,
  enforce: boolean,
): Promise<InboundGateResult | null> {
  if (!enforce) return null;
  const { session, message } = input;
  const fresh = await AppDataSource.getRepository(ChatSession).findOne({
    where: { id: session.id },
    select: { id: true, aiAutoReplyEnabled: true, guardrailStatus: true } as never,
  });
  if (!fresh || fresh.aiAutoReplyEnabled !== false) return null;
  await markMessageFlagged(message.id);
  session.aiAutoReplyEnabled = false;
  session.guardrailStatus = fresh.guardrailStatus;
  return { proceed: false, category: (fresh.guardrailStatus as GuardrailCategory) || 'spam' };
}

/** The already-gated path (this run LOST the claim): reach the SAME verdict as
 *  the claiming run without re-running its side effects.
 *
 *  `guardrail_flagged` is the durable block bit. Everything else is re-derived,
 *  for two reasons: a CLEAN first pass deliberately persists nothing (so
 *  "claimed, unflagged, no log row" is the normal state of healthy traffic, and
 *  blocking it froze conversations for good), and the SpamScamLog `action`
 *  column is not a reliable control plane (legacy enforced blocks are stored as
 *  'log_only'). classifyMessage is pure, so a rejected message still never
 *  reaches the agent. The loop counters are PEEKED, never advanced: the claiming
 *  run advances them itself (a peek that lands between the claim and that
 *  advance sees the state without this message — the claiming run still blocks
 *  and pauses the session a moment later). */
async function replayGate(input: InboundGateInput, enforce: boolean): Promise<InboundGateResult> {
  const { session, tenantId, message, content, channel } = input;
  if (await readFlagged(message.id)) {
    const status = session.guardrailStatus;
    return {
      proceed: false,
      category: status && status !== 'normal' ? (status as GuardrailCategory) : 'spam',
    };
  }
  if (!enforce) return { proceed: true, category: 'clean' };
  const replayLinks = inspectLinks(content);
  const replay = classifyMessage(content, channel, replayLinks);
  const warnOnly = replay.category === 'solicitation' && !isHighSeverity(content, replayLinks);
  // A reject runs the SAME epilogue as the first pass: flag, pause, journal.
  // An unflagged reject stays in the unanswered window, so every later turn
  // re-blocks on it and the bot goes silent on a session that still shows
  // 'bot' — the freeze, one layer down.
  if (replay.category !== 'clean' && !warnOnly) {
    return enforceBlock({
      session, channel, messageId: message.id, category: replay.category,
      reasons: replay.reasons, score: replay.score,
      suspiciousLink: replayLinks.score > 0 || replay.links.length > 0,
      repeated: false, botLoop: false, replay: true,
    });
  }
  // A sustained loop outranks the solicitation warning, as in the first pass.
  const loop = evaluateLoopState(await redisLoopStore.peek(session.id));
  if (loop.isLoop) {
    return enforceBlock({
      session, channel, messageId: message.id, category: 'bot_loop',
      reasons: loop.reasons, score: null, suspiciousLink: replayLinks.score > 0,
      repeated: loop.reasons.some((r) => r.includes('repeated')), botLoop: true, replay: true,
    });
  }
  if (warnOnly) {
    return warnSolicitation({
      session, tenantId, channel, messageId: message.id, reasons: replay.reasons,
      score: replay.score, suspiciousLink: replayLinks.score > 0 || replay.links.length > 0,
      repeated: false, replay: true,
    });
  }
  return { proceed: true, category: 'clean' };
}

/** Advance the Redis loop counters for the run that WON the claim. Fails open —
 *  a turn is never blocked because loop detection errored. */
async function detectInboundLoop(args: {
  sessionId: string;
  content: string;
  flaggedByContent: boolean;
  humanSignal: boolean;
  suspiciousLink: boolean;
}): Promise<{ hit: boolean; reasons: string[] }> {
  try {
    const r = await detectBotLoop(redisLoopStore, args.sessionId, {
      hash: normalizedHash(args.content),
      // Human-typical short messages reset loop streaks. Other clean, non-empty
      // content is substantive; exact repeats are handled in the reducer.
      meaningful: !args.flaggedByContent && args.content.trim().length > 0 && !args.humanSignal,
      humanSignal: args.humanSignal,
      hasSuspiciousLink: args.suspiciousLink,
    });
    return { hit: r.isLoop, reasons: r.reasons };
  } catch {
    return { hit: false, reasons: [] };
  }
}

/** Turn the classifier + loop signals into the reported verdict. */
function deriveInboundVerdict(args: {
  content: string;
  linkInfo: LinkInspection;
  classified: ClassifyResult;
  flaggedByContent: boolean;
  loopHit: boolean;
  loopReasons: string[];
}): {
  category: GuardrailCategory;
  reasons: string[];
  repeated: boolean;
  solicitationWarnOnly: boolean;
} {
  const { classified: c, flaggedByContent, loopHit, loopReasons } = args;
  // A sustained solicitation loop is still a high-severity bot_loop.
  const solicitationWarnOnly =
    flaggedByContent &&
    c.category === 'solicitation' &&
    !loopHit &&
    !isHighSeverity(args.content, args.linkInfo);
  const category: GuardrailCategory = loopHit && c.category === 'solicitation'
    ? 'bot_loop'
    : flaggedByContent ? c.category : 'bot_loop';
  const reasons = category === 'bot_loop' ? loopReasons : c.reasons;
  const repeated = loopReasons.some((r) => r.includes('repeated'));
  return { category, reasons, repeated, solicitationWarnOnly };
}

/**
 * Evaluate an inbound user message. Must be called under the caller's per-session
 * lock (runTurn under the coalescer lock; the legacy path is best-effort). Returns
 * `proceed: false` only in ENFORCE mode for high-severity categories or when the
 * session is already guardrail-disabled. Solicitation returns a neutral reply.
 */
export async function runInboundGate(input: InboundGateInput): Promise<InboundGateResult> {
  const { session, tenantId, message, content, channel } = input;
  const enforce = await isGuardrailsEnforcing(tenantId);

  const disabled = await disabledSessionResult(input, enforce);
  if (disabled) return disabled;

  // Idempotency: claim the message exactly once, so the loop counters are only
  // advanced (and the outcome only logged) by the run that wins the claim. The
  // loser replays the same verdict without the side effects (see `replayGate`).
  if (!(await claimMessage(message.id))) return replayGate(input, enforce);

  const linkInfo = inspectLinks(content);
  const c = classifyMessage(content, channel, linkInfo);
  const flaggedByContent = c.category !== 'clean';
  const hasWeakRiskLink = linkInfo.score > 0;
  const humanSignal = !flaggedByContent && isHumanSignal(content, linkInfo) && !hasWeakRiskLink;
  const suspiciousLink = hasWeakRiskLink || c.category === 'suspicious_link'
    || (c.links.length > 0 && flaggedByContent);

  const loop = await detectInboundLoop({
    sessionId: session.id, content, flaggedByContent, humanSignal, suspiciousLink,
  });
  const loopHit = loop.hit;

  if (!flaggedByContent && !loopHit) return { proceed: true, category: 'clean' };

  const { category, reasons, repeated, solicitationWarnOnly } = deriveInboundVerdict({
    content, linkInfo, classified: c, flaggedByContent, loopHit, loopReasons: loop.reasons,
  });

  if (!enforce) {
    // Shadow mode: observe + log only. No flag, no disable, no behaviour change.
    await writeSpamLog({
      session, channel, messageId: message.id, category, reasons,
      score: flaggedByContent ? c.score : null,
      suspiciousLink, repeated, botLoop: loopHit, enforced: false, notified: false,
      action: 'log_only',
    });
    return { proceed: true, category: 'clean' };
  }

  if (solicitationWarnOnly) {
    return warnSolicitation({
      session, tenantId, channel, messageId: message.id, reasons,
      score: c.score, suspiciousLink, repeated,
    });
  }

  // Enforce: flag the message, pause the session, journal the block.
  return enforceBlock({
    session, channel, messageId: message.id, category, reasons,
    score: flaggedByContent ? c.score : null,
    suspiciousLink, repeated, botLoop: loopHit,
  });
}
