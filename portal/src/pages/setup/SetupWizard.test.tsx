/**
 * The setup wizard.
 *
 * What is worth asserting here is not that the screens render — it is that the two
 * promises the wizard makes to the customer hold:
 *
 *   a skip is an informed choice (the consequence is on screen before the click, and
 *   only optional steps offer one), and
 *
 *   a required step cannot be satisfied by a click alone.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

const { apiGet, apiPut, apiPost, apiPatch } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPut: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
}));
// Only `api` is stubbed — extractApiErrorMessage stays real, because how a server
// refusal turns into words the customer reads is part of what is under test.
vi.mock("@/services/apiClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/apiClient")>()),
  api: {
    get: apiGet,
    post: apiPost,
    put: apiPut,
    patch: apiPatch,
    delete: vi.fn(),
  },
}));

vi.mock("@clerk/clerk-react", () => ({
  useOrganization: () => ({ organization: null }),
}));
vi.mock("@/pages/knowledge/AddDocumentModal", () => ({ default: () => null }));
// Wizard social step renders real connect CTAs — treat the tenant as Essential+.
vi.mock("@/queries/useEntitlementsQueries", async () => {
  const actual = await vi.importActual<
    typeof import("@/queries/useEntitlementsQueries")
  >("@/queries/useEntitlementsQueries");
  return { ...actual, useIsEntitled: () => true };
});

import i18n from "@/i18n";
import SetupWizard from "./SetupWizard";
import { SETUP_STEPS, type SetupStep } from "@/queries/useOnboardingQueries";

/** Status for a workspace sitting on `step`, with everything before it answered. */
function statusAt(step: SetupStep, steps: Record<string, string> = {}) {
  return {
    state: { version: 1, steps, language: null, company: null },
    nextStep: step,
    complete: false,
  };
}

/**
 * The bookings step reads the calendar connection and the scheduler config, so its
 * tests need a router rather than one blanket resolve.
 */
function bookingsStep({
  connected = false,
  templateKeys,
}: {
  connected?: boolean;
  templateKeys?: string[];
} = {}) {
  return (url: string) => {
    if (url.startsWith("/integrations/google/status")) {
      return Promise.resolve({
        connected,
        accountEmail: connected ? "a@b.com" : null,
      });
    }
    if (url.startsWith("/scheduler/config"))
      return Promise.resolve({ availability: null });
    if (url === "/bots" && templateKeys)
      return Promise.resolve({
        bots: [{ id: "bot-1", isDefault: true }],
        used: 1,
        limit: 1,
      });
    if (url === "/bots/bot-1/templates" && templateKeys)
      return Promise.resolve({
        available: templateKeys.map((key) => ({
          id: `template-${key}`,
          key,
        })),
        bindings: [],
        mode: "or",
      });
    return Promise.resolve(statusAt("bookings"));
  };
}

function renderWizard(initialEntry = "/setup") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <SetupWizard />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiGet.mockReset();
  apiPut.mockReset().mockResolvedValue(statusAt("company"));
  apiPost.mockReset();
  apiPatch.mockReset().mockResolvedValue({});
});

it("puts the plan before bookings", () => {
  expect(SETUP_STEPS).toEqual([
    "language",
    "company",
    "logo",
    "chatbot",
    "documents",
    "plan",
    "bookings",
    "leads",
    "social",
  ]);
});

describe("skipping", () => {
  it("states what a skip costs, before the click", async () => {
    apiGet.mockImplementation(bookingsStep());
    renderWizard();
    // Not "you can change this later" — the specific thing that gets switched off.
    expect(
      await screen.findByText(/appointments stay off/i),
    ).toBeInTheDocument();
  });

  it("renders real social-channel connect controls", async () => {
    apiGet.mockImplementation((url: string) =>
      Promise.resolve(
        url === "/channels/connections" ? [] : statusAt("social"),
      ),
    );
    renderWizard();
    expect(
      await screen.findByRole("button", {
        name: /connect facebook messenger/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /connect whatsapp/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("Instagram")).toBeInTheDocument();
  });

  it("sends a real skip, not a silent continue", async () => {
    apiGet.mockImplementation(bookingsStep());
    renderWizard();

    await userEvent.click(
      await screen.findByRole("button", { name: /not now/i }),
    );

    await waitFor(() =>
      expect(apiPut).toHaveBeenCalledWith("/onboarding/step", {
        step: "bookings",
        outcome: "skipped",
      }),
    );
  });

  it("offers no way past a required step", async () => {
    // documents is required because a workspace with nothing to read has an assistant
    // that cannot answer anything.
    apiGet.mockResolvedValue(statusAt("documents"));
    renderWizard();

    await screen.findByRole("heading", { name: /what should it know/i });
    expect(
      screen.queryByRole("button", { name: /not now/i }),
    ).not.toBeInTheDocument();
  });
});

describe("a refused submission", () => {
  it("tells the customer why, instead of doing nothing", async () => {
    // Only 402s get a global toast. Without this the customer clicks Continue and
    // watches nothing happen, on the one screen they cannot navigate away from.
    apiGet.mockImplementation(bookingsStep());
    apiPut.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 409,
        data: {
          error: {
            message:
              "Upload at least one document so your assistant has something to answer from",
          },
        },
      },
    });
    renderWizard();

    await userEvent.click(
      await screen.findByRole("button", { name: /not now/i }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /upload at least one document/i,
    );
  });
});

