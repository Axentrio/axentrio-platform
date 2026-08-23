import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../config/environment", () => ({
  config: {
    clamav: { enabled: true },
    s3: { bucket: "bucket" },
    googleStorage: { clientId: "cid" },
  },
}));

vi.mock("../../integrations/storage/import.worker", () => ({
  STORAGE_IMPORT_QUEUE: "storage-import",
}));

vi.mock("../../queue/message-queue", () => ({
  addJob: vi.fn(async () => undefined),
}));

vi.mock("../../knowledge/knowledge.service", () => ({
  KnowledgeService: class {
    resolveKnowledgeBase = vi.fn(async () => ({ id: "kb1" }));
    remainingDocumentSlots = vi.fn(async () => 40);
  },
}));

const save = vi.fn(async (row: Record<string, unknown>) => ({
  ...row,
  id: row.id ?? "job-1",
}));
const findOne = vi.fn();
const count = vi.fn(async () => 0);
const create = vi.fn((x: unknown) => x);

vi.mock("../../database/data-source", () => ({
  AppDataSource: {
    getRepository: () => ({ save, findOne, count, create }),
  },
}));

vi.mock("axios", () => ({
  default: { get: vi.fn(), post: vi.fn() },
}));
import axios from "axios";

import { addJob } from "../../queue/message-queue";
import { enqueueStorageImport } from "../../integrations/storage/import.service";

describe("enqueueStorageImport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    count.mockResolvedValue(0);
    findOne.mockImplementation(
      async (opts: { where?: { providerAccountId?: string } }) => {
        if (opts?.where && "providerAccountId" in (opts.where as object)) {
          return null;
        }
        // StorageConnection lookup
        if (opts?.where && "id" in (opts.where as object)) {
          return {
            id: "conn-1",
            tenantId: "t1",
            provider: "google_drive",
            providerAccountId: "sub-9",
            status: "active",
            reauthRequired: false,
          };
        }
        return null;
      },
    );
    (axios.get as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { sub: "sub-9" },
    });
  });

  it("rejects more than 50 files", async () => {
    await expect(
      enqueueStorageImport({
        tenantId: "t1",
        userId: "u1",
        storageConnectionId: "conn-1",
        googleAccessToken: "tok",
        files: Array.from({ length: 51 }, (_, i) => ({ id: `f${i}` })),
      }),
    ).rejects.toThrow(/at most 50/);
  });

  it("rejects when the picker account does not match the connection", async () => {
    (axios.get as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { sub: "other-sub" },
    });
    await expect(
      enqueueStorageImport({
        tenantId: "t1",
        userId: "u1",
        storageConnectionId: "conn-1",
        googleAccessToken: "tok",
        files: [{ id: "file-1", mimeType: "application/pdf" }],
      }),
    ).rejects.toMatchObject({ code: "storage_account_mismatch" });
  });

  it("enqueues a pdf with a deterministic job id", async () => {
    await enqueueStorageImport({
      tenantId: "t1",
      userId: "u1",
      storageConnectionId: "conn-1",
      googleAccessToken: "tok",
      files: [{ id: "file-1", name: "a.pdf", mimeType: "application/pdf" }],
    });
    expect(addJob).toHaveBeenCalledWith(
      "storage-import",
      expect.objectContaining({ fileId: "file-1", provider: "google_drive" }),
      { jobId: "import-kb1-google_drive-file-1" },
    );
  });
});
