import { NextResponse, type NextRequest } from "next/server";
import { requireScope, scopeErrorResponse, type Scope } from "@/lib/auth/scope";
import { rateLimitAsync } from "@/lib/request-limits";
import { financeErrorResponse } from "@/lib/finance/http";
import { isLocationError } from "./locations";
import { isTransferError } from "./transfers";
import { isCountError } from "./counts";

/** Shared guard + error mapping for the multi-location inventory routes (area billing). */

export async function inventoryGuard(_req: NextRequest, opts: { edit: boolean; bucket: string; limit?: number }): Promise<{ ok: true; scope: Scope } | { ok: false; res: NextResponse }> {
  let scope: Scope;
  try {
    scope = await requireScope({ area: "billing", edit: opts.edit });
  } catch (err) {
    return { ok: false, res: scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  }
  const rl = await rateLimitAsync(`inv:${opts.bucket}:${scope.dataId}:${scope.userId}`, opts.limit ?? (opts.edit ? 60 : 240), 60_000);
  if (!rl.allowed) return { ok: false, res: NextResponse.json({ error: "rate_limited" }, { status: 429 }) };
  return { ok: true, scope };
}

function status(code: string): number {
  return code === "not_found" ? 404 : code === "bad_state" || code === "has_stock" || code === "is_default" ? 409 : 400;
}

export function inventoryErrorResponse(err: unknown, log: string): NextResponse {
  if (isLocationError(err) || isTransferError(err) || isCountError(err)) {
    const code = (err as { code: string }).code;
    return NextResponse.json({ error: code, detail: err.message }, { status: status(code) });
  }
  return financeErrorResponse(err, log);
}
