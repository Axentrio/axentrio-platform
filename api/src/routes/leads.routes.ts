/**
 * Leads inbox API.
 *
 * Backs the `/leads` portal page. Returns a cursor-paginated list of
 * the tenant's captured leads, newest first. Cursor is the
 * `(created_at, id)` of the last row in the previous page — opaque to
 * the client, base64 of `"<ISO timestamp>|<UUID>"`.
 *
 * Audit gap #5 closure: the `leadCapture` entitlement flag was
 * previously declared but had zero `requireFeature` consumer. This
 * route is the first real gate. Essential and Pro both have
 * `leadCapture: true`; Free / Enterprise are open via the catalog.
 */
import { Router, Request, Response } from 'express';
import { AppDataSource } from '../database/data-source';
import { Lead } from '../database/entities/Lead';
import { requireClerkAuth, autoProvision } from '../middleware/clerk.middleware';
import { resolveTenantContext } from '../middleware/super-admin.middleware';
import { requireRole } from '../middleware/auth.middleware';
import { timeoutMiddleware } from '../middleware/timeout.middleware';
import { asyncHandler, BadRequestError, NotFoundError } from '../middleware/error-handler';
import { sendSuccess } from '../utils/response';
import { requireFeature } from '../billing/enforce';
import { getEntitlements } from '../billing/entitlements';
import {
  getExporter,
  toCsv,
  toXlsx,
  INTERCHANGE_CSV,
  XLSX_CONTENT_TYPE,
  type ExportFormat,
} from '../analytics/exporters';
import { eraseLead } from '../leads/lead-erasure.service';
import { computeLeadReadiness } from '../leads/readiness';
import { recommendFollowUp } from '../leads/followup';
import { upsertLead } from '../leads/lead-capture.service';
import { isErasedDedupeKey } from '../leads/lead-tombstone';
import { previewLeadImport } from '../leads/lead-import.service';
import {
  readRetentionDays,
  MIN_RETENTION_DAYS,
  MAX_RETENTION_DAYS,
} from '../leads/lead-retention.service';
import { logAudit } from '../utils/audit';
import { buildIntakeAnswers } from '../booking/intake-answers';
import type { IntakeQuestion } from '../database/entities/ServiceType';

const router = Router();

router.use(requireClerkAuth, autoProvision, resolveTenantContext);

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/** Closed sets for the list filters. Values reach SQL, so they are matched, never interpolated. */
const ALLOWED_CHANNELS: ReadonlySet<string> = new Set([
  'widget',
  'whatsapp',
  'messenger',
  'instagram',
  'telegram',
]);
const ALLOWED_SOURCES: ReadonlySet<string> = new Set([
  'channel',
  'tool',
  'booking',
  'manual',
  'import',
  'webhook',
]);

/** Webhook URLs frequently embed a token in the path (Zapier, Make). Show the host
 *  only, so a delivery view never leaks the endpoint's secret to a viewer. */
function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'unknown';
  }
}

/** node-pg returns `numeric` as a string; keep it a number or null on the wire. */
function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Repeat detection, read from the two cached columns the nightly sweep maintains.
 *
 * Extracted so the wire flag, the readiness score and the follow-up recommendation all
 * ask the same question of the same columns — three copies of `> 1` in this file would
 * be three definitions of "returning" waiting to drift apart.
 *
 * The row's own `conversation_count` is the floor used until the sweep has seen the row:
 * a person's conversations always include their own, so the fallback can only ever
 * under-report, never invent a repeat.
 */
function personRepeat(l: Record<string, unknown>) {
  const rowConversations = (l.conversation_count as number | null) ?? 0;
  const personConversationCount = (l.person_conversation_count as number | null) ?? rowConversations;
  const personLeadCount = (l.person_lead_count as number | null) ?? 1;
  return {
    rowConversations,
    personConversationCount,
    personLeadCount,
    // More than one conversation, or more than one identity row (the WhatsApp-then-widget
    // case, and the only signal an imported contact with no conversation rows can produce).
    isRepeatCustomer: personConversationCount > 1 || personLeadCount > 1,
  };
}

/**
 * Enterprise's recommended follow-up action.
 *
 * Gated on `aiBusinessInsights` SEPARATELY from the Pro structured fields below, even
 * though every plan that has one has the other today: they are different promises, and
 * folding this into the `leadEnrichment` projection would silently ship an Enterprise
 * feature the day a plan gains enrichment alone.
 *
 * Deterministic — see followup.ts for why this is not an LLM call, and for the fact that
 * it is advisory only until a worklist exists to give it an outcome.
 */
/**
 * When anyone last had contact with this person — NOT when the record was created.
 * A lead answered yesterday but first seen a year ago has waited a day, not a year.
 * Shared by the follow-up rule and the list DTO so the "waiting" figure on screen and
 * the reason inside the recommendation are the same number by construction.
 */
function lastContactOf(l: Record<string, unknown>): string | null {
  return (l.person_last_seen_at as string | null) ?? (l.updated_at as string | null);
}

