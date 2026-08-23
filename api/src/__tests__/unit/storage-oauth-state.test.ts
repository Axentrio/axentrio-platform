import { describe, it, expect, beforeEach, vi } from "vitest";

const redis = {
  set: vi.fn(),
  get: vi.fn(),
  getdel: vi.fn(),
};

vi.mock("../../config/environment", () => ({
  config: {
    googleStorage: { stateSecret: "unit-state-secret-at-least-32-chars!!" },
    server: { isProduction: false },
    encryption: { key: "test-key-test-key-test-key-test!", ivLength: 16 },
  },
}));

vi.mock("../../config/redis", () => ({
  getRedisClient: vi.fn(() => redis),
}));

import { getRedisClient } from "../../config/redis";
import {
  nonceFromCookie,
  peekOAuthState,
  pkceChallenge,
  pkceVerifier,
  putOAuthState,
  signNonce,
  takeOAuthState,
} from "../../integrations/storage/oauth-state";

describe("pkce", () => {
  it("produces an S256 challenge that is not the verifier", () => {
    const verifier = pkceVerifier();
    const challenge = pkceChallenge(verifier);
    expect(challenge).not.toBe(verifier);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("signed nonce cookie", () => {
  it("round-trips a nonce and rejects a tampered mac", () => {
    const nonce = "abc123";
    const signed = signNonce(nonce);
    expect(nonceFromCookie(signed)).toBe(nonce);
    expect(nonceFromCookie(signed.slice(0, -1) + "x")).toBeNull();
    expect(nonceFromCookie(nonce)).toBeNull();
  });
});

describe("redis state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getRedisClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      redis,
    );
  });

  const payload = {
    tenantId: "t1",
    userId: "u1",
    provider: "google_drive" as const,
    codeVerifier: "ver",
    purpose: "storage-connect" as const,
  };

  it("puts state with a 15-minute TTL", async () => {
    redis.set.mockResolvedValue("OK");
    await putOAuthState("n1", payload);
    expect(redis.set).toHaveBeenCalledWith(
      "storage:oauth:n1",
      JSON.stringify(payload),
      "EX",
      15 * 60,
    );
  });

  it("fails closed when Redis is down", async () => {
    (getRedisClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      null,
    );
    await expect(putOAuthState("n1", payload)).rejects.toMatchObject({
      code: "oauth_state_unavailable",
      statusCode: 503,
    });
  });

  it("takeOAuthState consumes the key so a replay fails", async () => {
    redis.getdel.mockResolvedValueOnce(JSON.stringify(payload));
    redis.getdel.mockResolvedValueOnce(null);
    await expect(takeOAuthState("n1")).resolves.toMatchObject({
      tenantId: "t1",
    });
    await expect(takeOAuthState("n1")).rejects.toMatchObject({
      code: "oauth_state_invalid",
    });
  });

  it("peekOAuthState does not consume the key", async () => {
    redis.get.mockResolvedValue(JSON.stringify(payload));
    await expect(peekOAuthState("n1")).resolves.toMatchObject({ userId: "u1" });
    expect(redis.getdel).not.toHaveBeenCalled();
  });
});
