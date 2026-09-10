import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));

vi.mock("@/services/apiClient", () => ({
  api: {
    get: apiGet,
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  extractApiErrorMessage: () => null,
}));

import i18n from "@/i18n";
import BotKnowledgePanel from "./BotKnowledgePanel";

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <BotKnowledgePanel botId="bot-1" readOnly />
    </QueryClientProvider>,
  );
}

describe("BotKnowledgePanel", () => {
  it("tells the tenant that a website import into the bot's own knowledge imported nothing", async () => {
    apiGet.mockResolvedValue({
      mode: "dedicated",
      kbId: "kb-bot",
      documents: [],
      websiteCrawls: [
        {
          origin: "https://down.example/",
          skippedByRules: 0,
          rulesUnreachable: true,
          hasPages: false,
        },
      ],
    });

    renderPanel();

    expect(
      await screen.findByText(
        "The site's own rules for down.example were not available, so nothing was imported.",
      ),
    ).toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledWith("/bots/bot-1/knowledge");
  });

  it("still renders when the API does not send crawl notices yet", async () => {
    apiGet.mockResolvedValue({
      mode: "dedicated",
      kbId: "kb-bot",
      documents: [],
    });

    renderPanel();

    expect(
      await screen.findByText(i18n.t("bots.knowledge.empty")),
    ).toBeInTheDocument();
  });
});
