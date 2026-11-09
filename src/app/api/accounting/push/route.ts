import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getConnection } from "@/lib/accounting/connections";
import { pushEntity, pushToAll } from "@/lib/accounting/sync";
import { ACCOUNTING_ENTITY_KINDS } from "@/lib/accounting/types";
import { billingScope, isResponse } from "../_shared";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.object({
  kind: z.enum(ACCOUNTING_ENTITY_KINDS),
  id: z.string().trim().min(1).max(100),
  /** Omit to push to every connected integration. */
  connection_id: z.string().trim().min(1).max(100).optional(),
  /** Push a draft invoice anyway. */
  force: z.boolean().optional(),
}).strict();

/** Manual push of one entity. */
export async function POST(req: NextRequest) {
  const scope = await billingScope(true);
  if (isResponse(scope)) return scope;
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "Invalid body", detail: body.error.flatten() }, { status: 400 });
  const { kind, id, connection_id, force } = body.data;
  try {
    if (connection_id) {
      const conn = await getConnection(scope.dataId, connection_id);
      if (!conn) return NextResponse.json({ error: "Connection not found" }, { status: 404 });
      const out = await pushEntity(conn.id, kind, id, { force });
      return NextResponse.json({ results: [out] }, { status: out.status === "error" ? 422 : 200 });
    }
    const results = await pushToAll(scope.dataId, kind, id);
    if (results.length === 0) return NextResponse.json({ error: "No accounting integration is connected." }, { status: 409 });
    return NextResponse.json({ results }, { status: results.every((r) => r.status === "error") ? 422 : 200 });
  } catch (err) {
    console.error("[accounting/push] failed:", err);
    return NextResponse.json({ error: "Push failed." }, { status: 500 });
  }
}
