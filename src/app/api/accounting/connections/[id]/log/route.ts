import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getConnection, listSyncLog } from "@/lib/accounting/connections";
import { billingScope, isResponse } from "../../../_shared";

export const dynamic = "force-dynamic";

const Query = z.object({
  status: z.enum(["ok", "error", "skipped"]).optional(),
  direction: z.enum(["push", "pull"]).optional(),
  kind: z.enum(["contact", "invoice", "payment", "expense", "product"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const scope = await billingScope(false);
  if (isResponse(scope)) return scope;
  const { id } = await ctx.params;
  if (!id || id.length > 100) return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  const q = Query.safeParse(Object.fromEntries([...req.nextUrl.searchParams.entries()].filter(([, v]) => v !== "")));
  if (!q.success) return NextResponse.json({ error: "Invalid query", detail: q.error.flatten() }, { status: 400 });
  const row = await getConnection(scope.dataId, id);
  if (!row) return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  const entries = await listSyncLog(scope.dataId, id, q.data);
  return NextResponse.json({ entries });
}
