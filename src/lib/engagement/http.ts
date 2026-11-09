import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, scopeErrorResponse, type Scope } from "@/lib/auth/scope";
import { planGate } from "@/lib/plans/http";
import type { FeatureKey } from "@/lib/plans/catalog";
import { rateLimitAsync, readCappedText } from "@/lib/request-limits";

/** Shared plumbing for the /api/engagement/* staff routes. */

export type EngScope = Scope;

export async function engScope(area: "crm" | "billing", edit: boolean): Promise<Scope | NextResponse> {
  try {
    return await requireScope({ area, edit });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
}
export const isResponse = (v: unknown): v is NextResponse => v instanceof NextResponse;

/** Per-actor write limiter; returns a 429 response or null. */
export async function writeLimit(scope: Scope, bucket: string, limit = 60): Promise<NextResponse | null> {
  const r = await rateLimitAsync(`eng:${bucket}:${scope.dataId}:${scope.userId}`, limit, 60_000);
  return r.allowed ? null : NextResponse.json({ error: "rate_limited" }, { status: 429 });
}

export async function gate(scope: Scope, feature: FeatureKey): Promise<NextResponse | null> {
  return planGate(scope, { feature });
}

export async function body<T extends z.ZodTypeAny>(req: NextRequest, schema: T, maxBytes = 64_000): Promise<{ ok: true; data: z.infer<T> } | { ok: false; res: NextResponse }> {
  const text = await readCappedText(req, maxBytes);
  if (text === null) return { ok: false, res: NextResponse.json({ error: "payload_too_large" }, { status: 413 }) };
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { return { ok: false, res: NextResponse.json({ error: "invalid_json" }, { status: 400 }) }; }
  const parsed = schema.safeParse(json);
  if (!parsed.success) return { ok: false, res: NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 }) };
  return { ok: true, data: parsed.data };
}

const CLIENT_ERRORS = new Set(["LoyaltyError", "SurveyError", "TestimonialError", "DiscountApplicationError"]);
export function fail(err: unknown, log: string): NextResponse {
  const msg = err instanceof Error ? err.message : "error";
  if (err instanceof Error && CLIENT_ERRORS.has(err.name)) {
    const code = (err as { code?: string }).code;
    return NextResponse.json({ error: code ?? "invalid_request", detail: msg }, { status: code === "not_found" ? 404 : 400 });
  }
  if (/not found/i.test(msg)) return NextResponse.json({ error: "not_found", detail: msg }, { status: 404 });
  if (/already exists|not usable|expired|does not match|cannot take|positive whole|non-zero|void/i.test(msg)) return NextResponse.json({ error: "invalid_request", detail: msg }, { status: 400 });
  console.error(`[${log}]`, err);
  return NextResponse.json({ error: "internal_error" }, { status: 500 });
}

export function limitParam(req: NextRequest, def = 50): number {
  const n = Number(req.nextUrl.searchParams.get("limit"));
  return Number.isFinite(n) && n > 0 ? Math.min(Math.trunc(n), 200) : def;
}
