import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("axios", () => ({ default: { post: vi.fn() } }));
import axios from "axios";

vi.mock("../../config/environment", () => ({
  config: {
    googleStorage: {
      clientId: "storage-cid",
      clientSecret: "storage-sec",
      redirectUri:
        "https://api.example/api/v1/knowledge/storage/google/callback",
      stateSecret: "unit-state-secret-at-least-32-chars!!",
    },
  },
}));

const mockClient: {
  generateAuthUrl: ReturnType<typeof vi.fn>;
  getToken: ReturnType<typeof vi.fn>;
  verifyIdToken: ReturnType<typeof vi.fn>;
  setCredentials: ReturnType<typeof vi.fn>;
  getAccessToken: ReturnType<typeof vi.fn>;
  credentials: Record<string, unknown>;
} = {
  generateAuthUrl: vi.fn(
    () => "https://accounts.google.com/o/oauth2/v2/auth?state=x",
  ),
  getToken: vi.fn(),
  verifyIdToken: vi.fn(),
  setCredentials: vi.fn(),
  getAccessToken: vi.fn(),
  credentials: {},
};

vi.mock("google-auth-library", () => {
  const CodeChallengeMethod = { S256: "S256", Plain: "plain" };
  function OAuth2Client() {
    return mockClient;
  }
  return {
    CodeChallengeMethod,
    OAuth2Client,
  };
});

vi.mock("../../utils/encryption", () => ({
  encrypt: (x: string) => `enc(${x})`,
  decrypt: (x: string) => (x.startsWith("enc(") ? x.slice(4, -1) : x),
}));

const save = vi.fn(async (row: unknown) => row);
const findOne = vi.fn();
const create = vi.fn((x: unknown) => x);
const del = vi.fn();

vi.mock("../../database/data-source", () => ({
  AppDataSource: {
    getRepository: () => ({
      save,
      findOne,
      create,
      delete: del,
      find: vi.fn(),
    }),
  },
}));

vi.mock("../../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../integrations/storage/token", async () => {
  const actual = await vi.importActual<
    typeof import("../../integrations/storage/token")
  >("../../integrations/storage/token");
  return {
    ...actual,
    shouldRevokeProviderGrant: vi.fn(),
    getValidAccessToken: vi.fn(),
  };
});

import { CodeChallengeMethod } from "google-auth-library";
import {
  buildGoogleAuthUrl,
  disconnectStorageConnection,
  exchangeAndStore,
} from "../../integrations/storage/google-drive.service";
import { shouldRevokeProviderGrant } from "../../integrations/storage/token";
import { pkceChallenge } from "../../integrations/storage/oauth-state";

describe("buildGoogleAuthUrl", () => {
  it("requests drive.file with PKCE and never include_granted_scopes", () => {
    const verifier = "verifier-plain";
    buildGoogleAuthUrl("nonce-1", verifier);
    expect(mockClient.generateAuthUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        access_type: "offline",
        prompt: "consent",
        state: "nonce-1",
        include_granted_scopes: false,
        code_challenge: pkceChallenge(verifier),
        code_challenge_method: CodeChallengeMethod.S256,
        scope: expect.arrayContaining([
          "https://www.googleapis.com/auth/drive.file",
        ]),
      }),
    );
    const args = mockClient.generateAuthUrl.mock.calls[0][0] as {
      scope: string[];
    };
    expect(args.scope).not.toEqual(
      expect.arrayContaining([
        "https://www.googleapis.com/auth/drive.readonly",
      ]),
    );
  });
});

describe("exchangeAndStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.getToken.mockResolvedValue({
      tokens: {
        access_token: "access-1",
        refresh_token: "refresh-1",
        expiry_date: Date.parse("2026-08-23T12:00:00.000Z"),
        id_token: "idt",
      },
    });
    mockClient.verifyIdToken.mockResolvedValue({
      getPayload: () => ({
        sub: "google-sub-9",
        email: "work@client.be",
        email_verified: true,
      }),
    });
    findOne.mockResolvedValue(null);
  });

  it("stores providerAccountId from the verified id_token sub", async () => {
    const row = await exchangeAndStore({
      tenantId: "t1",
      userId: "u1",
      code: "auth-code",
      codeVerifier: "ver",
    });
    expect(mockClient.getToken).toHaveBeenCalledWith({
      code: "auth-code",
      codeVerifier: "ver",
    });
    expect(row.providerAccountId).toBe("google-sub-9");
    expect(row.accountEmail).toBe("work@client.be");
    expect(row.connectedByUserId).toBe("u1");
    expect(row.accessTokenEnc).toBe("enc(access-1)");
    expect(row.refreshTokenEnc).toBe("enc(refresh-1)");
    expect(save).toHaveBeenCalledOnce();
  });
});

describe("disconnectStorageConnection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findOne.mockResolvedValue({
      id: "conn-1",
      tenantId: "t1",
      provider: "google_drive",
      providerAccountId: "sub-1",
      status: "active",
      accessTokenEnc: "enc(access)",
      refreshTokenEnc: "enc(refresh)",
    });
  });

  it("revokes at Google when this is the last connection for the account", async () => {
    vi.mocked(shouldRevokeProviderGrant).mockResolvedValue(true);
    await disconnectStorageConnection("t1", "conn-1");
    expect(axios.post).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/revoke",
      null,
      expect.objectContaining({ params: { token: "refresh" } }),
    );
    expect(del).toHaveBeenCalledWith({ id: "conn-1" });
  });

  it("skips provider revoke when another tenant still holds the account", async () => {
    vi.mocked(shouldRevokeProviderGrant).mockResolvedValue(false);
    await disconnectStorageConnection("t1", "conn-1");
    expect(axios.post).not.toHaveBeenCalled();
    expect(del).toHaveBeenCalledWith({ id: "conn-1" });
  });
});
