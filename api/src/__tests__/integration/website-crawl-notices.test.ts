import { afterEach, describe, expect, it, vi } from "vitest";

const queued = vi.hoisted(() => [] as Array<{ queue: string; data: unknown }>);
const againRules = vi.hoisted(() => ({ reachable: false }));

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
      if (host === "closed.notices.example") {
        return { status: 200, data: "User-agent: *\nDisallow: /\n", headers: {} };
      }
      if (host === "clean.notices.example") {
        return { status: 404, data: "", headers: {} };
      }
      if (host === "again.notices.example") {
        if (!againRules.reachable) {
          throw new Error("timeout of 5000ms exceeded");
        }
        return { status: 404, data: "", headers: {} };
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

const renderShop = () =>
  vi.fn(async (url: string) => ({
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

const crawlJob = (tenantId: string, kbId: string, originUrl: string) => ({
  data: {
    tenantId,
    kbId,
    originUrl,
    followLinks: true,
    maxPages: 10,
    extraUrls: [],
  },
});

describe("website crawl notices", () => {
  it("reports a non-zero skip count through the documents list the portal reads", async () => {
    const tenant = await createTestTenant();
    const knowledge = new KnowledgeService(AppDataSource);
    const kb = await knowledge.resolveKnowledgeBase(tenant.id);
    const processor = createWebsiteCrawlProcessor(AppDataSource, {
      render: renderShop(),
    });

    await processor(
      crawlJob(tenant.id, kb.id, "https://shop.notices.example/"),
    );

    const payload = await knowledge.listDocuments(tenant.id);
    expect(payload.websiteCrawls).toEqual([
      {
        origin: "https://shop.notices.example/",
        skippedByRules: 1,
        rulesUnreachable: false,
        hasPages: true,
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

    await processor(
      crawlJob(tenant.id, kb.id, "https://down.notices.example/"),
    );

    const payload = await knowledge.listDocuments(tenant.id);
    expect(render).not.toHaveBeenCalled();
    expect(payload.documents.filter((doc) => doc.type === "url")).toEqual([]);
    expect(payload.websiteCrawls).toEqual([
      {
        origin: "https://down.notices.example/",
        skippedByRules: 0,
        rulesUnreachable: true,
        hasPages: false,
      },
    ]);
  });

  it("marks a refused recrawl of an imported site as keeping its pages", async () => {
    const tenant = await createTestTenant();
    const knowledge = new KnowledgeService(AppDataSource);
    const kb = await knowledge.resolveKnowledgeBase(tenant.id);
    await knowledge.upsertUrlDocument(tenant.id, kb.id, {
      sourceUrl: "https://down.notices.example/about",
      title: "About",
      text: "Imported before the site's rules became unreachable",
    });
    const render = vi.fn();
    const processor = createWebsiteCrawlProcessor(AppDataSource, { render });

    await processor(
      crawlJob(tenant.id, kb.id, "https://down.notices.example/"),
    );

    const payload = await knowledge.listDocuments(tenant.id);
    expect(render).not.toHaveBeenCalled();
    expect(payload.documents.map((doc) => doc.sourceUrl)).toEqual([
      "https://down.notices.example/about",
    ]);
    expect(payload.websiteCrawls).toEqual([
      {
        origin: "https://down.notices.example/",
        skippedByRules: 0,
        rulesUnreachable: true,
        hasPages: true,
      },
    ]);
  });

  it("reports a site whose rules disallow its origin as the whole-site state: a rules skip and no pages", async () => {
    const tenant = await createTestTenant();
    const knowledge = new KnowledgeService(AppDataSource);
    const kb = await knowledge.resolveKnowledgeBase(tenant.id);
    const render = vi.fn();
    const processor = createWebsiteCrawlProcessor(AppDataSource, { render });

    await processor(
      crawlJob(tenant.id, kb.id, "https://closed.notices.example/"),
    );

    const payload = await knowledge.listDocuments(tenant.id);
    expect(render).not.toHaveBeenCalled();
    expect(payload.documents).toEqual([]);
    expect(payload.websiteCrawls).toEqual([
      {
        origin: "https://closed.notices.example/",
        skippedByRules: 1,
        rulesUnreachable: false,
        hasPages: false,
      },
    ]);
  });

  it("reports nothing once the tenant deletes every page of a clean import", async () => {
    const tenant = await createTestTenant();
    const knowledge = new KnowledgeService(AppDataSource);
    const kb = await knowledge.resolveKnowledgeBase(tenant.id);
    const render = vi.fn(async (url: string) => ({
      url,
      html: "",
      title: url,
      text: `Page at ${url}`,
      links:
        url === "https://clean.notices.example/"
          ? ["https://clean.notices.example/about"]
          : [],
    }));
    const processor = createWebsiteCrawlProcessor(AppDataSource, { render });
    await processor(
      crawlJob(tenant.id, kb.id, "https://clean.notices.example/"),
    );

    const imported = await knowledge.listDocuments(tenant.id);
    expect(imported.documents).toHaveLength(2);
    expect(imported.websiteCrawls).toEqual([]);
    for (const doc of imported.documents) {
      await knowledge.deleteDocument(tenant.id, doc.id);
    }

    const payload = await knowledge.listDocuments(tenant.id);
    expect(payload.documents).toEqual([]);
    expect(payload.websiteCrawls).toEqual([]);
  });

  describe("a re-import of a previously refused site", () => {
    const origin = "https://again.notices.example/";
    const refusedNotice = (hasPages: boolean) => ({
      origin,
      skippedByRules: 0,
      rulesUnreachable: true,
      hasPages,
    });
    const renderAgain = (onRender?: (url: string) => Promise<void>) =>
      vi.fn(async (url: string) => {
        await onRender?.(url);
        return {
          url,
          html: "",
          title: url,
          text: `Page at ${url}`,
          links: url === origin ? ["https://again.notices.example/about"] : [],
        };
      });

    afterEach(() => {
      againRules.reachable = false;
    });

    it("shows no refusal while its pages are arriving", async () => {
      const tenant = await createTestTenant();
      const knowledge = new KnowledgeService(AppDataSource);
      const kb = await knowledge.resolveKnowledgeBase(tenant.id);
      await createWebsiteCrawlProcessor(AppDataSource, { render: vi.fn() })(
        crawlJob(tenant.id, kb.id, origin),
      );
      expect((await knowledge.listDocuments(tenant.id)).websiteCrawls).toEqual([
        refusedNotice(false),
      ]);

      againRules.reachable = true;
      let midCrawl:
        | Awaited<ReturnType<KnowledgeService["listDocuments"]>>
        | undefined;
      const render = renderAgain(async (url) => {
        if (url === "https://again.notices.example/about") {
          midCrawl = await knowledge.listDocuments(tenant.id);
        }
      });
      await createWebsiteCrawlProcessor(AppDataSource, { render })(
        crawlJob(tenant.id, kb.id, origin),
      );

      expect(midCrawl?.documents.map((doc) => doc.sourceUrl)).toEqual([origin]);
      expect(midCrawl?.websiteCrawls).toEqual([]);
    });

    it("shows the refusal again once a later re-import is refused too", async () => {
      const tenant = await createTestTenant();
      const knowledge = new KnowledgeService(AppDataSource);
      const kb = await knowledge.resolveKnowledgeBase(tenant.id);
      await createWebsiteCrawlProcessor(AppDataSource, { render: vi.fn() })(
        crawlJob(tenant.id, kb.id, origin),
      );
      againRules.reachable = true;
      await createWebsiteCrawlProcessor(AppDataSource, {
        render: renderAgain(),
      })(crawlJob(tenant.id, kb.id, origin));
      expect((await knowledge.listDocuments(tenant.id)).websiteCrawls).toEqual(
        [],
      );

      againRules.reachable = false;
      await createWebsiteCrawlProcessor(AppDataSource, { render: vi.fn() })(
        crawlJob(tenant.id, kb.id, origin),
      );

      const payload = await knowledge.listDocuments(tenant.id);
      expect(payload.documents).toHaveLength(2);
      expect(payload.websiteCrawls).toEqual([refusedNotice(true)]);
    });
  });
});
