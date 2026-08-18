import { describe, it, expect, beforeEach, vi } from "vitest";
import { createAuthMocks, configureMockAuth } from "../helpers/auth";

const { auth } = createAuthMocks();

vi.mock("@clerk/express", () => ({
  clerkMiddleware: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock("../../websocket/socket.handler", () => ({
  emitToSession: vi.fn(),
  emitToTenantAgents: vi.fn(),
  emitToAgent: vi.fn(),
}));

vi.mock("../../utils/audit", () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

import request from "supertest";
import { app } from "../../server";
import { AppDataSource } from "../../database/data-source";
import { AvailabilityRule } from "../../database/entities/AvailabilityRule";
import { Tenant } from "../../database/entities/Tenant";
import {
  createTestTenant,
  createTestUser,
  createTestAnchorBot,
} from "../helpers/factories";

describe("Tenant Management", () => {
  let tenantId: string;

  beforeEach(async () => {
    const tenant = await createTestTenant();
    tenantId = tenant.id;

    const admin = await createTestUser(tenantId, { role: "admin" });

    configureMockAuth(auth, {
      userId: admin.id,
      tenantId,
      role: "admin",
    });
  });

  describe("GET /api/v1/tenants/me", () => {
    it("should return current tenant details", async () => {
      const res = await request(app).get("/api/v1/tenants/me");

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(tenantId);
      expect(res.body.data.name).toBeDefined();
    });
  });

  describe("PATCH /api/v1/tenants/me", () => {
    it("ignores webhookUrl from a non-super_admin (escape hatch is super_admin only)", async () => {
      const res = await request(app)
        .patch("/api/v1/tenants/me")
        .send({ webhookUrl: "https://example.com/webhook" });

      expect(res.status).toBe(200);
      // Silently ignored for a plain admin — the field is super_admin-gated.
      expect(res.body.data.webhookUrl ?? null).toBeNull();
    });

    it("allows a super_admin to set the webhook URL", async () => {
      configureMockAuth(auth, {
        userId: auth.userId,
        tenantId,
        role: "super_admin",
      });

      const res = await request(app)
        .patch("/api/v1/tenants/me")
        .send({ webhookUrl: "https://example.com/webhook" });

      expect(res.status).toBe(200);
      expect(res.body.data.webhookUrl).toBe("https://example.com/webhook");
    });

    it("syncs enabled businessHours onto the slot-engine AvailabilityRule", async () => {
      const tenant = await AppDataSource.getRepository(Tenant).findOneByOrFail({
        id: tenantId,
      });
      const bot = await createTestAnchorBot(tenant);
      const rule = AppDataSource.getRepository(AvailabilityRule).create({
        bot,
        tenantId,
        weeklyHours: {},
        dateOverrides: [],
      });
      await AppDataSource.getRepository(AvailabilityRule).save(rule);

      const res = await request(app)
        .patch("/api/v1/tenants/me")
        .send({
          businessHours: {
            enabled: true,
            schedule: [
              { day: "tuesday", open: "10:00", close: "18:00", closed: false },
            ],
          },
        });

      expect(res.status).toBe(200);
      const updated = await AppDataSource.getRepository(
        AvailabilityRule,
      ).findOneByOrFail({ id: rule.id });
      expect(updated.weeklyHours.tue).toEqual([
        { start: "10:00", end: "18:00" },
      ]);
      expect(updated.weeklyHours.mon).toBeUndefined();
    });

    it("leaves the AvailabilityRule alone when businessHours are disabled", async () => {
      const tenant = await AppDataSource.getRepository(Tenant).findOneByOrFail({
        id: tenantId,
      });
      const bot = await createTestAnchorBot(tenant);
      const rule = AppDataSource.getRepository(AvailabilityRule).create({
        bot,
        tenantId,
        weeklyHours: { mon: [{ start: "09:00", end: "17:00" }] },
        dateOverrides: [],
      });
      await AppDataSource.getRepository(AvailabilityRule).save(rule);

      const res = await request(app)
        .patch("/api/v1/tenants/me")
        .send({ businessHours: { enabled: false, schedule: [] } });

      expect(res.status).toBe(200);
      const updated = await AppDataSource.getRepository(
        AvailabilityRule,
      ).findOneByOrFail({ id: rule.id });
      expect(updated.weeklyHours.mon).toEqual([
        { start: "09:00", end: "17:00" },
      ]);
    });
  });

  describe("POST /api/v1/admin/tenants/:id/api-key/rotate", () => {
    it("should rotate the API key and return the new key", async () => {
      // Admin route requires super_admin
      configureMockAuth(auth, {
        userId: auth.userId,
        tenantId,
        role: "super_admin",
      });

      const res = await request(app)
        .post(`/api/v1/admin/tenants/${tenantId}/api-key/rotate`)
        .send();

      expect(res.status).toBe(200);
      expect(res.body.data.apiKey).toBeDefined();
      expect(typeof res.body.data.apiKey).toBe("string");
    });
  });

  describe("GET /api/v1/widget/config", () => {
    it("should return widget configuration for valid apiKey", async () => {
      const tenant = await createTestTenant({ name: "Widget Test Tenant" });
      // Anchor bot is required for `resolveBotKey` to resolve the legacy
      // tenant.apiKey path — production tenants always have one via the
      // auto-provision flow.
      await createTestAnchorBot(tenant);

      const res = await request(app)
        .get("/api/v1/widget/config")
        .query({ apiKey: tenant.apiKey });

      expect(res.status).toBe(200);
      expect(res.body.data.tenantId).toBe(tenant.id);
      expect(res.body.data.name).toBe("Widget Test Tenant");
      expect(res.body.data.bot?.id).toBeDefined();
    });
  });
});