describe("going back", () => {
  // The language step changes the app's language for real — correct in the product,
  // leaky in a suite. Put it back so later tests still read English headings.
  afterEach(() => {
    if (i18n.language !== "en") i18n.changeLanguage("en");
  });

  it("lands on an answered step when its rail marker is clicked", async () => {
    // Regression: the rail only offers steps that are ALREADY answered, and the
    // "revisit finished" check was "this step has an outcome" — true the instant they
    // clicked. Back navigation cleared itself before the screen could render.
    apiGet.mockResolvedValue({
      state: {
        version: 1,
        language: "nl",
        company: { vatNumber: "BE0400378485", name: "X" },
        steps: { language: "done", company: "done" },
      },
      nextStep: "logo",
      complete: false,
    });
    renderWizard();
    await screen.findByRole("heading", { name: /add your logo/i });

    const rail = screen
      .getAllByRole("button")
      .find((b) => /choose your language/i.test(b.textContent ?? ""));
    await userEvent.click(rail!);

    expect(
      await screen.findByRole("heading", { name: /choose your language/i }),
    ).toBeInTheDocument();
  });

  it("returns to the flow once they answer again", async () => {
    apiGet.mockResolvedValue({
      state: {
        version: 1,
        language: "nl",
        company: null,
        steps: { language: "done" },
      },
      nextStep: "company",
      complete: false,
    });
    apiPut.mockResolvedValue({
      state: {
        version: 1,
        language: "en",
        company: null,
        steps: { language: "done" },
      },
      nextStep: "company",
      complete: false,
    });
    renderWizard();
    await screen.findByRole("heading", { name: /your company/i });

    const rail = screen
      .getAllByRole("button")
      .find((b) => /choose your language/i.test(b.textContent ?? ""));
    await userEvent.click(rail!);
    await screen.findByRole("heading", { name: /choose your language/i });

    // English, so the assertion below is not reading a French heading — the point
    // here is that ANSWERING returns to the flow, not which language was picked.
    await userEvent.click(screen.getByRole("button", { name: /english/i }));

    // Answering hands control back to the server's ordering.
    expect(
      await screen.findByRole("heading", { name: /your company/i }),
    ).toBeInTheDocument();
  });
});

describe("the documents step", () => {
  it("will not continue until a document actually exists", async () => {
    apiGet.mockImplementation((url: string) =>
      url.startsWith("/knowledge/documents")
        ? Promise.resolve([])
        : Promise.resolve(statusAt("documents")),
    );
    renderWizard();

    const continueButton = await screen.findByRole("button", {
      name: /continue/i,
    });
    expect(continueButton).toBeDisabled();
  });

  it("continues once one does", async () => {
    apiGet.mockImplementation((url: string) =>
      url.startsWith("/knowledge/documents")
        ? Promise.resolve([
            { id: "d1", title: "Opening hours", status: "indexed" },
          ])
        : Promise.resolve(statusAt("documents")),
    );
    renderWizard();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /continue/i })).toBeEnabled(),
    );
  });
});