function projectFollowUp(l: Record<string, unknown>) {
  return recommendFollowUp({
    status: l.status as string | null,
    phone: l.phone as string | null,
    email: l.email as string | null,
    channel: l.channel as string | null,
    notes: l.notes as string | null,
    serviceRequested: (l.service_name as string | null) ?? (l.extracted_service as string | null),
    address: (l.customer_address as string | null) ?? (l.extracted_address as string | null),
    bookingId: l.booking_id as string | null,
    bookingStatus: l.booking_status as string | null,
    bookingStartAt: l.start_utc as string | null,
    bookingEndAt: l.end_utc as string | null,
    personHasUpcomingBooking: l.person_has_upcoming_booking === true,
    isRepeatCustomer: personRepeat(l).isRepeatCustomer,
    createdAt: l.created_at as string | null,
    lastContactAt: lastContactOf(l),
  });
}

/**
 * Derive the Pro structured fields from the joined booking.
 *
 * `servicePrice` is the tenant's OWN list price for the requested service, not an
 * estimate — hence `priceBasis`, so the UI can label it honestly ("from €80" is not
 * "€80"). `on_request` and `none` yield no number at all rather than a guess: a
 * fabricated monetary figure attached to a named person is inaccurate personal data
 * the subject could demand be rectified.
 */
function projectBookingFields(l: Record<string, unknown>) {
  const display = (l.price_display_type as string | null) ?? 'none';
  let servicePrice: number | null = null;
  let priceBasis: 'fixed' | 'from' | 'range_mid' | 'none' = 'none';
  if (display === 'fixed') {
    servicePrice = num(l.fixed_price);
    priceBasis = servicePrice === null ? 'none' : 'fixed';
  } else if (display === 'from') {
    servicePrice = num(l.min_price);
    priceBasis = servicePrice === null ? 'none' : 'from';
  } else if (display === 'range') {
    const lo = num(l.min_price);
    const hi = num(l.max_price);
    if (lo !== null && hi !== null) {
      servicePrice = Math.round(((lo + hi) / 2) * 100) / 100;
      priceBasis = 'range_mid';
    }
  }

  // The customer's answers to the owner-authored intake questions ARE the "reason for
  // contact" Story 3 asks for — already collected at booking time, previously discarded.
  // Joined to their labels here rather than in the portal: the drawer used to print the
  // raw question uuid as the field name, so an owner read
  // "a3f2c1d0-…: Second floor" where "Which floor?: Second floor" belonged. Same builder
  // the bookings surface uses, so the two can never disagree — it also preserves answers
  // whose question has since been deleted, under the raw key.
  const intakeAnswers = buildIntakeAnswers(
    Array.isArray(l.intake_questions) ? (l.intake_questions as IntakeQuestion[]) : null,
    l.intake_answers
  );

  // Repeat detection. `person_*` is the nightly sweep's grouping answer across the
  // lead ROWS one human owns (repeat-detection.service.ts). There is deliberately ONE
  // notion of "repeat" here: `personConversationCount`. `conversationCount` below stays
  // exactly what its name says — conversations on THIS record — and is no longer a
  // repeat signal. See `personRepeat` for the fallback and why it under-reports.
  const { rowConversations, personConversationCount, personLeadCount, isRepeatCustomer } =
    personRepeat(l);

  const readiness = computeLeadReadiness({
    phone: l.phone as string | null,
    email: l.email as string | null,
    name: l.name as string | null,
    notes: l.notes as string | null,
    address: (l.customer_address as string | null) ?? (l.extracted_address as string | null),
    bookingId: l.booking_id as string | null,
    bookingStatus: l.booking_status as string | null,
    personConversationCount,
    override: (l.readiness_override as number | null) ?? null,
  });

  return {
    bookingId: (l.booking_id as string | null) ?? null,
    bookingStatus: (l.booking_status as string | null) ?? null,
    // Booking facts OUTRANK extracted ones, per field. A booking's `start_utc` is a
    // real appointment the customer confirmed; the extractor's reading of "tomorrow"
    // is an inference. Where both exist, the fact wins and the inference is discarded.
    preferredAt: l.start_utc ? new Date(l.start_utc as string).toISOString() : null,
    preferredAtText: l.start_utc ? null : ((l.preferred_at_text as string | null) ?? null),
    address: (l.customer_address as string | null) ?? (l.extracted_address as string | null) ?? null,
    serviceRequested:
      (l.service_name as string | null) ?? (l.extracted_service as string | null) ?? null,
    servicePrice,
    priceBasis,
    intakeAnswers,
    bookingCount: (l.booking_count as number | null) ?? 0,
    /** Conversations on THIS record. Not a repeat signal — see `personConversationCount`. */
    conversationCount: rowConversations,
    // ── Repeat-customer detection ───────────────────────────────────────────
    // The person KEY is deliberately not on the wire. It is a normalised phone or
    // email in plaintext, so shipping it would put a second copy of the identifier in
    // every list response and in whatever caches it — for a value the UI never renders.
    // The counts and dates are the whole of what the portal needs to say "returning
    // customer, 3 conversations since March".
    personConversationCount,
    personLeadCount,
    personFirstSeenAt: l.person_first_seen_at
      ? new Date(l.person_first_seen_at as string).toISOString()
      : null,
    personLastSeenAt: l.person_last_seen_at
      ? new Date(l.person_last_seen_at as string).toISOString()
      : null,
    // Stated once, server-side, so the portal, the readiness score and the follow-up
    // recommendation cannot drift into three different definitions of "returning".
    isRepeatCustomer,
    // Inferred, never facts — the UI must present these as AI-derived and never act
    // on them. `null` whenever the extractor abstained, which is the common case.
    urgency: (l.urgency as string | null) ?? null,
    intent: (l.intent as string | null) ?? null,
    tags: Array.isArray(l.tags) ? (l.tags as string[]) : null,
    // Computed on READ from the facts above, never stored: a persisted score would keep
    // counting a booking that was cancelled afterwards, and nothing notifies the lead.
    readiness,
  };
}

