import { afterEach, describe, expect, it, vi } from "vitest";

const queued = vi.hoisted(() => [] as Array<{ queue: string; data: unknown }>);

vi.mock("../../queue/message-queue", () => ({
  addJob: vi.fn(async (queue: string, data: unknown) => {
    queued.push({ queue, data });
  }),
}));

vi.mock("../../security/ssrf-guard", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../security/ssrf-guard")>();
  return {
    ...actual,
    safeOutboundRequest: vi.fn(async (config: { url: string }) => {
      const { host, pathname } = new URL(config.url);
      if (host === "shop.notices.example" && pathname === "/robots.txt") {
        return {
          status: 200,
          data: "User-agent: *\nDisallow: /secret\n",
          headers: {},
        };
      }
      if (host === "down.notices.example") {
        throw new Error("timeout of 5000ms exceeded");
      }
      throw new Error(`unexpected outbound request ${config.url}`);
    }),
  };
});

import { AppDataSource } from "../../database/data-source";
import { KnowledgeService } from "../../knowledge/knowledge.service";
import { createWebsiteCrawlProcessor } from "../../knowledge/website-crawl.worker";
import { createTestTenant } from "../helpers/factories";

afterEach(() => {
  queued.length = 0;
});

describe("website crawl notices", () => {
  it("reports a non-zero skip count through the documents list the portal reads", async () => {
    const tenant = await createTestTenant();
    const knowledge = new KnowledgeService(AppDataSource);
    const kb = await knowledge.resolveKnowledgeBase(tenant.id);
    const render = vi.fn(async (url: string) => ({
      url,
      html: "",
      title: url,
      text: `Page at ${url}`,
      links:
        url === "https://shop.notices.example/"
          ? [
              "https://shop.notices.example/secret",
              "https://shop.notices.example/about",
            ]
          : [],
    }));
    const processor = createWebsiteCrawlProcessor(AppDataSource, { render });

    await processor({
      data: {
        tenantId: tenant.id,
        kbId: kb.id,
        originUrl: "https://shop.notices.example/",
        followLinks: true,
        maxPages: 10,
        extraUrls: [],
      },
    });

    const payload = await knowledge.listDocuments(tenant.id);
    expect(payload.websiteCrawls).toEqual([
      {
        origin: "https://shop.notices.example/",
        skippedByRules: 1,
        rulesUnreachable: false,
      },
    ]);
    const urls = payload.documents
      .filter((doc) => doc.type === "url")
      .map((doc) => doc.sourceUrl)
      .sort();
    expect(urls).toEqual([
      "https://shop.notices.example/",
      "https://shop.notices.example/about",
    ]);
  });

  it("reports a refused origin through the documents list the portal reads", async () => {
    const tenant = await createTestTenant();
    const knowledge = new KnowledgeService(AppDataSource);
    const kb = await knowledge.resolveKnowledgeBase(tenant.id);
    const render = vi.fn();
    const processor = createWebsiteCrawlProcessor(AppDataSource, { render });

    await processor({
      data: {
        tenantId: tenant.id,
        kbId: kb.id,
        originUrl: "https://down.notices.example/",
        followLinks: true,
        maxPages: 10,
        extraUrls: [],
      },
    });

    const payload = await knowledge.listDocuments(tenant.id);
    expect(render).not.toHaveBeenCalled();
    expect(payload.documents.filter((doc) => doc.type === "url")).toEqual([]);
    expect(payload.websiteCrawls).toEqual([
      {
        origin: "https://down.notices.example/",
        skippedByRules: 0,
        rulesUnreachable: true,
      },
    ]);
  });
});