describe("the company step", () => {
  it("fills the form from the register so the customer confirms rather than types", async () => {
    apiGet.mockImplementation((url: string) =>
      url.startsWith("/onboarding/company-lookup")
        ? Promise.resolve({
            status: "found",
            cached: false,
            company: {
              vatNumber: "BE0400378485",
              name: "Colruyt Group",
              legalForm: "NV",
              street: "Edingensesteenweg 196",
              postalCode: "1500",
              city: "Halle",
            },
          })
        : Promise.resolve(statusAt("company")),
    );
    renderWizard();

    await userEvent.type(
      await screen.findByLabelText(/vat number/i),
      "BE0400378485",
    );
    await userEvent.click(screen.getByRole("button", { name: /look up/i }));

    expect(
      await screen.findByDisplayValue("Colruyt Group"),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("Halle")).toBeInTheDocument();
  });

  it("blocks Continue behind the lookup overlay and explains rate limits", async () => {
    let rejectLookup!: (reason?: unknown) => void;
    const pendingLookup = new Promise<never>((_resolve, reject) => {
      rejectLookup = reject;
    });
    apiGet.mockImplementation((url: string) =>
      url.startsWith("/onboarding/company-lookup")
        ? pendingLookup
        : Promise.resolve(statusAt("company")),
    );
    renderWizard();

    await userEvent.type(await screen.findByLabelText(/vat number/i), "NL123456789B01");
    await userEvent.type(screen.getByLabelText(/company name/i), "Example BV");
    await userEvent.click(screen.getByLabelText(/online business/i));
    expect(screen.getByRole("button", { name: /^continue$/i })).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: /look up/i }));
    expect(await screen.findByText(/checking the register/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^continue$/i })).toBeDisabled();

    rejectLookup({ isAxiosError: true, response: { status: 429 } });
    expect(await screen.findByText(/too many lookups/i)).toBeInTheDocument();
  });

  it("lets the customer continue when the register is down", async () => {
    // The explicit product rule: losing a signup to someone else's downtime is far
    // worse than an unverified company record.
    apiGet.mockImplementation((url: string) =>
      url.startsWith("/onboarding/company-lookup")
        ? Promise.resolve({
            status: "unavailable",
            company: null,
            cached: false,
          })
        : Promise.resolve(statusAt("company")),
    );
    renderWizard();

    await userEvent.type(
      await screen.findByLabelText(/vat number/i),
      "BE0400378485",
    );
    await userEvent.click(screen.getByRole("button", { name: /look up/i }));
    await screen.findByText(/register isn't responding/i);

    await userEvent.type(
      screen.getByLabelText(/company name/i),
      "Typed By Hand BV",
    );
    await userEvent.click(screen.getByLabelText(/online business/i));
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => expect(apiPut).toHaveBeenCalled());
    expect(apiPut.mock.calls[0][1].company).toMatchObject({
      name: "Typed By Hand BV",
    });
  });

  it("never claims the register verified something it did not", async () => {
    // `verified` is the server's word, taken from the lookup. The client must not be
    // able to assert it, so it is not in the payload at all.
    apiGet.mockImplementation((url: string) =>
      url.startsWith("/onboarding/company-lookup")
        ? Promise.resolve({ status: "not_found", company: null, cached: false })
        : Promise.resolve(statusAt("company")),
    );
    renderWizard();

    await userEvent.type(
      await screen.findByLabelText(/vat number/i),
      "BE0999999999",
    );
    await userEvent.type(
      screen.getByLabelText(/company name/i),
      "Definitely Real BV",
    );
    await userEvent.click(screen.getByLabelText(/online business/i));
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => expect(apiPut).toHaveBeenCalled());
    expect(apiPut.mock.calls[0][1].company).not.toHaveProperty("verified");
  });
});

describe("the plan step", () => {
  it("does not offer Free — it cannot run an Agent", async () => {
    apiGet.mockResolvedValue(statusAt("plan"));
    renderWizard();

    expect(
      await screen.findByText(/pro is recommended if you take appointments/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /continue on free/i }),
    ).not.toBeInTheDocument();
  });

  it("records the answer BEFORE leaving for Stripe", async () => {
    // Leaving for checkout with the final step unanswered would strand anyone who
    // abandons payment in a wizard they cannot get out of.
    apiGet.mockResolvedValue(statusAt("plan"));
    apiPost.mockResolvedValue({ url: "https://checkout.stripe.test/session" });
    renderWizard();

    const buttons = await screen.findAllByRole("button", {
      name: /choose this plan/i,
    });
    await userEvent.click(buttons[1]); // Pro

    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    expect(apiPut).toHaveBeenCalledWith("/onboarding/step", {
      step: "plan",
      outcome: "done",
    });
    expect(apiPut.mock.invocationCallOrder[0]).toBeLessThan(
      apiPost.mock.invocationCallOrder[0],
    );
  });

  it("continues an existing Pro trial without starting checkout", async () => {
    apiGet.mockImplementation((url: string) =>
      Promise.resolve(
        url === "/billing/state"
          ? { tier: "pro", status: "trialing" }
          : statusAt("plan"),
      ),
    );
    renderWizard();

    expect(
      await screen.findByText(/you’re on a 14-day pro trial/i),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^continue$/i }));

    await waitFor(() =>
      expect(apiPut).toHaveBeenCalledWith("/onboarding/step", {
        step: "plan",
        outcome: "done",
      }),
    );
    expect(apiPost).not.toHaveBeenCalled();
  });
});

