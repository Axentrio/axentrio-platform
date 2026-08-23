import { describe, it, expect } from "vitest";
import type { Request } from "express";
import { assertCanConnectStorage } from "../../integrations/storage/google-drive.controller";

function req(
  overrides: Partial<Request> & {
    user?: Request["user"];
    userId?: string;
    tenantId?: string;
  },
): Request {
  return overrides as Request;
}

describe("assertCanConnectStorage", () => {
  it("allows a tenant admin connecting for their own tenant", () => {
    expect(() =>
      assertCanConnectStorage(
        req({
          userId: "u1",
          tenantId: "t1",
          user: {
            id: "a1",
            email: "a@x",
            role: "admin",
            tenantId: "t1",
            type: "agent",
          },
        }),
      ),
    ).not.toThrow();
  });

  it("blocks a super-admin impersonating another tenant", () => {
    try {
      assertCanConnectStorage(
        req({
          userId: "sa1",
          tenantId: "customer-t",
          user: {
            id: "sa-agent",
            email: "sa@x",
            role: "super_admin",
            tenantId: "home-t",
            type: "agent",
          },
        }),
      );
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toMatchObject({
        code: "impersonated_connect_forbidden",
        statusCode: 403,
      });
    }
  });
});
