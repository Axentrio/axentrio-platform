import type { DataSource } from "typeorm";
import { KnowledgeService } from "./knowledge.service";
import { crawlWebsite, type PageRenderer } from "./website-crawl";
import { isSameHost } from "./website-url";
import { KNOWLEDGE_BOT_UA } from "./website-robots";
import {
  assertSafeOutboundUrl,
  safeOutboundRequest,
} from "../security/ssrf-guard";
import { logger } from "../utils/logger";

export const WEBSITE_CRAWL_QUEUE = "website-crawl";

export interface WebsiteCrawlJob {
  tenantId: string;
  kbId: string;
  originUrl: string;
  followLinks: boolean;
  maxPages: number;
}

async function renderWithFetch(url: string) {
  const { extractHtml } = await import("./document-extractors/html.extractor");

  // safeOutboundRequest sets maxRedirects: 0, so redirects are followed
  // manually: every hop is re-checked for SSRF and must stay on the
  // original host (plan: https, same-host, public, capped).
  let current = url;
  let html = "";
  for (let hop = 0; hop < 3; hop += 1) {
    const res = await safeOutboundRequest({
      url: current,
      method: "GET",
      timeout: 15000,
      headers: { "User-Agent": KNOWLEDGE_BOT_UA },
      responseType: "text",
      validateStatus: () => true,
      maxRedirects: 0,
    });
    const status = res.status;
    const location = res.headers.location;
    if (
      [301, 302, 303, 307, 308].includes(status) &&
      typeof location === "string" &&
      location.length > 0
    ) {
      const next = new URL(location, current).toString();
      assertSafeOutboundUrl(next);
      if (!isSameHost(url, next)) {
        throw new Error(`Redirect left the original host: ${next}`);
      }
      current = next;
      continue;
    }
    if (status < 200 || status >= 400) {
      throw new Error(`Fetch failed with status ${status}`);
    }
    const contentType = String(res.headers["content-type"] || "").toLowerCase();
    if (
      contentType &&
      !contentType.includes("html") &&
      !contentType.includes("xml") &&
      !contentType.includes("text/plain")
    ) {
      throw new Error(`Not HTML: ${contentType}`);
    }
    html = typeof res.data === "string" ? res.data : String(res.data ?? "");
    break;
  }
  if (!html) {
    throw new Error("Redirect chain did not reach a page");
  }
  const extracted = extractHtml(html, url);
  return {
    url,
    html,
    title: extracted.title,
    links: extracted.links,
    text: extracted.text,
  };
}

async function defaultRenderer(url: string) {
  try {
    const { renderWithPlaywright } = await import("./playwright-renderer");
    return await renderWithPlaywright(url);
  } catch (error) {
    logger.warn("Playwright unavailable; fetching HTML", {
      url,
      error: error instanceof Error ? error.message : String(error),
    });
    return renderWithFetch(url);
  }
}

export function createWebsiteCrawlProcessor(
  dataSource: DataSource,
  renderer?: PageRenderer,
) {
  const knowledge = new KnowledgeService(dataSource);

  return async (job: { data: WebsiteCrawlJob }) => {
    const { tenantId, kbId, originUrl, followLinks, maxPages } = job.data;
    logger.info("Website crawl started", {
      tenantId,
      kbId,
      originUrl,
      maxPages,
    });
    const remaining = await knowledge.remainingDocumentSlots(tenantId, kbId);
    // Tenant-requested crawl of their (or a nominated) site. robots.txt is
    // not applied: many marketing sites Disallow all bots, and the owner
    // asked to import anyway. SSRF and same-host caps still apply.
    const result = await crawlWebsite({
      originUrl,
      followLinks,
      maxPages,
      remainingSlots: remaining,
      renderer: renderer ?? { render: defaultRenderer },
      robotsAllows: async () => true,
      assertSafe: (url) => {
        assertSafeOutboundUrl(url);
      },
      upsertPage: (page) => knowledge.upsertUrlDocument(tenantId, kbId, page),
      enqueueIngest: async (doc) => {
        const { addJob } = await import("../queue/message-queue");
        await addJob(
          "knowledge-processing",
          {
            documentId: doc.id,
            tenantId,
            processingVersion: doc.processingVersion,
          },
          { jobId: `kb-${doc.id}-v${doc.processingVersion}` },
        );
      },
    });
    logger.info("Website crawl finished", {
      tenantId,
      kbId,
      originUrl,
      ...result,
    });
  };
}
