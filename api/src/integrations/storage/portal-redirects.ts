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
