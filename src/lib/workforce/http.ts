import { NextResponse, type NextRequest } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { rateLimitAsync } from "@/lib/request-limits";
import { WorkforceError } from "./staff";

/** Route-handler glue for /api/workforce: scope (area "team"), rate limit and error mapping. */

export type Scope = Awaited<ReturnType<typeof requireScope>>;

export async function workforceScope(req: NextRequest, edit: boolean): Promise<{ ok: true; scope: Scope } | { ok: false; res: NextResponse }> {
  let scope: Scope;
  try {
    scope = await requireScope({ area: "team", edit });
  } catch (err) {
    return { ok: false, res: scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  }
  const rl = await rateLimitAsync(`workforce:${scope.userId}:${edit ? "w" : "r"}`, edit ? 120 : 600, 60_000);
  if (!rl.allowed) return { ok: false, res: NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000))) } }) };
  void req;
  return { ok: true, scope };
}

export function workforceError(err: unknown, log: string): NextResponse {
  if (err instanceof WorkforceError) {
    const code = err.status === 404 ? "not_found" : err.status === 409 ? "conflict" : err.status === 400 ? "bad_request" : "error";
    return NextResponse.json({ error: code, detail: err.message, ...(err.details && typeof err.details === "object" ? (err.details as Record<string, unknown>) : {}) }, { status: err.status });
  }
  const scoped = scopeErrorResponse(err);
  if (scoped) return scoped;
  console.error(`[${log}]`, err);
  return NextResponse.json({ error: "internal_error" }, { status: 500 });
}

export async function paramId(ctx: { params: Promise<{ id: string }> }): Promise<string> {
  const { id } = await ctx.params;
  return String(id ?? "").slice(0, 100);
}
