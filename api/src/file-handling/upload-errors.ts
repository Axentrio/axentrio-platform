import { ApiError, NotFoundError } from '../middleware/error-handler';
import { FileValidationError, QuotaExceededError, UploadSessionError } from './upload.service';

/**
 * Map the upload service's own error types onto real statuses.
 *
 * Both reached the global handler as 500/INTERNAL_ERROR, so "your file is too big" and
 * "you are over quota" — the two things a visitor can actually act on — arrived as
 * "something went wrong on our end".
 */
export async function asUploadApiError(err: unknown): Promise<never> {
  if (err instanceof FileValidationError) throw new ApiError(err.message, 400, 'FILE_VALIDATION_FAILED');
  if (err instanceof QuotaExceededError) throw new ApiError(err.message, 429, 'QUOTA_EXCEEDED');
  if (err instanceof UploadSessionError) throw new NotFoundError(err.message);
  throw err;
}