interface CursorParts {
  createdAt: Date;
  id: string;
}

function encodeCursor(parts: CursorParts): string {
  return Buffer.from(`${parts.createdAt.toISOString()}|${parts.id}`, 'utf8').toString('base64url');
}

function decodeCursor(raw: string): CursorParts {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    throw new BadRequestError('Invalid cursor');
  }
  const [iso, id] = decoded.split('|');
  if (!iso || !id) throw new BadRequestError('Invalid cursor');
  const createdAt = new Date(iso);
  if (Number.isNaN(createdAt.getTime())) throw new BadRequestError('Invalid cursor');
  return { createdAt, id };
}

router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = req.tenantId!;

    // Audit gap #5: enforce the entitlement at the read boundary. The
    // `capture_lead` tool (write side) gates by tier indirectly via the
    // bot's agent runtime, which doesn't run on Free anyway
    // (dailyLlmCalls=0). This is the missing read-side gate.
    await requireFeature(tenantId, 'leadCapture', 'plan_limit_lead_capture');

    const limitRaw = parseInt(String(req.query.limit ?? DEFAULT_LIMIT), 10);
    const limit = Math.min(
      Math.max(Number.isFinite(limitRaw) ? limitRaw : DEFAULT_LIMIT, 1),
      MAX_LIMIT,
    );

    // Structured (Pro) columns are gated on `leadEnrichment`; the basic set is
    // always returned. Gating the PROJECTION, not just the UI, means an Essential
    // tenant cannot read Pro fields by calling the API directly.
    const { features } = await getEntitlements(tenantId);
    const wide = features.leadEnrichment === true;
    // Enterprise's recommended follow-up action rides the same read rather than its own
    // endpoint — it is one branch over columns this query already selects, so a second
    // round trip per expanded row would buy nothing. Gated on the SAME flag the
    // lead-demand panel uses (insights.routes.ts), and gated on the PROJECTION so an
    // unentitled tenant cannot read it by calling the API directly.
    const advisory = features.aiBusinessInsights === true;

    // Server-side filters. Validated against closed sets — never interpolated —
    // because these land in SQL. An unknown value is a 400, not a silent full scan:
    // a filter that quietly does nothing reads as "no matching leads".
    const params: unknown[] = [tenantId];
    const where: string[] = ['l.tenant_id = $1', 'l.deleted_at IS NULL'];

    const status = req.query.status;
    if (typeof status === 'string' && status.length > 0) {
      // 'erased' is deliberately NOT selectable: those rows carry no data and are
      // already excluded by `deleted_at IS NULL`.
      if (status !== 'new' && status !== 'archived') {
        throw new BadRequestError("status must be 'new' or 'archived'");
      }
      params.push(status);
      where.push(`l.status = $${params.length}`);
    }

    const channel = req.query.channel;
    if (typeof channel === 'string' && channel.length > 0) {
      if (!ALLOWED_CHANNELS.has(channel)) throw new BadRequestError('Unknown channel');
      params.push(channel);
      where.push(`l.channel = $${params.length}`);
    }

    const source = req.query.source;
    if (typeof source === 'string' && source.length > 0) {
      if (!ALLOWED_SOURCES.has(source)) throw new BadRequestError('Unknown source');
      params.push(source);
      where.push(`l.source = $${params.length}`);
    }

    if (typeof req.query.cursor === 'string' && req.query.cursor.length > 0) {
      const { createdAt, id } = decodeCursor(req.query.cursor);
      // Tuple ordering: skip rows older than the cursor row, OR same
      // timestamp with a smaller id (stable tiebreak).
      params.push(createdAt.toISOString(), id);
      where.push(`(l.created_at, l.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }

    params.push(limit + 1); // ask for one extra to detect "has more"
    const limitParam = `$${params.length}`;

    /**
     * Booking facts are DERIVED here, never stored on the lead. A session can hold
     * 0..n bookings and neither reschedule nor cancel notifies the lead row, so any
     * cached `booking_status` would go stale invisibly.
     *
     * The LATERAL picks the lead's most recent NON-CANCELLED booking — `(status IN
     * (...)) ASC` sorts live bookings (false) ahead of cancelled ones (true), so a
     * lead whose only booking was cancelled still shows it rather than showing blank.
     * `booking_count` tells the operator there are others.
     */
    const rows: Array<Record<string, unknown>> = await AppDataSource.query(
      `SELECT l.id, l.session_id, l.bot_id, l.name, l.email, l.phone, l.channel,
              l.source, l.status, l.notes, l.created_at, l.updated_at,
              bk.booking_id, bk.booking_status, bk.start_utc, bk.end_utc, bk.customer_address,
              bk.service_name, bk.price_display_type, bk.fixed_price, bk.min_price, bk.max_price,
              bk.intake_answers, bk.intake_questions,
              (SELECT count(*)::int FROM chatbot_bookings cb
                WHERE cb.lead_id = l.id AND cb.tenant_id = l.tenant_id) AS booking_count,
              -- Does ANY row belonging to this person hold a confirmed appointment
              -- still ahead of them? Repeat detection exists precisely because one
              -- human spans rows (a WhatsApp row and a widget row sharing a phone), so
              -- a recommendation derived from one row alone will tell an operator to
              -- chase someone who already booked — and tag them "Returning customer"
              -- while doing it. NULL person_key ⇒ no group ⇒ this is just the row.
              (SELECT EXISTS (
                 SELECT 1 FROM chatbot_bookings pb
                   JOIN chatbot_leads pl ON pl.id = pb.lead_id AND pl.tenant_id = pb.tenant_id
                  WHERE pb.tenant_id = l.tenant_id
                    AND pb.status = 'confirmed'
                    AND pb.start_utc > now()
                    AND pl.deleted_at IS NULL
                    AND (pl.id = l.id
                         OR (l.person_key IS NOT NULL AND pl.person_key = l.person_key))
               )) AS person_has_upcoming_booking,
              (SELECT count(*)::int FROM chatbot_lead_conversations lc
                WHERE lc.lead_id = l.id AND lc.tenant_id = l.tenant_id) AS conversation_count,
              -- Repeat detection reads four cached columns rather than re-grouping the
              -- tenant's lead table per row: the person spans lead ROWS, so computing it
              -- here would mean a correlated self-join on every row of every page. The
              -- nightly sweep pays that cost once (repeat-detection.service.ts).
              l.person_lead_count, l.person_conversation_count,
              l.person_first_seen_at, l.person_last_seen_at,
              l.readiness_override,
              ec.urgency, ec.intent, ec.tags, ec.enrich_state,
              ec.request AS extracted_request,
              ec.address AS extracted_address,
              ec.service_requested AS extracted_service,
              ec.preferred_at_text
         FROM chatbot_leads l
         LEFT JOIN LATERAL (
           SELECT b.id AS booking_id, b.status AS booking_status, b.start_utc, b.end_utc,
                  b.customer_address, b.intake_answers,
                  st.name AS service_name, st.price_display_type,
                  st.fixed_price, st.min_price, st.max_price,
                  -- The question definitions, so an answer can be shown under its LABEL.
                  -- Without them the drawer prints the raw uuid key as the label.
                  st.intake_questions
             FROM chatbot_bookings b
             LEFT JOIN chatbot_service_types st ON st.id = b.event_type_id
            WHERE b.lead_id = l.id AND b.tenant_id = l.tenant_id
            ORDER BY (b.status IN ('cancelled', 'failed')) ASC, b.start_utc DESC, b.id DESC
            LIMIT 1
         ) bk ON TRUE
         -- The lead's most recent ENRICHED conversation. Only 'enriched' rows are
         -- joined: 'abstained' deliberately produced nothing, and surfacing a
         -- half-populated abstained row would read as "we found nothing" when the
         -- honest answer is "we could not establish anything".
         LEFT JOIN LATERAL (
           SELECT lc2.urgency, lc2.intent, lc2.tags, lc2.enrich_state,
                  lc2.request, lc2.address, lc2.service_requested, lc2.preferred_at_text
             FROM chatbot_lead_conversations lc2
            WHERE lc2.lead_id = l.id AND lc2.tenant_id = l.tenant_id
              AND lc2.enrich_state = 'enriched'
            ORDER BY lc2.updated_at DESC
            LIMIT 1
         ) ec ON TRUE
        WHERE ${where.join(' AND ')}
        ORDER BY l.created_at DESC, l.id DESC
        LIMIT ${limitParam}`,
      params,
    );

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const last = pageRows[pageRows.length - 1];

    const nextCursor = hasMore && last
      ? encodeCursor({ createdAt: new Date(last.created_at as string), id: last.id as string })
      : null;

    sendSuccess(res, {
      leads: pageRows.map((l) => ({
        id: l.id,
        sessionId: l.session_id ?? null,
        botId: l.bot_id ?? null,
        name: l.name ?? null,
        email: l.email ?? null,
        phone: l.phone ?? null,
        channel: l.channel ?? null,
        source: l.source,
        status: l.status,
        notes: l.notes ?? null,
        createdAt: new Date(l.created_at as string).toISOString(),
        lastActivityAt: lastContactOf(l),
        ...(wide ? projectBookingFields(l) : {}),
        // Absent (not null) when unentitled, matching the structured fields above, so
        // `'followUp' in lead` distinguishes "not entitled" from "nothing to suggest".
        ...(advisory ? { followUp: projectFollowUp(l) } : {}),
      })),
      nextCursor,
    });
  }),
);

/**
 * Lead export, CSV or .xlsx. Gated by `leadCapture` (NOT the
 * Enterprise `aiBusinessInsights` gate the /analytics/export uses) so the
 * Essential/Pro tiers that actually own the Leads page can take their leads
 * — including the captured request `notes` — offline into a CRM.
 *
 * This is bulk PII egress, so it carries three controls the first version lacked:
 *   - `requireRole('admin', 'supervisor')` — previously ANY authenticated seat,
 *     including `agent` (the default auto-provision role, `clerk.middleware.ts:278`),
 *     could pull every lead the tenant has ever had. House convention is
 *     all-roles for ordinary reads and admin-only for privileged actions; a
 *     full-dataset PII download is the latter, but managers keep it so this is
 *     not a regression for anyone who legitimately exports today.
 *   - a hard row cap (`EXPORT_MAX_ROWS`) pushed into SQL — the query had no LIMIT
 *     and the whole result set is held in memory before send. When it bites we say
 *     so (`X-Export-Truncated`) rather than handing back a silently short file.
 *   - `logAudit` — without it there is no answer to "who accessed this personal
 *     data", which GDPR Art 15 / Art 33 both require. `impersonated` records a
 *     super-admin acting inside a tenant via X-Tenant-Context.
 *
 * The default window is the last 365 days, not epoch: an unbounded default meant
 * the cheapest request was also the largest possible PII extraction.
 *
 * `?format=` picks the serialisation and NOTHING else — same role gate, same row cap,
 * same headers, same audit row, same `Exporter.rows` output — so the two files can only
 * ever differ in encoding:
 *   - `csv` (default) is interchange CSV (`INTERCHANGE_CSV`: RFC 4180, comma, UTF-8 BOM
 *     for accents, no `sep=` hint) — what a CRM importer, pandas or our own `fromCsv`
 *     reader expects. It used to be semicolon+`sep=` Excel-flavoured, which was correct
 *     only while CSV was the ONLY format: a button labelled "CSV" that emitted a stray
 *     `sep=;` first row and `'`-prefixed cells was lying to whoever fed it downstream.
 *   - `xlsx` is a real spreadsheet and is now the Excel path, so no locale ever has to
 *     guess at a delimiter again.
 *
 * NOT rate-limited, deliberately and visibly: `rateLimitByTenant` / `rateLimit()`
 * both key on `req.tenant?.id`, which is only ever set by `tenant.middleware.ts`.
 * That middleware is NOT in this route's chain (`requireClerkAuth, autoProvision,
 * resolveTenantContext` set `req.tenantId` only), so attaching it here would be a
 * silent no-op — a control that reads as protection and enforces nothing. This
 * affects every clerk-authenticated route, not just this one; fixing it properly
 * is its own change. The role gate + row cap + audit are the real controls here.
 */
const EXPORT_MAX_ROWS = 10_000;
const EXPORT_DEFAULT_WINDOW_DAYS = 365;

/** Closed set, like the list filters above. An unrecognised `format` is a 400 rather
 *  than a silent fallback to CSV: a client that asked for a spreadsheet and got a CSV
 *  named `.csv` fails at whatever opens it next, far from the typo that caused it. */
function parseExportFormat(v: unknown): ExportFormat {
  if (v === undefined || v === '') return 'csv';
  if (v !== 'csv' && v !== 'xlsx') throw new BadRequestError("format must be 'csv' or 'xlsx'");
  return v;
}

router.get(
  '/export',
  requireRole('admin', 'supervisor'),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = req.tenantId!;
    await requireFeature(tenantId, 'leadCapture', 'plan_limit_lead_capture');

    const exporter = getExporter('leads')!; // always present
    const format = parseExportFormat(req.query.format);
    const parse = (v: unknown, fallback: Date): Date => {
      if (typeof v !== 'string' || !v) return fallback;
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? fallback : d;
    };
    const to = parse(req.query.to, new Date(Date.now() + 86_400_000)); // through end of today
    const from = parse(
      req.query.from,
      new Date(Date.now() - EXPORT_DEFAULT_WINDOW_DAYS * 86_400_000),
    );

    const rows = await exporter.rows(tenantId, { from, to, limit: EXPORT_MAX_ROWS });
    const truncated = rows.length >= EXPORT_MAX_ROWS;
    // Serialised from the one `rows` array, before the audit row is written: a
    // serialisation failure must not leave an audit trail for an export nobody received.
    const body =
      format === 'xlsx'
        ? await toXlsx(exporter.headers, rows, 'Leads')
        : toCsv(exporter.headers, rows, INTERCHANGE_CSV);

    // Audited before send: a truncated export must still be recorded, and the
    // row count is what tells an auditor how much data actually left.
    await logAudit(req.userId!, 'leads.exported', 'lead', tenantId, tenantId, {
      rowCount: rows.length,
      truncated,
      from: from.toISOString(),
      to: to.toISOString(),
      format,
      impersonated: req.user?.role === 'super_admin' && !!req.headers['x-tenant-context'],
    });

    res.setHeader('Content-Type', format === 'xlsx' ? XLSX_CONTENT_TYPE : 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${exporter.filename({ from, to }, format)}"`);
    // A capped export is incomplete data. Say so on the wire so the client can warn
    // the user, instead of letting a short file pass as the whole history.
    if (truncated) {
      res.setHeader('X-Export-Truncated', 'true');
      res.setHeader('X-Export-Row-Limit', String(EXPORT_MAX_ROWS));
    }
    res.status(200).send(body);
  }),
);

