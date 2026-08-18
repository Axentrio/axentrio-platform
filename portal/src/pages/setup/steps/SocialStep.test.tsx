import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useSearchParams } from "react-router-dom";
import type { StepProps } from "./types";

const {
  connectMeta,
  connectWhatsApp,
  metaOAuthUrl,
  metaSession,
  toastInfo,
  toastWarning,
} = vi.hoisted(() => ({
  connectMeta: vi.fn(),
  connectWhatsApp: vi.fn(),
  metaOAuthUrl: vi.fn(),
  metaSession: { current: null as string | null },
  toastInfo: vi.fn(),
  toastWarning: vi.fn(),
}));

vi.mock("@/queries/useChannelQueries", () => ({
  useChannelConnections: () => ({ data: [], isLoading: false }),
  useConnectWhatsApp: () => ({
    mutateAsync: connectWhatsApp,
    isPending: false,
  }),
  useMetaOAuthUrl: () => ({ mutateAsync: metaOAuthUrl, isPending: false }),
  useMetaOAuthPages: (sessionToken: string | null) => {
    metaSession.current = sessionToken;
    return {
      data: sessionToken
        ? [
            {
              id: "page-1",
              name: "Acme",
              instagramAccount: { username: "acme" },
            },
          ]
        : undefined,
      isLoading: false,
    };
  },
  useConnectMeta: () => ({ mutateAsync: connectMeta, isPending: false }),
}));

// Essential+ for the connect CTAs to render; the plan gate hides them on Free.
vi.mock("@/queries/useEntitlementsQueries", async () => {
  const actual = await vi.importActual<
    typeof import("@/queries/useEntitlementsQueries")
  >("@/queries/useEntitlementsQueries");
  return {
    ...actual,
    useIsEntitled: () => true,
  };
});

vi.mock("sonner", () => ({
  toast: { info: toastInfo, warning: toastWarning },
}));

import { SocialStep } from "./SocialStep";

function SearchProbe() {
  const [params] = useSearchParams();
  return <output data-testid="search">{params.toString()}</output>;
}

function renderStep(initialEntry = "/setup") {
  const submit = {
    mutate: vi.fn(),
    isPending: false,
  } as unknown as StepProps["submit"];

  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <SocialStep submit={submit} />
      <SearchProbe />
    </MemoryRouter>,
  );
  return submit;
}

beforeEach(() => {
  connectMeta.mockReset().mockResolvedValue({});
  connectWhatsApp.mockReset().mockResolvedValue({});
  metaOAuthUrl.mockReset().mockResolvedValue("https://facebook.test/oauth");
  metaSession.current = null;
  toastInfo.mockReset();
  toastWarning.mockReset();
});

describe("SocialStep", () => {
  it("renders Messenger and WhatsApp connect controls", () => {
    renderStep();

    expect(
      screen.getByRole("button", { name: /connect facebook messenger/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /connect whatsapp/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("Instagram")).toBeInTheDocument();
    expect(screen.getByText(/linkedin · coming soon/i)).toBeInTheDocument();
  });

  it("consumes meta_setup when the selected Facebook Pages are connected", async () => {
    connectMeta.mockResolvedValue({
      instagramWarnings: [
        { pageId: "page-1", pageName: "Acme", reason: "App Review required" },
      ],
    });
    renderStep("/setup?meta_setup=session-jwt");

    expect(metaSession.current).toBe("session-jwt");
    await userEvent.click(
      screen.getByRole("button", { name: /connect selected pages/i }),
    );

    await waitFor(() =>
      expect(connectMeta).toHaveBeenCalledWith({
        pageIds: ["page-1"],
        sessionToken: "session-jwt",
      }),
    );
    expect(toastWarning).toHaveBeenCalledWith(
      expect.stringMatching(/app review required/i),
    );
    expect(screen.getByTestId("search")).toHaveTextContent("");
  });

  it("marks social done when the customer chooses later without a connection", async () => {
    const submit = renderStep();

    await userEvent.click(
      screen.getByRole("button", { name: /do this later/i }),
    );

    expect(submit.mutate).toHaveBeenCalledWith({ step: "social" });
    expect(connectMeta).not.toHaveBeenCalled();
    expect(connectWhatsApp).not.toHaveBeenCalled();
  });
});
