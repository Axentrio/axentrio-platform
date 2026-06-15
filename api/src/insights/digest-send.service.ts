/**
 * Digest email outbox reconciler (P3 / ADR-0014, D6).
 *
 * The digest row IS the outbox. Sending is a claim-based lease so a crash or a
 * concurrent run can never double-deliver:
 *   1. Atomically claim ONE due row (state → 'sending', lease + attempt++),
 *      skipping rows another worker holds (FOR UPDATE SKIP LOCKED).
 *   2. Send via Resend with a STABLE idempotency key per (tenant, week) — if we
 *      crash after Resend accepted but before we commit 'sent', the re-send
 *      dedupes at the provider.
 *   3. Finalize: 'sent' (terminal), or 'failed' with bounded backoff. After
 *      MAX_ATTEMPTS the row is terminal — send_next_attempt_at = NULL, so the
 *      due query never reclaims it.
 */
import { AppDataSource } from '../database/data-source';
import { InsightDigest } from '../database/entities/InsightDigest';
import { EmailService } from '../automations/email.service';
import { resolveBillingEmail } from '../billing/service';
import { signUnsubscribeToken } from './digest-token';
import { config } from '../config/environment';
import { logger } from '../utils/logger';
import type { DigestMetrics } from '../contracts/insights';

const LEASE_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 30 * 60 * 1000;
const BACKOFF_CAP_MS = 24 * 60 * 60 * 1000;
const BATCH_CAP = 50;

let _email: EmailService | null = null;
function getEmail(): EmailService {
  if (!_email) _email = new EmailService(config.email.resendApiKey, config.email.fromAddress);
  return _email;
}
/** Test seam — reset the memoized EmailService. */
export function __resetDigestEmailService(): void {
  _email = null;
}

interface ClaimedDigest {
  id: string;
  tenant_id: string;
  week_start: string;
  summary_md: string;
  metrics: DigestMetrics;
  send_attempts: number;
}

/** Backoff for the Nth attempt (1-based): 30m, 1h, 2h, 4h … capped at 24h. */
function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_CAP_MS);
}

async function claimOne(now: Date): Promise<ClaimedDigest | null> {
  const claimedUntil = new Date(now.getTime() + LEASE_MS);
  const rows: ClaimedDigest[] = await AppDataSource.query(
    `UPDATE chatbot_insight_digests
        SET send_state = 'sending',
            send_started_at = $1,
            send_claimed_until = $2,
            send_attempts = send_attempts + 1,
            updated_at = now()
      WHERE id = (
        SELECT id FROM chatbot_insight_digests
         WHERE send_state IN ('pending', 'failed')
           AND send_next_attempt_at IS NOT NULL
           AND send_next_attempt_at <= $1
           AND (send_claimed_until IS NULL OR send_claimed_until < $1)
         ORDER BY send_next_attempt_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
      )
      -- week_start::text — node-postgres parses a bare date column into a JS
      -- Date (local midnight), which stringifies to an ugly locale string in
      -- the subject/body and risks a toISOString off-by-one. Keep YYYY-MM-DD.
      RETURNING id, tenant_id, week_start::text AS week_start, summary_md, metrics, send_attempts`,
    [now, claimedUntil],
  ).then((r: [ClaimedDigest[], number] | ClaimedDigest[]) =>
    // node-postgres UPDATE…RETURNING returns rows directly; guard both shapes.
    Array.isArray(r[0]) ? (r[0] as ClaimedDigest[]) : (r as ClaimedDigest[]),
  );
  return rows[0] ?? null;
}

async function markSent(id: string, providerMessageId: string | undefined): Promise<void> {
  await AppDataSource.getRepository(InsightDigest).update(id, {
    sendState: 'sent',
    providerMessageId: providerMessageId ?? null,
    sendNextAttemptAt: null,
    sendClaimedUntil: null,
    lastSendError: null,
  });
}

