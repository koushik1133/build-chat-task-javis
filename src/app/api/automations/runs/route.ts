import { NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { listRuns, toRunDTO } from "@/lib/automations/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET: recent runs across every automation (keyset on created_at via ?before=). */
export async function GET(req: Request) {
  let scope;
  try {
    scope = await requireScope({ area: "agents", edit: false });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1), 200);
  const rows = await listRuns(scope.dataId, { status: url.searchParams.get("status"), limit: limit + 1, before: url.searchParams.get("before") }).catch(() => []);
  const page = rows.slice(0, limit).map(toRunDTO);
  const next_cursor = rows.length > limit ? page[page.length - 1]?.created_at ?? null : null;
  return NextResponse.json({ runs: page, next_cursor });
}