describe("the bookings step", () => {
  it("will not finish until a calendar is connected", async () => {
    // A booking assistant with nowhere to write will confidently offer a slot it
    // cannot honour — a wrong answer, which is worse than a missing feature.
    apiGet.mockImplementation(bookingsStep({ connected: false }));
    renderWizard();

    expect(
      await screen.findByRole("button", { name: /connect google calendar/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^continue$/i })).toBeDisabled();
  });

  it("saves the hours and slot length once it is", async () => {
    apiGet.mockImplementation(bookingsStep({ connected: true }));
    apiPut.mockResolvedValue(statusAt("leads"));
    apiPost.mockResolvedValue({ services: [{ id: "s1" }] });
    renderWizard();

    await userEvent.click(await screen.findByRole("button", { name: /barber/i }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^continue$/i })).toBeEnabled(),
    );
    await userEvent.click(screen.getByRole("button", { name: /^continue$/i }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith(
        "/scheduler/presets/barber/apply",
        {},
      ),
    );
    await waitFor(() =>
      expect(apiPut).toHaveBeenCalledWith(
        "/scheduler/config",
        expect.anything(),
      ),
    );
    const payload = apiPut.mock.calls.find(
      (c) => c[0] === "/scheduler/config",
    )![1];
    expect(payload.availability).not.toHaveProperty("timezone");
    expect(payload.availability.slotGranularityMin).toBe(30);
    // SHORT weekday keys — this asserted `monday`/`sunday`, which the scheduler zod enum
    // (mon|tue|…) rejects, so the step 422'd on every real save while this test passed
    // against a mocked transport. The keys are the contract; assert the contract.
    expect(payload.availability.weeklyHours.mon).toEqual([
      { start: "09:00", end: "17:00" },
    ]);
    expect(payload.availability.weeklyHours.sun).toEqual([]);
    expect(Object.keys(payload.availability.weeklyHours).sort()).toEqual([
      "fri",
      "mon",
      "sat",
      "sun",
      "thu",
      "tue",
      "wed",
    ]);
  });

  it("binds the matching Studio template after applying a trade preset", async () => {
    apiGet.mockImplementation(
      bookingsStep({ connected: true, templateKeys: ["barber"] }),
    );
    apiPut.mockResolvedValue(statusAt("leads"));
    apiPost.mockResolvedValue({ services: [{ id: "s1" }] });
    renderWizard();

    await userEvent.click(await screen.findByRole("button", { name: /barber/i }));
    await userEvent.click(screen.getByRole("button", { name: /^continue$/i }));

    await waitFor(() =>
      expect(apiPut).toHaveBeenCalledWith("/bots/bot-1/template", {
        bindings: [{ templateId: "template-barber", version: "latest" }],
      }),
    );
    expect(apiPut).toHaveBeenCalledWith("/onboarding/step", {
      step: "bookings",
      outcome: "done",
    });
  });

  it("continues when the trade has no available Studio template", async () => {
    apiGet.mockImplementation(
      bookingsStep({ connected: true, templateKeys: [] }),
    );
    apiPut.mockResolvedValue(statusAt("leads"));
    apiPost.mockResolvedValue({ services: [{ id: "s1" }] });
    renderWizard();

    await userEvent.click(await screen.findByRole("button", { name: /barber/i }));
    await userEvent.click(screen.getByRole("button", { name: /^continue$/i }));

    await waitFor(() =>
      expect(apiPut).toHaveBeenCalledWith("/onboarding/step", {
        step: "bookings",
        outcome: "done",
      }),
    );
    expect(apiPut).not.toHaveBeenCalledWith(
      "/bots/bot-1/template",
      expect.anything(),
    );
  });
});
