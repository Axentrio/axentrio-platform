/**
 * Smoke test for the website-import feature against a REAL site.
 *
 * Usage (local stack must be up):
 *   cd api && DB_PORT=5432 bash -c 'set -a && . ./.env.local && set +a && \
 *     npx ts-node --transpile-only scripts/smoke-website-import.ts'
 *
 * What it proves: queue -> crawl worker -> SSRF/robots guards -> HTML
 * extract -> KnowledgeDocument(type=url) upsert -> ingestion (chunks).
 */
import "reflect-metadata";
import crypto from "crypto";
import { initializeDatabase, AppDataSource } from "../src/database/data-source";
import {
  initializeQueues,
  registerProcessor,
} from "../src/queue/message-queue";
import {
  createWebsiteCrawlProcessor,
  WEBSITE_CRAWL_QUEUE,
} from "../src/knowledge/website-crawl.worker";
import { createIngestionProcessor } from "../src/knowledge/ingestion.worker";
import { startWebsiteImport } from "../src/knowledge/website-crawl.service";
import { KnowledgeService } from "../src/knowledge/knowledge.service";
import { Tenant } from "../src/database/entities/Tenant";
import { KnowledgeDocument } from "../src/database/entities/KnowledgeDocument";
import { config } from "../src/config/environment";
import { logger } from "../src/utils/logger";

const TARGET_URL = process.env.SMOKE_URL || "https://example.com";
const POLL_MS = 3000;
const TIMEOUT_MS = 120000;

async function main() {
  const dataSource = await initializeDatabase();
  await initializeQueues();

  // Self-contained: register processors here too. Bull guarantees a single
  // consumer per job, so co-existing with the dev API is safe.
  const s3Client = config.s3?.bucket
    ? (await import("../src/config/s3.config")).createS3Client()
    : null;
  registerProcessor(
    "knowledge-processing",
    createIngestionProcessor(dataSource, s3Client),
  );
  registerProcessor(
    WEBSITE_CRAWL_QUEUE,
    createWebsiteCrawlProcessor(dataSource),
  );

  const tenantRepo = dataSource.getRepository(Tenant);
  let tenant = await tenantRepo.findOne({
    where: { slug: "smoke-website-import" },
  });
  if (!tenant) {
    tenant = await tenantRepo.save(
      tenantRepo.create({
        name: "Website Import Smoke",
        slug: "smoke-website-import",
        apiKey: `cb_${crypto.randomBytes(24).toString("base64url")}`,
        tier: "enterprise",
        status: "active",
        settings: {},
      }),
    );
    logger.info("smoke tenant created", { tenantId: tenant.id });
  }

  const knowledge = new KnowledgeService(dataSource);
  const kb = await knowledge.getOrCreateKnowledgeBase(tenant.id);
  logger.info("smoke start", {
    tenantId: tenant.id,
    kbId: kb.id,
    url: TARGET_URL,
  });

  const accepted = await startWebsiteImport(knowledge, {
    tenantId: tenant.id,
    url: TARGET_URL,
    followLinks: true,
    kbId: kb.id,
  });
  logger.info("smoke accepted", accepted);

  const docRepo = dataSource.getRepository(KnowledgeDocument);
  const deadline = Date.now() + TIMEOUT_MS;
  let docs: KnowledgeDocument[] = [];
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    docs = await docRepo.find({
      where: { knowledgeBaseId: kb.id, type: "url" as const },
    });
    const settled = docs.every(
      (d) => d.status === "indexed" || d.status === "failed",
    );
    if (docs.length > 0 && settled) break;
    logger.info("smoke polling", {
      documents: docs.length,
      statuses: docs.map((d) => `${d.status}:${d.chunkCount}`).join(","),
    });
  }

  console.log("\n=== SMOKE RESULT ===");
  console.log(`target: ${TARGET_URL}`);
  console.log(`documents: ${docs.length}`);
  for (const d of docs) {
    console.log(
      `- [${d.status}] chunks=${d.chunkCount} sourceUrl=${d.sourceUrl} title="${d.title}"` +
        (d.errorMessage ? ` error="${d.errorMessage}"` : ""),
    );
  }
  const ok =
    docs.length > 0 &&
    docs.every((d) => d.status === "indexed" && d.chunkCount > 0);
  console.log(ok ? "\nSMOKE PASS" : "\nSMOKE FAIL");
  await dataSource.destroy();
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error("SMOKE ERROR", error);
  process.exit(1);
});
