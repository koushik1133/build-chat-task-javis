import { NextRequest, NextResponse } from "next/server";
import { recordAudit } from "@/lib/audit";
import { body, engScope, fail, gate, isResponse, writeLimit } from "@/lib/engagement/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
import { getProgram, updateProgram } from "@/lib/engagement/loyalty";
import { ProgramPatchSchema } from "@/lib/engagement/pure";
import { queryOne } from "@/lib/dsql";

export async function GET() {
  const scope = await engScope("crm", false);
  if (isResponse(scope)) return scope;
  try {
    const stats = await queryOne<{ accounts: string; outstanding: string }>(`SELECT COUNT(*) AS accounts, COALESCE(SUM(balance), 0) AS outstanding FROM loyalty_accounts WHERE user_id = $1`, [scope.dataId]);
    return NextResponse.json({ program: await getProgram(scope.dataId), stats: { accounts: Number(stats?.accounts ?? 0), outstanding_points: Number(stats?.outstanding ?? 0) } });
  } catch (err) {
    return fail(err, "engagement.loyalty.GET");
  }
}

export async function PATCH(req: NextRequest) {
  const scope = await engScope("crm", true);
  if (isResponse(scope)) return scope;
  const limited = await writeLimit(scope, "loyalty");
  if (limited) return limited;
  const blocked = await gate(scope, "loyalty");
  if (blocked) return blocked;
  const b = await body(req, ProgramPatchSchema);
  if (!b.ok) return b.res;
  try {
    const program = await updateProgram(scope.dataId, b.data);
    await recordAudit(scope, { action: "loyalty.update", entity: "loyalty_program", entityId: scope.dataId, after: b.data });
    return NextResponse.json({ program });
  } catch (err) {
    return fail(err, "engagement.loyalty.PATCH");
  }
}