/**
 * Create a lead by hand — the "customer just phoned" path.
 *
 * Open to every seat that can see leads, deliberately: the agent who took the call is
 * the person who needs to record it, and creating a lead is additive, unlike export or
 * erasure. Goes through `upsertLead`, so a manual entry for someone already in the list
 * MERGES rather than duplicating — and the response says which happened, because a
 * silent merge looks like the save failed.
 */
router.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = req.tenantId!;
    await requireFeature(tenantId, 'leadCapture', 'plan_limit_lead_capture');

    const body = (req.body ?? {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    const email = str(body.email);
    const phone = str(body.phone);

    if (!email && !phone) {
      throw new BadRequestError('Provide an email or a phone number');
    }
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new BadRequestError('Invalid email');
    }
    // Erasure and retention both remove people on request; a manual entry must not be
    // able to walk that back by reusing the reserved namespace.
    if (isErasedDedupeKey(email) || isErasedDedupeKey(phone)) {
      throw new BadRequestError('Reserved identifier');
    }

    const result = await upsertLead({
      dataSource: AppDataSource,
      tenantId,
      source: 'manual',
      channel: 'widget',
      name: str(body.name),
      email,
      phone,
      notes: str(body.notes),
    });
    if (!result) throw new BadRequestError('Could not create the lead');

    await logAudit(req.userId!, 'leads.created_manually', 'lead', result.leadId, tenantId, {
      merged: !result.inserted,
    });

    sendSuccess(res, {
      id: result.leadId,
      // `false` means it merged onto an existing contact — the UI must say so.
      created: result.inserted,
    });
  }),
);

