import { afterEach, describe, expect, it, vi } from "vitest";
import { In } from "typeorm";

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
      if (new URL(config.url).host === "blocked.example") {
        return {
          status: 200,
          data: "User-agent: *\nDisallow: /\n",
          headers: {},
        };
      }
      throw new Error("timeout of 5000ms exceeded");
    }),
  };
});

import { AppDataSource } from "../../database/data-source";
import { KnowledgeDocument } from "../../database/entities/KnowledgeDocument";
import { KnowledgeService } from "../../knowledge/knowledge.service";
import { recrawlStaleWebsiteOrigins } from "../../knowledge/website-crawl.service";
import {
  createWebsiteCrawlProcessor,
  WEBSITE_CRAWL_QUEUE,
  type WebsiteCrawlJob,
} from "../../knowledge/website-crawl.worker";
import { createTestTenant } from "../helpers/factories";

const DAY_MS = 24 * 60 * 60 * 1000;
const START = new Date("2026-09-01T03:00:00.000Z").getTime();
const LAST_REFRESH = new Date(START - 2 * DAY_MS);

afterEach(() => {
  vi.useRealTimers();
  queued.length = 0;
});

describe("recrawlStaleWebsiteOrigins", () => {
  it("does not re-queue a robots-blocked or robots-unreachable origin on every daily pass", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(START);

    const tenant = await createTestTenant();
    const knowledge = new KnowledgeService(AppDataSource);
    const kb = await knowledge.resolveKnowledgeBase(tenant.id);
    const docRepo = AppDataSource.getRepository(KnowledgeDocument);
    const docIds: string[] = [];
    for (const sourceUrl of [
      "https://blocked.example/private",
      "https://down.example/private",
    ]) {
      const doc = await docRepo.save(
        docRepo.create({
          tenantId: tenant.id,
          knowledgeBaseId: kb.id,
          type: "url",
          title: sourceUrl,
          sourceUrl,
          sourceContent: "indexed before the robots fix",
          status: "indexed",
          metadata: { sourceUrl },
        }),
      );
      await AppDataSource.query(
        `UPDATE knowledge_documents SET "updatedAt" = $1 WHERE id = $2`,
        [LAST_REFRESH, doc.id],
      );
      docIds.push(doc.id);
    }

    const render = vi.fn();
    const processor = createWebsiteCrawlProcessor(AppDataSource, { render });
    const dailyPass = async (at: number): Promise<string[]> => {
      queued.length = 0;
      vi.setSystemTime(at);
      await recrawlStaleWebsiteOrigins(knowledge);
      const jobs = queued
        .filter((job) => job.queue === WEBSITE_CRAWL_QUEUE)
        .map((job) => job.data as WebsiteCrawlJob);
      vi.setSystemTime(at + 5 * 60 * 1000);
      for (const data of jobs) await processor({ data });
      return jobs.map((job) => job.originUrl).sort();
    };

    const bothOrigins = ["https://blocked.example/", "https://down.example/"];
    expect(await dailyPass(START)).toEqual(bothOrigins);
    expect(await dailyPass(START + DAY_MS)).toEqual([]);
    expect(await dailyPass(START + 2 * DAY_MS)).toEqual(bothOrigins);

    expect(render).not.toHaveBeenCalled();
    const docs = await docRepo.findBy({ id: In(docIds) });
    expect(docs).toHaveLength(2);
    for (const doc of docs) {
      expect(doc.updatedAt.toISOString()).toBe(LAST_REFRESH.toISOString());
      expect(doc.sourceContent).toBe("indexed before the robots fix");
    }
  });
});
