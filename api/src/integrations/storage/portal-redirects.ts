/**
 * Shared portal redirect helpers for the storage OAuth controllers.
 * The redirect target comes from config (PORTAL_URL / CORS allowlist),
 * never from the request.
 */
import type { Response } from "express";
import { config } from "../../config/environment";

export function storagePortalBase(): string {
 if (config.portal.url) return config.portal.url.replace(/\/$/, "");
 const origin = config.cors.origin;
 if (typeof origin === "string" && origin.startsWith("http")) return origin;
 if (Array.isArray(origin) && origin[0]?.startsWith("http")) return origin[0];
 return "http://localhost:5173";
}

export function storageApiBase(): string {
 return config.api.url.replace(/\/$/, "");
}

export function redirectToKnowledge(
 res: Response,
 status: "connected" | "error",
): void {
 const origin = storagePortalBase();
 const flag = status === "connected" ? "connected" : "error";
 res.statusCode = 302;
 res.setHeader("Location", `${origin}/ai?tab=knowledge&storage=${flag}`);
 res.end();
}

/**
 * 302 to an OAuth consent screen. The URL must carry the allowlisted
 * provider host; the Location header is rebuilt from a literal origin so no
 * request data can turn this into an open redirect.
 */
export function redirectToProviderConsent(
 res: Response,
 url: string,
 consentHost: "accounts.google.com" | "login.microsoftonline.com",
): void {
 let parsed: URL;
 try {
   parsed = new URL(url);
 } catch {
   redirectToKnowledge(res, "error");
   return;
 }
 if (parsed.protocol !== "https:" || parsed.hostname !== consentHost) {
   redirectToKnowledge(res, "error");
   return;
 }
 // Host allowlisted above. Origin is a string literal.
 // pi-lens-ignore: ast-grep:no-open-redirect-js
 // pi-lens-ignore: ts-open-redirect
 res.statusCode = 302;
 res.setHeader(
   "Location",
   `https://${consentHost}${parsed.pathname}${parsed.search}`,
 );
 res.end();
}