/**
 * CSV import — PREVIEW. Writes nothing.
 *
 * The number that matters is `merge`: how many rows land on a contact you already have.
 * A blind import that silently merges looks like data loss and one that silently
 * duplicates looks like a bug, so the operator sees both counts before committing.
 *
 * The client posts the CSV text on both calls rather than the server caching it between
 * them — statelessness is worth more than the re-upload at SMB file sizes.
 */
router.post(
  '/import/preview',
  requireRole('admin', 'supervisor'),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = req.tenantId!;
    await requireFeature(tenantId, 'leadCapture', 'plan_limit_lead_capture');

    const csv = (req.body ?? {}).csv;
    if (typeof csv !== 'string' || !csv.trim()) throw new BadRequestError('Provide CSV text');

    try {
      sendSuccess(res, await previewLeadImport(AppDataSource, tenantId, csv));
    } catch (error) {
      throw new BadRequestError(error instanceof Error ? error.message : 'Could not read the file');
    }
  }),
);

/** CSV import — COMMIT. Only rows the preview classified as create/merge are written. */
router.post(
  '/import/commit',
  requireRole('admin', 'supervisor'),
  // Explicit, longer budget than the 30s default: this is the one leads route that does
  // bounded-but-real bulk work. Paired with MAX_IMPORT_ROWS, which is what actually keeps
  // it inside the budget — the timeout is headroom, not the control.
  timeoutMiddleware(60_000),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = req.tenantId!;
    await requireFeature(tenantId, 'leadCapture', 'plan_limit_lead_capture');

    const csv = (req.body ?? {}).csv;
    if (typeof csv !== 'string' || !csv.trim()) throw new BadRequestError('Provide CSV text');

    let preview;
    try {
      // Re-classified server-side rather than trusting a client-supplied row list: the
      // rejection rules (reserved identifiers above all) must not be bypassable by
      // posting a hand-edited payload straight to commit.
      preview = await previewLeadImport(AppDataSource, tenantId, csv);
    } catch (error) {
      throw new BadRequestError(error instanceof Error ? error.message : 'Could not read the file');
    }

    let created = 0;
    let merged = 0;
    const failed: number[] = [];
    for (const row of preview.rows) {
      if (row.outcome === 'reject') continue;
      try {
        const result = await upsertLead({
          dataSource: AppDataSource,
          tenantId,
          source: 'import',
          channel: 'widget',
          name: row.name,
          email: row.email,
          phone: row.phone,
          notes: row.notes,
        });
        if (!result) failed.push(row.line);
        else if (result.inserted) created += 1;
        else merged += 1;
      } catch {
        // One bad row must not abandon the rest of the file half-imported.
        failed.push(row.line);
      }
    }

    await logAudit(req.userId!, 'leads.imported', 'lead', tenantId, tenantId, {
      created,
      merged,
      rejected: preview.reject,
      failed: failed.length,
      truncated: preview.truncated,
    });

    sendSuccess(res, { created, merged, rejected: preview.reject, failedLines: failed });
  }),
);

