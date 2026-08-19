import { logger } from '../utils/logger';

// Tests exercise error paths on purpose. In CI those `logger.error` lines
// read as failed jobs. Keep them on a local run so a real failure still
// has the app log.
if (process.env.CI === 'true') {
  logger.silent = true;
}
