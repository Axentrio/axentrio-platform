/**
 * Single-subject export (GDPR Art 15).
 *
 * Every export on the platform was bulk — all leads, all analytics — so a data
 * subject's access request was answered by hand, which is slow, unauditable and
 * easy to get wrong in the direction that matters (missing a holder).
 *
 * The shape is deliberately flat JSON: it is what a person reads, not what a
 * developer debugs. Two rules:
 *
 * 1. **Gather by the PERSON, not the row.** The same human owns several lead rows
 *    (one per channel) grouped by `person_key`, and their sessions, messages,
 *    bookings, memory, bindings and judgments hang off those. Exporting one lead
 *    row would answer half the request.
 * 2. **Decrypt before returning.** Some messages are stored encrypted; returning
 *    ciphertext to the person it belongs to would be a technically true, useless
 *    answer.
 *
 * Reading the export is itself a processing operation on someone's data, so the
 * caller writes an audit row and a compliance event.
 */
import type { DataSource } from 'typeorm';
import { decrypt } from '../utils/encryption';
import { logger } from '../utils/logger';

export interface SubjectExport {
  subject: { leadId: string; exportedAt: string };
  leads: unknown[];
  leadConversations: unknown[];
  sessions: unknown[];
  participants: unknown[];
  messages: Array<{ id: string; sessionId: string; sender: string | null; content: string; createdAt: unknown }>;
  bookings: unknown[];
  judgments: unknown[];
  conversationBindings: unknown[];
  customerMemory: unknown[];
  notifications: unknown[];
}

export async function exportSubject(
  dataSource: DataSource,
  tenantId: string,
  leadId: string,
): Promise<SubjectExport | null> {
  const [lead]: Array<{ id: string; person_key: string | null; dedupe_key: string | null; session_id: string | null; email: string | null; phone: string | null }> =
    await dataSource.query(
      `SELECT id, person_key, dedupe_key, session_id, email, phone
         FROM chatbot_leads WHERE id = $1 AND tenant_id = $2`,
      [leadId, tenantId],
    );
  if (!lead) return null;

  // Every lead row for this human. A tombstoned row (`erased:…`) belongs to a
  // person who was erased, not to this subject — the caller asked for a live one.
  const leads = await dataSource.query(
    `SELECT * FROM chatbot_leads
      WHERE tenant_id = $1
        AND (
          id = $2
          OR ($3::varchar IS NOT NULL AND person_key = $3)
        )`,
    [tenantId, leadId, lead.person_key],
  );

  const leadIds: string[] = leads.map((l: { id: string }) => l.id);

  const leadConversations = await dataSource.query(
    `SELECT * FROM chatbot_lead_conversations WHERE tenant_id = $1 AND lead_id = ANY($2::uuid[])`,
    [tenantId, leadIds],
  );

  const sessions = await dataSource.query(
    `SELECT * FROM chat_sessions
      WHERE tenant_id = $1
        AND (
          id IN (SELECT session_id FROM chatbot_lead_conversations WHERE lead_id = ANY($2::uuid[]) AND session_id IS NOT NULL)
          OR id IN (SELECT session_id FROM chatbot_leads WHERE id = ANY($2::uuid[]) AND session_id IS NOT NULL)
        )`,
    [tenantId, leadIds],
  );
  const sessionIds: string[] = sessions.map((s: { id: string }) => s.id);

  const participants = sessionIds.length
    ? await dataSource.query(
        `SELECT * FROM participants WHERE session_id = ANY($1::uuid[])`,
        [sessionIds],
      )
    : [];

  const rawMessages: Array<{ id: string; session_id: string; content: string; content_encrypted: boolean; sender: string | null; created_at: unknown }> =
    sessionIds.length
      ? await dataSource.query(
          `SELECT m.id, m.session_id, m.content, m.content_encrypted,
                  p.type AS sender, m.created_at
             FROM messages m
             LEFT JOIN participants p ON p.id = m.participant_id
            WHERE m.session_id = ANY($1::uuid[])
            ORDER BY m.created_at ASC`,
          [sessionIds],
        )
      : [];

  const messages = rawMessages.map((m) => ({
    id: m.id,
    sessionId: m.session_id,
    sender: m.sender,
    content: m.content_encrypted ? safeDecrypt(m.content) : m.content,
    createdAt: m.created_at,
  }));

  const bookings = sessionIds.length
    ? await dataSource.query(
        `SELECT * FROM chatbot_bookings
          WHERE tenant_id = $1 AND (lead_id = ANY($2::uuid[]) OR session_id = ANY($3::uuid[]))`,
        [tenantId, leadIds, sessionIds],
      )
    : await dataSource.query(
        `SELECT * FROM chatbot_bookings WHERE tenant_id = $1 AND lead_id = ANY($2::uuid[])`,
        [tenantId, leadIds],
      );

  const judgments = sessionIds.length
    ? await dataSource.query(
        `SELECT * FROM chatbot_judgments WHERE tenant_id = $1 AND session_id = ANY($2::uuid[])`,
        [tenantId, sessionIds],
      )
    : [];

  const conversationBindings = sessionIds.length
    ? await dataSource.query(
        `SELECT * FROM conversation_bindings WHERE "sessionId" = ANY($1::uuid[])`,
        [sessionIds],
      )
    : [];

  const customerMemory = await dataSource.query(
    `SELECT * FROM chatbot_customer_memory
      WHERE tenant_id = $1
        AND (
          ($2::varchar IS NOT NULL AND person_key = $2)
          OR subject_key = ANY($3::varchar[])
        )`,
    [tenantId, lead.person_key, leadIds],
  );

  const notifications = await dataSource.query(
    `SELECT * FROM notifications WHERE tenant_id = $1 AND data->>'leadId' = ANY($2::text[])`,
    [tenantId, leadIds],
  );

  logger.info('[subject-export] assembled', {
    tenantId,
    leadId,
    sessions: sessionIds.length,
    messages: messages.length,
  });

  return {
    subject: { leadId, exportedAt: new Date().toISOString() },
    leads,
    leadConversations,
    sessions,
    participants,
    messages,
    bookings,
    judgments,
    conversationBindings,
    customerMemory,
    notifications,
  };
}

/**
 * A row that cannot be decrypted must not fail the whole export — the person is
 * entitled to everything we CAN produce, and a missing message is reported as
 * unreadable rather than silently dropped.
 */
function safeDecrypt(content: string): string {
  try {
    return decrypt(content);
  } catch {
    return '[unreadable]';
  }
}