/**
 * Lead retention policy.
 *
 * GET is readable by any seat that can see leads; PUT is admin-only, because setting it
 * schedules irreversible erasure of customer records.
 *
 * `null` means KEEP FOREVER and is the default for every existing tenant — nothing
 * expires unless someone chooses a period. Defaulting to a number would have silently
 * deleted historical customer data on deploy.
 */
router.get(
  '/retention',
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = req.tenantId!;
    await requireFeature(tenantId, 'leadCapture', 'plan_limit_lead_capture');

    const [row] = await AppDataSource.query(`SELECT settings FROM tenants WHERE id = $1`, [tenantId]);
    sendSuccess(res, {
      retentionDays: readRetentionDays(row?.settings),
      minDays: MIN_RETENTION_DAYS,
      maxDays: MAX_RETENTION_DAYS,
    });
  }),
);

router.put(
  '/retention',
  requireRole('admin'),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = req.tenantId!;
    await requireFeature(tenantId, 'leadCapture', 'plan_limit_lead_capture');

    const raw = (req.body ?? {}).retentionDays;
    let value: number | null;
    if (raw === null) {
      value = null; // explicit "keep forever"
    } else if (
      typeof raw === 'number' &&
      Number.isInteger(raw) &&
      raw >= MIN_RETENTION_DAYS &&
      raw <= MAX_RETENTION_DAYS
    ) {
      value = raw;
    } else {
      throw new BadRequestError(
        `retentionDays must be null, or an integer between ${MIN_RETENTION_DAYS} and ${MAX_RETENTION_DAYS}`,
      );
    }

    // Targeted jsonb write so a concurrent settings writer is not clobbered. `null`
    // REMOVES the key entirely, which is what the sweep treats as "keep forever".
    await AppDataSource.query(
      value === null
        ? `UPDATE tenants SET settings = COALESCE(settings, '{}'::jsonb) - 'leadRetentionDays', updated_at = now() WHERE id = $1`
        : `UPDATE tenants SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('leadRetentionDays', $2::int), updated_at = now() WHERE id = $1`,
      value === null ? [tenantId] : [tenantId, value],
    );

    // Audited: this schedules irreversible deletion of customer personal data.
    await logAudit(req.userId!, 'leads.retention_updated', 'tenant', tenantId, tenantId, {
      retentionDays: value,
    });

    sendSuccess(res, { retentionDays: value });
  }),
);

