/**
 * Plan-gated upload check for widget file uploads, enforced server-side.
 *
 * The attach button used to follow bot `features.fileUploadEnabled`, which
 * defaults to false and has no portal UI. Uploads now follow the plan
 * `fileUpload` flag, same as the upload routes. The chat-session lookup stays
 * so a missing or foreign session is 404, not a plan error.
 */
import { AppDataSource } from '../database/data-source';
import { ChatSession } from '../database/entities/ChatSession';
import { NotFoundError } from '../middleware/error-handler';
import { requireFeature } from '../billing/enforce';

/**
 * Throws unless this visitor's chat exists on this tenant and the plan
 * includes file upload.
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

  await requireFeature(tenantId, 'fileUpload', 'plan_limit_file_upload');
}
