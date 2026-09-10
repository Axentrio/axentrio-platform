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

vi.mock("@/pages/knowledge/AddDocumentModal", () => ({ default: () => null }));

import i18n from "@/i18n";
import { DocumentsStep } from "./DocumentsStep";
import type { StepProps } from "./types";

describe("DocumentsStep", () => {
  it("tells the tenant that a website import during setup imported nothing", async () => {
    apiGet.mockResolvedValue({
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
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const submit = { isPending: false, mutate: vi.fn() } as unknown as StepProps["submit"];

    render(
      <QueryClientProvider client={queryClient}>
        <DocumentsStep submit={submit} />
      </QueryClientProvider>,
    );

    expect(
      await screen.findByText(
        "The site's own rules for down.example were not available, so nothing was imported.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: i18n.t("setup.continue") })).toBeDisabled();
    expect(apiGet).toHaveBeenCalledWith("/knowledge/documents", {
      params: { limit: 100 },
    });
  });
});
