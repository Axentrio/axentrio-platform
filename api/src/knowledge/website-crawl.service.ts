import type { KnowledgeService } from "./knowledge.service";
import { clampMaxPages } from "./website-crawl";
import { canonicalSourceUrl } from "./website-url";
import { assertSafeOutboundUrl, SsrfError } from "../security/ssrf-guard";
import { addJob } from "../queue/message-queue";
import { WEBSITE_CRAWL_QUEUE } from "./website-crawl.worker";
import { ApiError, BadRequestError } from "../middleware/error-handler";
import { ERROR_CODES } from "../middleware/error-codes";
import { logger } from "../utils/logger";

export async function startWebsiteImport(
  knowledge: KnowledgeService,
  input: {
    tenantId: string;
    url: string;
    followLinks: boolean;
    maxPages?: number;
    kbId?: string;
    extraUrls?: string[];
  },
): Promise<{
  accepted: true;
  url: string;
  maxPages: number;
  followLinks: boolean;
}> {
  let origin: string;
  try {
    origin = canonicalSourceUrl(input.url);
    assertSafeOutboundUrl(origin);
  } catch (error) {
    if (error instanceof SsrfError) {
      throw new BadRequestError("That URL cannot be imported");
    }
    throw new BadRequestError("Enter a valid https website URL");
  }

  const kb = await knowledge.resolveKnowledgeBase(input.tenantId, input.kbId);
  const remaining = await knowledge.remainingDocumentSlots(
    input.tenantId,
    kb.id,
  );
  if (remaining <= 0) {
    throw new ApiError(
      "Document limit reached for this plan",
      402,
      ERROR_CODES.QUOTA_EXCEEDED,
    );
  }
  const maxPages = clampMaxPages(input.maxPages, remaining);

  try {
    await addJob(WEBSITE_CRAWL_QUEUE, {
      tenantId: input.tenantId,
      kbId: kb.id,
      originUrl: origin,
      followLinks: input.followLinks,
      maxPages,
      extraUrls: input.extraUrls,
    });
  } catch (error) {
    logger.error("Failed to queue website crawl", {
      tenantId: input.tenantId,
      origin,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new ApiError(
      "Could not queue the website import",
      503,
      ERROR_CODES.UPSTREAM_FAILED,
    );
  }

  return {
    accepted: true,
    url: origin,
    maxPages,
    followLinks: input.followLinks,
  };
}

const RECRAWL_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RECRAWL_MAX_JOBS = 20;

/** Re-queue website origins whose documents have not been updated in a day. */
export async function recrawlStaleWebsiteOrigins(
  knowledge: KnowledgeService,
): Promise<number> {
  const olderThan = new Date(Date.now() - RECRAWL_MAX_AGE_MS);
  const origins = await knowledge.listStaleUrlOrigins(
    olderThan,
    RECRAWL_MAX_JOBS,
  );
  let queued = 0;
  for (const item of origins) {
    try {
      await startWebsiteImport(knowledge, {
        tenantId: item.tenantId,
        kbId: item.kbId,
        url: item.origin,
        followLinks: true,
        extraUrls: [],
      });
      queued += 1;
    } catch (error) {
      logger.warn("Stale website recrawl skipped", {
        origin: item.origin,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (queued > 0) {
    logger.info("Stale website recrawl queued", { queued });
  }
  return queued;
}
