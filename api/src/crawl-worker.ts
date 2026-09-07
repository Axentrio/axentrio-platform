/**
 * Dedicated website-crawl worker.
 *
 * Runs ONLY the `website-crawl` queue processor against Chromium
 * (see Dockerfile.website-crawl). Deploy as its own service sharing the
 * API's Redis so it consumes crawls instead of the API process. The API
 * also registers this processor as an interim path until this service is
 * deployed - see the comment in server.ts.
 */
import "reflect-metadata";
import { AppDataSource, initializeDatabase } from "./database/data-source";
import {
  closeQueues,
  initializeQueues,
  registerProcessor,
} from "./queue/message-queue";
import { logger } from "./utils/logger";

async function main(): Promise<void> {
 await initializeDatabase();
 await initializeQueues();

 const { createWebsiteCrawlProcessor, WEBSITE_CRAWL_QUEUE } = await import(
  "./knowledge/website-crawl.worker"
 );
 registerProcessor(
  WEBSITE_CRAWL_QUEUE,
  createWebsiteCrawlProcessor(await initializeDatabase()),
 );
 logger.info("Website-crawl worker started");

 // Keep the event loop alive; Bull owns the timers that matter.
 const keepAlive = setInterval(() => {}, 1 << 30);

 // Without this the container only ever dies by SIGKILL: the keep-alive timer
 // and Bull's Redis connections both hold the loop open past SIGTERM, so an
 // in-flight crawl is never drained and the queue keeps the stalled job.
 let shuttingDown = false;
 const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Website-crawl worker received ${signal} - shutting down`);
  clearInterval(keepAlive);
  try {
   await closeQueues();
   if (AppDataSource.isInitialized) await AppDataSource.destroy();
   process.exit(0);
  } catch (error) {
   logger.error("Website-crawl worker shutdown failed", {
    error: error instanceof Error ? error.message : String(error),
   });
   process.exit(1);
  }
 };
 process.on("SIGTERM", () => void shutdown("SIGTERM"));
 process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error) => {
 logger.error("Website-crawl worker failed to start", {
  error: error instanceof Error ? error.message : String(error),
 });
 process.exit(1);
});
