/**
 * Socket `handoff:request` must notify operators the same way REST does:
 * outbox row + platform notification + durable email.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { createServer, type Server as HttpServer } from "http";
import { randomUUID } from "crypto";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";

const tokenMap = vi.hoisted(() => ({}) as Record<string, { sub: string }>);
vi.mock("@clerk/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@clerk/backend")>()),
  verifyToken: (token: string) =>
    Promise.resolve(tokenMap[token] ?? { sub: "unknown" }),
}));

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../../automations", () => ({ getEmailService: () => ({ send }) }));
vi.mock("../../queue/message-queue", () => ({
  addNotificationJob: vi.fn().mockResolvedValue(undefined),
}));

import { initializeSocketIO } from "../../websocket/socket.handler";
import { AppDataSource } from "../../database/data-source";
import { EmailDelivery } from "../../database/entities/EmailDelivery";
import { HandoffRequest } from "../../database/entities/HandoffRequest";
import { Notification } from "../../database/entities/Notification";
import { NotificationOutbox } from "../../database/entities/NotificationOutbox";
import {
  createTestTenant,
  createTestUser,
  createTestAgent,
  createTestSession,
} from "../helpers/factories";

let httpServer: HttpServer;
let port: number;

beforeAll(async () => {
  httpServer = createServer();
  initializeSocketIO(httpServer);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  port = (httpServer.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

beforeEach(() => {
  send.mockReset();
  send.mockResolvedValue({
    success: true,
    messageId: "socket-handoff-email-1",
  });
});

async function connectOperator(token: string): Promise<ClientSocket> {
  const client = ioClient(`http://localhost:${port}`, {
    auth: { token },
    transports: ["websocket"],
    reconnection: false,
  });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`connect timeout for ${token}`)),
      4000,
    );
    client.on("connection:ack", () => {
      clearTimeout(t);
      resolve();
    });
    client.on("connect_error", (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
  return client;
}

function waitForEvent(
  client: ClientSocket,
  event: string,
  ms = 2000,
): Promise<unknown> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    client.once(event, (data) => {
      clearTimeout(t);
      resolve(data);
    });
  });
}

async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for socket handoff notification fan-out");
}

describe("socket handoff:request notifications", () => {
  it("writes outbox + platform notification + email like the REST paths", async () => {
    const tenant = await createTestTenant({ name: "Socket Handoff Co" });
    const operator = await createTestUser(tenant.id, {
      email: "socket-op@example.com",
      clerkUserId: `clerk-sock-ho-${randomUUID()}`,
      notificationPreferences: null,
    });
    await createTestAgent(tenant.id, operator.id);
    const session = await createTestSession(tenant.id, { status: "bot" });
    tokenMap["tok-ho"] = { sub: operator.clerkUserId! };

    const client = await connectOperator("tok-ho");
    try {
      const ack = waitForEvent(client, "handoff:request:ack");
      const requested = waitForEvent(client, "handoff:requested");
      client.emit("handoff:request", {
        sessionId: session.id,
        reason: "User requested",
      });
      expect(await ack).toMatchObject({
        sessionId: session.id,
        status: "pending",
      });
      expect(await requested).toMatchObject({
        id: session.id,
        chatId: session.id,
        sessionId: session.id,
        status: "pending",
      });

      const handoff = await AppDataSource.getRepository(
        HandoffRequest,
      ).findOneByOrFail({
        sessionId: session.id,
      });
      const notificationRepo = AppDataSource.getRepository(Notification);
      const emailRepo = AppDataSource.getRepository(EmailDelivery);
      const outboxRepo = AppDataSource.getRepository(NotificationOutbox);
      // The outbox worker flushes rows async (pending → sent); poll until the
      // row exists AND is sent so the assertion below isn't a race (CI flake).
      let outbox: Array<{ status: string }> = [];
      await waitFor(async () => {
        const notifications = await notificationRepo.count({
          where: { tenantId: tenant.id, type: "handoff_requested" },
        });
        const emails = await emailRepo.count({
          where: { tenantId: tenant.id, relatedId: handoff.id, status: "sent" },
        });
        outbox = await outboxRepo.find({
          where: { relatedId: handoff.id, kind: "handoff" },
        });
        return (
          notifications === 1 &&
          emails === 1 &&
          outbox.length === 1 &&
          outbox[0].status === "sent"
        );
      });

      expect(outbox).toHaveLength(1);
      expect(outbox[0].status).toBe("sent");
    } finally {
      client.close();
    }
  });
});
