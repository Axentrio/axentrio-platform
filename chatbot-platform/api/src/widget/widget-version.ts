/**
 * widget.js content-hash for cache invalidation.
 *
 * Computed once at module load: SHA-256 of the file bytes, truncated to 12
 * hex chars. Used as an ETag for the /widget.js response and exposed via
 * /widget/config so clients can request a hash-pinned URL (?v=<hash>).
 *
 * The file is small (~85KB) so a synchronous read at boot is fine.
 */

import { createHash } from 'crypto';
import { readFileSync, statSync } from 'fs';
import path from 'path';
import { logger } from '../utils/logger';

export const widgetPath = path.resolve(__dirname, '../../public/widget.js');

function computeWidgetVersion(): { widgetVersion: string; sizeBytes: number } {
  try {
    const bytes = readFileSync(widgetPath);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const widgetVersion = sha256.slice(0, 12);
    const sizeBytes = bytes.length;
    logger.info('widget.js loaded', { sha256, sizeBytes });
    return { widgetVersion, sizeBytes };
  } catch (err) {
    // File may be missing in some test environments — fail soft so the rest
    // of the server can boot. Operators will notice via 404s on /widget.js.
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Failed to hash widget.js at boot', { path: widgetPath, error: message });
    let sizeBytes = 0;
    try {
      sizeBytes = statSync(widgetPath).size;
    } catch {
      /* ignore */
    }
    return { widgetVersion: 'unknown', sizeBytes };
  }
}

const { widgetVersion, sizeBytes } = computeWidgetVersion();

export const widgetVersionHash = widgetVersion;
export const widgetSizeBytes = sizeBytes;
