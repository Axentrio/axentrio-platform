/**
 * Load a session transcript as plaintext.
 *
 * The decrypt branch is NOT optional and is copied deliberately from
 * `insights/refresh-insights.job.ts`: the first prod run of the insights judge read
 * ciphertext and confidently reported "no questions" for every session. Skipping it
 * here would ship plausible-looking extractions computed over encrypted bytes.
 */
import { AppDataSource } from '../database/data-source';
import { decrypt } from '../utils/encryption';
import type { TranscriptMessage } from '../leads/enrichment/validate';

export async function loadSessionTranscript(sessionId: string): Promise<TranscriptMessage[]> {
  const rows: Array<{ id: string; content: string; contentEncrypted: boolean; sender: string; createdAt: Date }> =
    await AppDataSource.query(
      `SELECT m.id, m.content, m.content_encrypted AS "contentEncrypted",
              p.type AS sender, m.created_at AS "createdAt"
         FROM messages m
         JOIN participants p ON p.id = m.participant_id
        WHERE m.session_id = $1 AND m.type = 'text'
        ORDER BY m.created_at DESC
        LIMIT 80`,
      [sessionId],
    );
  rows.reverse();
  return rows.map((r) => ({
    id: r.id,
    content: r.contentEncrypted ? decrypt(r.content) : r.content,
    sender: (['user', 'agent', 'bot', 'system'].includes(r.sender) ? r.sender : 'system') as TranscriptMessage['sender'],
    createdAt: r.createdAt,
  })) as TranscriptMessage[];
}
