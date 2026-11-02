import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/request-limits";
import { readCappedText } from "@/lib/request-limits";
import { authenticateScim, scimBaseUrl, scimErrorResponse, scimJson, type ScimContext } from "./auth";
import { ScimRequestError } from "./users";

/**
 * Shared plumbing for the /api/scim/v2 handlers: bearer auth, a per-token
 * rate limit, capped JSON body parsing and uniform SCIM error envelopes.
 */

export const MAX_SCIM_BODY = 64_000;

export async function withScim(
  req: Request,
  fn: (ctx: ScimContext, baseUrl: string) => Promise<NextResponse>
): Promise<NextResponse> {
  const auth = await authenticateScim(req);
  if (!auth.ok) return auth.res;
  const limit = rateLimit(`scim:${auth.ctx.tokenId}`, 600, 60_000);
  if (!limit.allowed) return scimErrorResponse(429, "Too many requests.");
  try {
    return await fn(auth.ctx, scimBaseUrl(req));
  } catch (err) {
    if (err instanceof ScimRequestError) return scimErrorResponse(err.status, err.message, err.scimType);
    console.error("[scim] handler failed:", err);
    return scimErrorResponse(500, "Internal error.");
  }
}

/** Parse a capped JSON body. Returns the parsed value or a ready 400/413 response. */
export async function readScimJson(req: Request): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; res: NextResponse }> {
  const text = await readCappedText(req, MAX_SCIM_BODY);
  if (text === null) return { ok: false, res: scimErrorResponse(413, "Payload too large.") };
  if (!text.trim()) return { ok: false, res: scimErrorResponse(400, "Request body is required.", "invalidSyntax") };
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, res: scimErrorResponse(400, "Body must be a JSON object.", "invalidSyntax") };
    return { ok: true, body: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, res: scimErrorResponse(400, "Body is not valid JSON.", "invalidSyntax") };
  }
}

export { scimJson, scimErrorResponse };