/**
 * Update a lead's worklist status ('new' | 'archived') so operators can mark
 * captured requests as handled. Tenant-scoped; gated by `leadCapture`.
 */
router.patch(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = req.tenantId!;
    await requireFeature(tenantId, 'leadCapture', 'plan_limit_lead_capture');

    const body = (req.body ?? {}) as { status?: unknown; readinessOverride?: unknown };
    const hasStatus = body.status !== undefined;
    const hasOverride = body.readinessOverride !== undefined;
    if (!hasStatus && !hasOverride) {
      throw new BadRequestError('Provide status and/or readinessOverride');
    }
    if (hasStatus && body.status !== 'new' && body.status !== 'archived') {
      throw new BadRequestError("status must be 'new' or 'archived'");
    }
    // `null` clears the override and returns the lead to the computed score — the way
    // back from a human judgement, without which an override would be permanent.
    let override: number | null | undefined;
    if (hasOverride) {
      if (body.readinessOverride === null) {
        override = null;
      } else if (
        typeof body.readinessOverride === 'number' &&
        Number.isInteger(body.readinessOverride) &&
        body.readinessOverride >= 0 &&
        body.readinessOverride <= 100
      ) {
        override = body.readinessOverride;
      } else {
        throw new BadRequestError('readinessOverride must be an integer 0-100, or null to clear');
      }
    }

    const repo = AppDataSource.getRepository(Lead);
    const lead = await repo.findOne({ where: { id: req.params.id, tenantId } });
    // The `deletedAt` guard is also what makes `erased` terminal: erasure sets
    // deleted_at, so an erased lead 404s here and can never be moved back to
    // 'new'/'archived' — a resurrection this endpoint must not be able to perform.
    if (!lead || lead.deletedAt) throw new NotFoundError('Lead not found');
    if (hasStatus) lead.status = body.status as 'new' | 'archived';
    if (override !== undefined) {
      lead.readinessOverride = override;
      // Who and when: this is a human judgement overriding a machine one about a
      // person, so it has to be answerable later.
      lead.readinessOverrideBy = override === null ? null : req.userId!;
      lead.readinessOverrideAt = override === null ? null : new Date();
    }
    await repo.save(lead);

    sendSuccess(res, {
      id: lead.id,
      status: lead.status,
      readinessOverride: lead.readinessOverride ?? null,
    });
  }),
);

