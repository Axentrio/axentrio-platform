/**
 * Cloud-import MIME policy. Files only; folders rejected.
 * Google native types are exported to PDF/DOCX before ingest.
 */
export const MAX_IMPORT_FILES = 50;
export const MAX_IMPORT_BYTES = 25 * 1024 * 1024;
export const MAX_GOOGLE_EXPORT_BYTES = 10 * 1024 * 1024;
export const MAX_RUNNING_JOBS_PER_TENANT = 3;

export const KB_PDF = "application/pdf";
export const KB_DOCX =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const GOOGLE_DOC = "application/vnd.google-apps.document";
const GOOGLE_SHEET = "application/vnd.google-apps.spreadsheet";
const GOOGLE_SLIDE = "application/vnd.google-apps.presentation";

export type ImportDocType = "pdf" | "docx";

export interface ExportPlan {
  kind: "media" | "export";
  detectedMime: string;
  docType: ImportDocType;
  exportMime?: string;
}

export function planForMime(mimeType: string): ExportPlan | null {
  if (mimeType === KB_PDF) {
    return { kind: "media", detectedMime: KB_PDF, docType: "pdf" };
  }
  if (mimeType === KB_DOCX) {
    return { kind: "media", detectedMime: KB_DOCX, docType: "docx" };
  }
  if (mimeType === GOOGLE_DOC) {
    return {
      kind: "export",
      detectedMime: KB_DOCX,
      docType: "docx",
      exportMime: KB_DOCX,
    };
  }
  if (mimeType === GOOGLE_SHEET || mimeType === GOOGLE_SLIDE) {
    return {
      kind: "export",
      detectedMime: KB_PDF,
      docType: "pdf",
      exportMime: KB_PDF,
    };
  }
  return null;
}

export function sanitizeFileName(name: string): string {
  return (name || "file")
    .replace(/[^a-zA-Z0-9.-]/g, "_")
    .replace(/_{2,}/g, "_")
    .slice(0, 100);
}
