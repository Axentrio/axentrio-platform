/**
 * The wizard before a Clerk organization exists.
 *
 * The workspace step is client-side: the status query must not fire, skip is
 * not offered, and the shell already counts it as step 1 of 10.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

const { apiGet } = vi.hoisted(() => ({
  apiGet: vi.fn(),
}));

vi.mock("@/services/apiClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/apiClient")>()),
  api: {
    get: apiGet,
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("@clerk/clerk-react", () => ({
  useOrganization: () => ({ organization: null, isLoaded: true }),
  useOrganizationList: () => ({
    isLoaded: true,
    userMemberships: { data: [] },
    userInvitations: { data: [] },
    createOrganization: vi.fn(),
    setActive: vi.fn(),
  }),
}));

vi.mock("@/pages/knowledge/AddDocumentModal", () => ({ default: () => null }));

import i18n from "@/i18n";
import SetupWizard from "./SetupWizard";

function renderWizard() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <SetupWizard />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("SetupWizard without an organization", () => {
  it("shows the workspace step and does not fetch setup status", () => {
    if (i18n.language !== "en") void i18n.changeLanguage("en");
    renderWizard();

    expect(
      screen.getByRole("heading", { name: /^your workspace$/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("Step 1 of 10")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /not now/i }),
    ).not.toBeInTheDocument();
    expect(apiGet).not.toHaveBeenCalledWith("/onboarding/status");
  });
});
