/**
 * Super-admin impersonation on conversation commands.
 *
 * A super-admin viewing another tenant via X-Tenant-Context has a
 * support_agents row in their HOME tenant only (`user_id` is globally unique).
 * Without honouring the header in validateTenant AND allowing that foreign
 * agent on claim/send/release, takeover 403s as operator_not_in_tenant (or
 * 404s because the session is scoped to the JWT home tenant).
 *
 * Deliberately NOT createAuthMocks() — that helper stubs resolveTenantContext.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const auth = vi.hoisted(() => ({
  userId: "",
  tenantId: "",
  agentId: "",
  role: "admin",
}));

vi.mock("@clerk/express", () => ({
  clerkMiddleware: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock("../../middleware/clerk.middleware", () => ({
  requireClerkAuth: (req: any, _res: any, next: any) => {
    req.userId = auth.userId;
    req.tenantId = auth.tenantId;
    req.agentId = auth.agentId;
    req.userRole = auth.role;
    req.user = {
      id: auth.agentId,
      email: "test@example.com",
      role: auth.role,
      tenantId: auth.tenantId,
    };
    next();
  },
  autoProvision: (_req: any, _res: any, next: any) => next(),
  invalidateProvisionCache: () => {},
  resolveClerkIds: () => ({}),
}));

vi.mock("../../websocket/socket.handler", () => ({
  emitToSession: vi.fn(),
  emitToTenantAgents: vi.fn(),
  emitToAgent: vi.fn(),
}));

import request from "supertest";
import { app } from "../../server";
import {
  createTestTenant,
  createTestAnchorBot,
  createTestUser,
  createTestAgent,
  createTestSession,
} from "../helpers/factories";

let homeTenantId: string;
let targetTenantId: string;
let homeAgentId: string;
let homeUserId: string;

beforeEach(async () => {
  const home = await createTestTenant();
  const target = await createTestTenant();
  await createTestAnchorBot(target);
  homeTenantId = home.id;
  targetTenantId = target.id;

  const user = await createTestUser(homeTenantId, { role: "super_admin" });
  const agent = await createTestAgent(homeTenantId, user.id);
  homeUserId = user.id;
  homeAgentId = agent.id;
});

describe("conversation commands — X-Tenant-Context", () => {
  it("a SUPER ADMIN can take over / send / release in the impersonated tenant", async () => {
    const session = await createTestSession(targetTenantId, {
      status: "bot",
      ownership: "bot_owned",
    });
    Object.assign(auth, {
      userId: homeUserId,
      tenantId: homeTenantId,
      agentId: homeAgentId,
      role: "super_admin",
    });

    const takeover = await request(app)
      .post(`/api/v1/chats/${session.id}/takeover`)
      .set("x-tenant-context", targetTenantId)
      .send({ idempotencyKey: "imp-tk", mode: "indefinite" });

    expect(takeover.status).toBe(200);
    expect(takeover.body.data.outcome).toBe("claimed");
    expect(takeover.body.data.conversation).toMatchObject({
      ownership: "human_owned",
      assignedAgentId: homeAgentId,
    });

    const send = await request(app)
      .post(`/api/v1/chats/${session.id}/messages`)
      .set("x-tenant-context", targetTenantId)
      .send({
        clientMessageId: "imp-msg-1",
        content: "hello from impersonation",
      });

    expect(send.status).toBe(201);
    expect(send.body.data.outcome).toBe("sent");

    const release = await request(app)
      .post(`/api/v1/chats/${session.id}/release`)
      .set("x-tenant-context", targetTenantId)
      .send({ idempotencyKey: "imp-rel" });

    expect(release.status).toBe(200);
    expect(release.body.data.conversation.ownership).toBe("bot_owned");
  });

  it("a SUPER ADMIN org-switched into the tenant (no X-Tenant-Context) can take over", async () => {
    // Live portal path: Clerk org switch rewrites JWT/provision tenant to the
    // target. Header is NOT sent. Agent row stays on the home tenant.
    const session = await createTestSession(targetTenantId, {
      status: "bot",
      ownership: "bot_owned",
    });
    Object.assign(auth, {
      userId: homeUserId,
      tenantId: targetTenantId,
      agentId: homeAgentId,
      role: "super_admin",
    });

    const takeover = await request(app)
      .post(`/api/v1/chats/${session.id}/takeover`)
      .send({ idempotencyKey: "org-switch-tk", mode: "indefinite" });

    expect(takeover.status).toBe(200);
    expect(takeover.body.data.outcome).toBe("claimed");
    expect(takeover.body.data.conversation.assignedAgentId).toBe(homeAgentId);
  });

  it("a NON-super-admin cannot use the header to operate another tenant", async () => {
    const session = await createTestSession(targetTenantId, {
      status: "bot",
      ownership: "bot_owned",
    });
    const admin = await createTestUser(homeTenantId, { role: "admin" });
    const adminAgent = await createTestAgent(homeTenantId, admin.id);
    Object.assign(auth, {
      userId: admin.id,
      tenantId: homeTenantId,
      agentId: adminAgent.id,
      role: "admin",
    });

    const res = await request(app)
      .post(`/api/v1/chats/${session.id}/takeover`)
      .set("x-tenant-context", targetTenantId)
      .send({ idempotencyKey: "nope", mode: "indefinite" });

    expect(res.status).toBe(404);
  });
});
