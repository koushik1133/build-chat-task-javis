import { NextResponse } from "next/server";
import { requireScope, scopeErrorResponse, ScopeError } from "@/lib/auth/scope";
import { bearerToken, requireApiKey } from "@/lib/public-api/auth";
import { ApiError } from "@/lib/public-api/envelope";

/**
 * Demo routes accept either a signed-in owner/admin session or a public API
 * key with the `write:settings` scope (used by scripts/seed-demo.mjs).
 */
export async function requireDemoActor(req: Request): Promise<{ dataId: string; userId: string } | NextResponse> {
  if (bearerToken(req)) {
    try {
      const p = await requireApiKey(req, "write:settings");
      return { dataId: p.dataId, userId: p.userId };
    } catch (err) {
      if (err instanceof ApiError) return NextResponse.json({ error: err.message }, { status: err.status, headers: err.headers });
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }
  try {
    const scope = await requireScope({ area: "settings", edit: true });
    if (scope.role !== "owner" && scope.role !== "admin") throw new ScopeError("FORBIDDEN", "Only owners and admins can manage sample data.");
    return { dataId: scope.dataId, userId: scope.userId };
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
}