async function markFailed(claim: ClaimedDigest, now: Date, error: string): Promise<void> {
  const terminal = claim.send_attempts >= MAX_ATTEMPTS;
  await AppDataSource.getRepository(InsightDigest).update(claim.id, {
    sendState: 'failed',
    sendClaimedUntil: null,
    sendNextAttemptAt: terminal ? null : new Date(now.getTime() + backoffMs(claim.send_attempts)),
    lastSendError: error.slice(0, 500),
  });
  logger.warn('[insights-digest-send] send failed', {
    tenantId: claim.tenant_id, attempts: claim.send_attempts, terminal, error,
  });
}

/** Process due digests until the batch cap is hit or no claimable rows remain. */
export async function sendDueDigests(now = new Date()): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;

  for (let i = 0; i < BATCH_CAP; i++) {
    const claim = await claimOne(now);
    if (!claim) break;

    try {
      const to = await resolveBillingEmail(claim.tenant_id);
      const token = signUnsubscribeToken(claim.tenant_id);
      const unsubUrl = `${config.api.url}/api/v1/unsubscribe/digest?token=${encodeURIComponent(token)}`;
      const html = renderDigestEmail(claim, unsubUrl);

      const result = await getEmail().send({
        to,
        subject: `Your weekly business summary — week of ${claim.week_start}`,
        body: html,
        idempotencyKey: `digest:${claim.tenant_id}:${claim.week_start}`,
        headers: {
          'List-Unsubscribe': `<${unsubUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      });

      if (result.success) {
        await markSent(claim.id, result.messageId);
        sent++;
      } else {
        await markFailed(claim, now, result.error ?? 'send returned failure');
        failed++;
      }
    } catch (err) {
      await markFailed(claim, now, err instanceof Error ? err.message : 'unknown');
      failed++;
    }
  }

  if (sent || failed) logger.info('[insights-digest-send] reconciled', { sent, failed });
  return { sent, failed };
}

function pctLabel(current: number, previous: number): string {
  if (previous === 0) return current > 0 ? 'new' : '—';
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return 'flat';
  return `${pct > 0 ? '▲' : '▼'} ${Math.abs(pct)}%`;
}

function row(label: string, m: { current: number; previous: number }): string {
  return `<tr>
    <td style="padding:8px 0;color:#475569;">${label}</td>
    <td style="padding:8px 0;text-align:right;font-weight:600;color:#0f172a;">${m.current}</td>
    <td style="padding:8px 0;text-align:right;color:#64748b;">${pctLabel(m.current, m.previous)}</td>
  </tr>`;
}

/** Minimal, dependency-free inline-styled HTML — renders in every mail client. */
export function renderDigestEmail(claim: ClaimedDigest, unsubUrl: string): string {
  const m = claim.metrics;
  return `<!doctype html><html><body style="margin:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:24px;">
    <div style="background:#ffffff;border-radius:12px;padding:28px;">
      <h1 style="margin:0 0 4px;font-size:18px;color:#0f172a;">Your weekly business summary</h1>
      <p style="margin:0 0 20px;color:#64748b;font-size:13px;">Week of ${claim.week_start}</p>
      <p style="margin:0 0 20px;color:#334155;font-size:15px;line-height:1.5;">${escapeHtml(claim.summary_md)}</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px;border-top:1px solid #e2e8f0;">
        ${row('Conversations', m.conversations)}
        ${row('Bookings', m.bookings)}
        ${row('Leads', m.leads)}
        <tr><td style="padding:8px 0;color:#475569;">Unanswered topics opened</td>
            <td colspan="2" style="padding:8px 0;text-align:right;font-weight:600;color:#0f172a;">${m.gapsOpened}</td></tr>
        <tr><td style="padding:8px 0;color:#475569;">Topics resolved</td>
            <td colspan="2" style="padding:8px 0;text-align:right;font-weight:600;color:#0f172a;">${m.gapsWon}</td></tr>
      </table>
    </div>
    <p style="text-align:center;color:#94a3b8;font-size:12px;margin:18px 0 0;">
      <a href="${unsubUrl}" style="color:#94a3b8;">Unsubscribe from these weekly summaries</a>
    </p>
  </div>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string),
  );
}
