/**
 * Per-BOT upload gate for widget file uploads, enforced server-side.
 *
 * `features.fileUploadEnabled` was read in exactly one place — the widget init response that
 * tells the browser whether to render the attach button. The upload endpoints checked only
 * the PLAN entitlement, so switching uploads off hid a button and nothing more: any holder
 * of a valid widget token on a paid tenant could still presign and upload. "Off" was a UI
 * state, not a security posture, and a status doc described the feature as shipped-off on
 * exactly that basis.
 *
 * Its own module rather than a private function in the route file, so the test can exercise
 * the real thing instead of a re-stated copy — the route file imports the whole express
 * router and everything under it.
 */
import { AppDataSource } from '../database/data-source';
import { ChatSession } from '../database/entities/ChatSession';
import { Bot } from '../database/entities/Bot';
import { ApiError, NotFoundError } from '../middleware/error-handler';

/**
 * Throws unless this visitor's bot has uploads switched on.
 *
 * The flag lives on the bot and the widget token carries no botId, so it is resolved through
 * the visitor's own chat session — already the trust boundary every other widget file route
 * uses.
 */
export async function assertUploadEnabledForSession(
  tenantId: string,
  chatSessionId: string
): Promise<void> {
  const session = await AppDataSource.getRepository(ChatSession).findOne({
    where: { id: chatSessionId, tenantId },
  });
  // A missing session and a foreign-tenant one give the SAME 404, so this cannot be used as
  // a cross-tenant existence oracle for chat-session ids.
  if (!session) throw new NotFoundError('Upload session not found');

  const bot = session.botId
    ? await AppDataSource.getRepository(Bot).findOne({ where: { id: session.botId, tenantId } })
    : null;
  const settings = (bot?.settings ?? {}) as { features?: { fileUploadEnabled?: boolean } };

  // Default DENY. A legacy session with no bot, or a bot with no features block, has never
  // had an owner switch this on, and an upload endpoint is the wrong place to be generous.
  if (settings.features?.fileUploadEnabled !== true) {
    throw new ApiError('File uploads are turned off for this assistant', 403, 'FILE_UPLOAD_DISABLED');
  }
}
