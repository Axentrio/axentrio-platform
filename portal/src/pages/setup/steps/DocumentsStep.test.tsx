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

const submit = { isPending: false, mutate: vi.fn() } as unknown as StepProps["submit"];

function renderStep() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <DocumentsStep submit={submit} />
    </QueryClientProvider>,
  );
}

describe("DocumentsStep", () => {
  it.each([
    ["a path the rules disallow while the rest of the site is allowed", "https://shop.notices.example/", "shop.notices.example"],
    ["a site whose rules disallow its origin", "https://closed.notices.example/", "closed.notices.example"],
  ])("says the requested address was disallowed above an empty list after an import of %s", async (_case, origin, host) => {
    apiGet.mockResolvedValue({
      documents: [],
      websiteCrawls: [
        {
          origin,
          skippedByRules: 1,
          rulesUnreachable: false,
          hasPages: false,
        },
      ],
    });

    renderStep();

    expect(
      await screen.findByText(
        `Nothing was imported from ${host} because the site's own rules disallow the address that was requested.`,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/\d+ pages? on/)).not.toBeInTheDocument();
    expect(screen.queryByText(/whole site/i)).not.toBeInTheDocument();
    expect(screen.getByText(i18n.t("setup.steps.documents.add"))).toBeInTheDocument();
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  });

  it("keeps the counted sentence when the site's rules skip one page and others import", async () => {
    apiGet.mockResolvedValue({
      documents: [
        { id: "doc-1", title: "About", status: "indexed" },
      ],
      websiteCrawls: [
        {
          origin: "https://shop.notices.example/",
          skippedByRules: 1,
          rulesUnreachable: false,
          hasPages: true,
        },
      ],
    });

    renderStep();

    expect(
      await screen.findByText(
        "1 page on shop.notices.example was skipped because the site's own rules disallow it.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("About")).toBeInTheDocument();
    expect(screen.queryByText(/Nothing was imported/)).not.toBeInTheDocument();
  });

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

    renderStep();

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
