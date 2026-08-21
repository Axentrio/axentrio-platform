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
