/**
 * The workspace step.
 *
 * What is worth asserting here is the three ways onto a workspace, and that a
 * Clerk refusal stays on the step with the message instead of moving on.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { createOrganization, setActive, accept } = vi.hoisted(() => ({
  createOrganization: vi.fn(),
  setActive: vi.fn(),
  accept: vi.fn(),
}));

const clerkState = vi.hoisted(() => ({
  memberships: [] as Array<{
    id: string;
    organization: {
      id: string;
      name: string;
      imageUrl?: string;
      hasImage?: boolean;
    };
  }>,
  invitations: [] as Array<{
    id: string;
    accept: typeof accept;
    publicOrganizationData: {
      id: string;
      name: string;
      imageUrl?: string;
      hasImage?: boolean;
    };
  }>,
}));

vi.mock("@clerk/clerk-react", () => ({
  useOrganizationList: () => ({
    isLoaded: true,
    userMemberships: { data: clerkState.memberships },
    userInvitations: { data: clerkState.invitations },
    createOrganization,
    setActive,
  }),
}));

import i18n from "@/i18n";
import { WorkspaceStep } from "./WorkspaceStep";

function renderStep() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <WorkspaceStep />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  if (i18n.language !== "en") void i18n.changeLanguage("en");
  createOrganization.mockReset();
  setActive.mockReset();
  accept.mockReset();
  clerkState.memberships = [];
  clerkState.invitations = [];
});

describe("WorkspaceStep", () => {
  it("shows only the create form for a brand-new user", async () => {
    createOrganization.mockResolvedValue({ id: "org_new" });
    setActive.mockResolvedValue(undefined);
    renderStep();

    expect(
      screen.queryByRole("heading", { name: /^invitations$/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: /^your workspaces$/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /create a workspace/i }),
    ).toBeInTheDocument();

    await userEvent.type(
      screen.getByPlaceholderText(/company or team name/i),
      "Acme",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /create workspace/i }),
    );

    await waitFor(() =>
      expect(createOrganization).toHaveBeenCalledWith({ name: "Acme" }),
    );
    expect(setActive).toHaveBeenCalledWith({ organization: "org_new" });
    expect(createOrganization.mock.invocationCallOrder[0]).toBeLessThan(
      setActive.mock.invocationCallOrder[0],
    );
  });

  it("accepts an invitation then activates that workspace", async () => {
    clerkState.invitations = [
      {
        id: "inv_1",
        accept,
        publicOrganizationData: {
          id: "org_inv",
          name: "Invited Co",
          hasImage: false,
        },
      },
    ];
    accept.mockResolvedValue({});
    setActive.mockResolvedValue(undefined);
    renderStep();

    await userEvent.click(screen.getByRole("button", { name: /^accept$/i }));

    await waitFor(() => expect(accept).toHaveBeenCalled());
    expect(setActive).toHaveBeenCalledWith({ organization: "org_inv" });
    expect(accept.mock.invocationCallOrder[0]).toBeLessThan(
      setActive.mock.invocationCallOrder[0],
    );
  });

  it("opens an existing membership", async () => {
    clerkState.memberships = [
      {
        id: "mem_1",
        organization: { id: "org_mem", name: "Existing Co", hasImage: false },
      },
    ];
    setActive.mockResolvedValue(undefined);
    renderStep();

    await userEvent.click(screen.getByRole("button", { name: /^open$/i }));

    await waitFor(() =>
      expect(setActive).toHaveBeenCalledWith({ organization: "org_mem" }),
    );
  });

  it("keeps the form and shows Clerk's message when create fails", async () => {
    createOrganization.mockRejectedValue({
      errors: [{ longMessage: "Nope" }],
    });
    renderStep();

    await userEvent.type(
      screen.getByPlaceholderText(/company or team name/i),
      "Acme",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /create workspace/i }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("Nope");
    expect(
      screen.getByPlaceholderText(/company or team name/i),
    ).toBeInTheDocument();
    expect(setActive).not.toHaveBeenCalled();
  });
});