/**
 * Per-lead CRM sync status — "did this lead actually reach my CRM?"
 *
 * DERIVED from `webhook_delivery_logs`, with no new table and no outbox. The delivery
 * machinery (retry, circuit breaker, dead-letter, signing) already exists and already
 * records every attempt; the only thing missing was the ability to ask about it for ONE
 * lead. A per-lead sync-status column would have to be kept in step with that machinery
 * and could go stale; reading the log cannot.
 *
 * Deliberately its own endpoint rather than a column on the list. Most tenants have no
 * webhooks at all, and joining delivery history into every page would make all of them
 * pay for a question only some of them ask. This is fetched when a row is expanded.
 *
 * When a real CRM connector ships, THAT is when an outbox earns its place — it needs
 * per-record retry and reconciliation, which a one-way webhook does not.
 */
router.get(
  '/:id/sync',
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = req.tenantId!;
    await requireFeature(tenantId, 'leadCapture', 'plan_limit_lead_capture');

    // Tenant-scope the LEAD first: without this, any id could be probed for delivery
    // history belonging to another workspace.
    const lead = await AppDataSource.getRepository(Lead).findOne({
      where: { id: req.params.id, tenantId },
      select: ['id'],
    });
    if (!lead) throw new NotFoundError('Lead not found');

    const rows: Array<{
      event: string;
      status: string;
      http_status: number | null;
      attempt: number;
      url: string;
      error: string | null;
      created_at: Date;
    }> = await AppDataSource.query(
      `SELECT event, status, http_status, attempt, url, error, created_at
         FROM webhook_delivery_logs
        WHERE tenant_id = $1
          AND request_body -> 'lead' ->> 'leadId' = $2
        ORDER BY created_at DESC
        LIMIT 20`,
      [tenantId, req.params.id],
    );

    // `configured` distinguishes "nothing was sent because you have no endpoint" from
    // "nothing was sent and something is wrong" — without it, an empty list is
    // ambiguous and reads as a failure.
    // `jsonb_array_length` ERRORS on a non-array — COALESCE cannot save it, because the
    // error fires before COALESCE sees anything. The event-webhooks route already
    // tolerates hand-edited/legacy jsonb drift here; this one did not, so a malformed
    // blob turned a status lookup into a 500.
    const [{ configured }]: Array<{ configured: boolean }> = await AppDataSource.query(
      `SELECT COALESCE(
                jsonb_array_length(
                  CASE WHEN jsonb_typeof(settings -> 'eventWebhooks') = 'array'
                       THEN settings -> 'eventWebhooks'
                       ELSE '[]'::jsonb END
                ), 0) > 0 AS configured
         FROM tenants WHERE id = $1`,
      [tenantId],
    );

    const latest = rows[0] ?? null;
    sendSuccess(res, {
      configured,
      // 'never_sent' is not an error when no endpoint exists.
      status: latest ? latest.status : configured ? 'never_sent' : 'not_configured',
      lastAttemptAt: latest ? new Date(latest.created_at).toISOString() : null,
      attempts: rows.map((r) => ({
        event: r.event,
        status: r.status,
        httpStatus: r.http_status,
        attempt: r.attempt,
        // The URL can carry a secret path segment, so only the host is surfaced.
        host: safeHost(r.url),
        error: r.error,
        at: new Date(r.created_at).toISOString(),
      })),
    });
  }),
);

/**
 * Erase a lead's personal data (GDPR Art 17).
 *
 * `DELETE` rather than a status change because the effect is irreversible, and the
 * work is delegated to `eraseLead` because it spans four stores plus a downstream
 * notification — see that service for why a plain row delete is not enough.
 *
 * Admin/supervisor only: this is destructive and unrecoverable, so it carries the
 * same seat restriction as bulk export rather than being available to every seat.
 * Audited unconditionally — an erasure request is exactly the event a regulator
 * asks you to evidence, and `scrubbed` records how much derived data went with it.
 *
 * Idempotent: erasing an already-erased or unknown lead is a 404, and never emits a
 * second `lead.deleted`.
 */
router.delete(
  '/:id',
  requireRole('admin', 'supervisor'),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = req.tenantId!;
    await requireFeature(tenantId, 'leadCapture', 'plan_limit_lead_capture');

    const result = await eraseLead(AppDataSource, tenantId, req.params.id);
    if (!result) throw new NotFoundError('Lead not found');

    await logAudit(req.userId!, 'leads.erased', 'lead', result.leadId, tenantId, {
      scrubbed: result.scrubbed,
      transcriptRetained: result.transcriptRetained,
      impersonated: req.user?.role === 'super_admin' && !!req.headers['x-tenant-context'],
    });

    sendSuccess(res, {
      id: result.leadId,
      erased: true,
      scrubbed: result.scrubbed,
      // Surfaced, not hidden: the caller should know the chat transcript is a
      // separate deletion scope rather than assume this removed everything.
      transcriptRetained: result.transcriptRetained,
    });
  }),
);

export default router;
