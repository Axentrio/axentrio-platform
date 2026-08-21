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
import { initializeDatabase } from "./database/data-source";
import { initializeQueues, registerProcessor } from "./queue/message-queue";
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
 setInterval(() => {}, 1 << 30);
}

main().catch((error) => {
 logger.error("Website-crawl worker failed to start", {
  error: error instanceof Error ? error.message : String(error),
 });
 process.exit(1);
});
