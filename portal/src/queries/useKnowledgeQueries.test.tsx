import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

const { apiGet, apiPost } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));

vi.mock("../services/apiClient", () => ({
  api: {
    get: apiGet,
    post: apiPost,
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import {
  useImportWebsite,
  useKnowledgeDocuments,
  useWebsiteCrawlNotices,
  WEBSITE_IMPORT_WATCH_MS,
} from "./useKnowledgeQueries";

const refused = {
  origin: "https://down.example/",
  skippedByRules: 0,
  rulesUnreachable: true,
  hasPages: false,
};

function renderDocumentsPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(
    () => ({
      documents: useKnowledgeDocuments(),
      notices: useWebsiteCrawlNotices(),
      importWebsite: useImportWebsite(),
    }),
    { wrapper },
  );
}

const documentFetches = () =>
  apiGet.mock.calls.filter(([path]) => path === "/knowledge/documents").length;

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

beforeEach(() => {
  vi.useFakeTimers();
  apiGet.mockReset();
  apiPost.mockReset();
  apiPost.mockResolvedValue({ accepted: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("website import watch", () => {
  it("shows a refused import's notice while the tenant stays on the page, then stops polling", async () => {
    let crawled = false;
    apiGet.mockImplementation(async () => ({
      documents: [],
      websiteCrawls: crawled ? [refused] : [],
    }));
    const { result } = renderDocumentsPage();
    await advance(0);

    act(() => {
      result.current.importWebsite.mutate({ url: "down.example" });
    });
    await advance(0);
    expect(result.current.notices.data).toEqual([]);

    crawled = true;
    await advance(6000);
    expect(result.current.notices.data).toEqual([refused]);

    const fetches = documentFetches();
    await advance(WEBSITE_IMPORT_WATCH_MS);
    expect(documentFetches()).toBe(fetches);
  });

  it("keeps polling after a re-import of a refused site until the new crawl result arrives", async () => {
    let crawled = false;
    apiGet.mockImplementation(async () =>
      crawled
        ? {
            documents: [
              { id: "doc-1", status: "pending", sourceUrl: "https://down.example/" },
            ],
            websiteCrawls: [],
          }
        : { documents: [], websiteCrawls: [refused] },
    );
    const { result } = renderDocumentsPage();
    await advance(1000);
    expect(result.current.notices.data).toEqual([refused]);

    act(() => {
      result.current.importWebsite.mutate({ url: "https://down.example" });
    });
    await advance(0);
    const fetchesAfterImport = documentFetches();
    await advance(12_000);
    expect(documentFetches()).toBeGreaterThanOrEqual(fetchesAfterImport + 2);
    expect(result.current.notices.data).toEqual([refused]);

    crawled = true;
    await advance(6000);
    expect(result.current.notices.data).toEqual([]);
    expect(result.current.documents.data).toHaveLength(1);
  });

  it("stops polling when the watch window ends without a notice", async () => {
    apiGet.mockResolvedValue({ documents: [], websiteCrawls: [] });
    const { result } = renderDocumentsPage();
    await advance(0);

    act(() => {
      result.current.importWebsite.mutate({ url: "https://quiet.example" });
    });
    await advance(WEBSITE_IMPORT_WATCH_MS);
    const fetches = documentFetches();
    expect(fetches).toBeGreaterThan(3);

    await advance(WEBSITE_IMPORT_WATCH_MS);
    expect(documentFetches()).toBe(fetches);
  });
});
