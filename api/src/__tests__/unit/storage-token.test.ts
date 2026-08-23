/**
 * Shared storage OAuth token module.
 *
 * Seams: getValidAccessToken (refresh-with-lock) and shouldRevokeProviderGrant.
 * Provider HTTP is injected via a refresher callback — this module never talks
 * to Google/Microsoft itself.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

interface TokenRow {
  id: string;
  accessTokenEnc: string;
  refreshTokenEnc: string | null;
  tokenExpiry: Date | null;
  reauthRequired: boolean;
}

const save = vi.fn(async (row: TokenRow) => row);
const count = vi.fn();
let lockedRow: TokenRow | null = null;

vi.mock("../../config/environment", () => ({
  config: { encryption: { key: "test-key", ivLength: 16 } },
}));

vi.mock("../../utils/encryption", () => ({
  encrypt: (x: string) => `enc(${x})`,
  decrypt: (x: string) => (x.startsWith("enc(") ? x.slice(4, -1) : x),
}));

vi.mock("../../database/data-source", () => ({
  AppDataSource: {
    getRepository: () => ({ save, count }),
    transaction: async (
      cb: (manager: {
        save: typeof save;
        createQueryBuilder: () => {
          setLock: () => {
            where: () => { getOne: () => Promise<TokenRow | null> };
          };
        };
      }) => Promise<unknown>,
    ) =>
      cb({
        save,
        createQueryBuilder: () => ({
          setLock: () => ({
            where: () => ({
              getOne: async () => lockedRow,
            }),
          }),
        }),
      }),
  },
}));

vi.mock("../../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  getValidAccessToken,
  shouldRevokeProviderGrant,
  StorageReauthRequiredError,
  applyTokens,
} from "../../integrations/storage/token";
import type { StorageConnection } from "../../database/entities/StorageConnection";

function connection(overrides: Partial<TokenRow> = {}): StorageConnection {
  return {
    id: "conn-1",
    accessTokenEnc: "enc(cached)",
    refreshTokenEnc: "enc(refresh-1)",
    tokenExpiry: new Date(Date.now() + 10 * 60_000),
    reauthRequired: false,
    ...overrides,
  } as StorageConnection;
}

describe("applyTokens", () => {
  it("encrypts access + refresh and clears reauthRequired", () => {
    const row = connection({ reauthRequired: true, refreshTokenEnc: null });
    applyTokens(row, {
      accessToken: "access-plain",
      refreshToken: "refresh-plain",
      expiry: new Date("2026-08-23T12:00:00.000Z"),
    });
    expect(row.accessTokenEnc).toBe("enc(access-plain)");
    expect(row.refreshTokenEnc).toBe("enc(refresh-plain)");
    expect(row.reauthRequired).toBe(false);
    expect(row.tokenExpiry?.toISOString()).toBe("2026-08-23T12:00:00.000Z");
  });
});

describe("getValidAccessToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lockedRow = null;
  });

  it("returns the cached access token when not expired", async () => {
    const refresher = vi.fn();
    const token = await getValidAccessToken(connection(), refresher);
    expect(token).toBe("cached");
    expect(refresher).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("refreshes under a row lock, persists rotated refresh BEFORE returning access", async () => {
    const row = connection({
      tokenExpiry: new Date(Date.now() - 1000),
      accessTokenEnc: "enc(old)",
    });
    lockedRow = { ...row };
    const refresher = vi.fn(async () => ({
      accessToken: "fresh-access",
      refreshToken: "rotated-refresh",
      expiry: new Date(Date.now() + 3600_000),
    }));

    const token = await getValidAccessToken(row, refresher);

    expect(token).toBe("fresh-access");
    expect(refresher).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
    const persisted = save.mock.calls[0][0];
    expect(persisted.refreshTokenEnc).toBe("enc(rotated-refresh)");
    expect(persisted.accessTokenEnc).toBe("enc(fresh-access)");
    expect(persisted.reauthRequired).toBe(false);
  });

  it("uses the winner of a concurrent refresh (re-read inside the lock, no second refresh)", async () => {
    const row = connection({ tokenExpiry: new Date(Date.now() - 1000) });
    lockedRow = {
      ...row,
      accessTokenEnc: "enc(already-fresh)",
      tokenExpiry: new Date(Date.now() + 10 * 60_000),
      reauthRequired: false,
    };
    const refresher = vi.fn();

    const token = await getValidAccessToken(row, refresher);

    expect(token).toBe("already-fresh");
    expect(refresher).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("flags reauthRequired and throws on invalid_grant", async () => {
    const row = connection({ tokenExpiry: new Date(Date.now() - 1000) });
    lockedRow = { ...row };
    const refresher = vi.fn(async () => {
      throw { response: { data: { error: "invalid_grant" } } };
    });

    await expect(getValidAccessToken(row, refresher)).rejects.toBeInstanceOf(
      StorageReauthRequiredError,
    );
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0][0].reauthRequired).toBe(true);
  });

  it("does not flag reauthRequired on a transient refresh error", async () => {
    const row = connection({ tokenExpiry: new Date(Date.now() - 1000) });
    lockedRow = { ...row };
    const refresher = vi.fn(async () => {
      throw Object.assign(new Error("network"), { code: "ETIMEDOUT" });
    });

    await expect(getValidAccessToken(row, refresher)).rejects.toThrow(
      "network",
    );
    expect(save).not.toHaveBeenCalled();
  });

  it("throws STORAGE_REAUTH_REQUIRED when there is no refresh token", async () => {
    const row = connection({
      tokenExpiry: new Date(Date.now() - 1000),
      refreshTokenEnc: null,
    });
    lockedRow = { ...row };

    await expect(getValidAccessToken(row, vi.fn())).rejects.toBeInstanceOf(
      StorageReauthRequiredError,
    );
    expect(save.mock.calls[0][0].reauthRequired).toBe(true);
  });
});

describe("shouldRevokeProviderGrant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns true when this is the last active connection for the account", async () => {
    count.mockResolvedValue(0);
    await expect(
      shouldRevokeProviderGrant("google_drive", "sub-1", "conn-1"),
    ).resolves.toBe(true);
  });

  it("returns false when another tenant still holds the same account", async () => {
    count.mockResolvedValue(1);
    await expect(
      shouldRevokeProviderGrant("google_drive", "sub-1", "conn-1"),
    ).resolves.toBe(false);
  });
});
