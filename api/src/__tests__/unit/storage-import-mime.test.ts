import { describe, it, expect } from "vitest";
import {
  planForMime,
  sanitizeFileName,
} from "../../integrations/storage/import-mime";

describe("planForMime", () => {
  it("accepts pdf and docx as direct media", () => {
    expect(planForMime("application/pdf")?.kind).toBe("media");
    expect(planForMime("application/pdf")?.docType).toBe("pdf");
    expect(
      planForMime(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      )?.docType,
    ).toBe("docx");
  });

  it("exports Google Docs to docx and Sheets/Slides to pdf", () => {
    expect(planForMime("application/vnd.google-apps.document")).toMatchObject({
      kind: "export",
      docType: "docx",
    });
    expect(
      planForMime("application/vnd.google-apps.spreadsheet")?.docType,
    ).toBe("pdf");
    expect(
      planForMime("application/vnd.google-apps.presentation")?.docType,
    ).toBe("pdf");
  });

  it("rejects folders, images, and zip", () => {
    expect(planForMime("application/vnd.google-apps.folder")).toBeNull();
    expect(planForMime("image/png")).toBeNull();
    expect(planForMime("application/zip")).toBeNull();
  });
});

describe("sanitizeFileName", () => {
  it("strips path traversal and control chars", () => {
    expect(sanitizeFileName("../a b/Q3-pricing.pdf")).toBe(
      ".._a_b_Q3-pricing.pdf",
    );
  });
});
