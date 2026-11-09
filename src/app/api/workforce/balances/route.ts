import { NextResponse, type NextRequest } from "next/server";
import { recordAudit } from "@/lib/audit";
import { parseBody } from "@/lib/money/http";
import { workforceError, workforceScope } from "@/lib/workforce/http";
import { BalanceUpsertSchema, listBalances, upsertBalance } from "@/lib/workforce/leave";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/workforce/balances?year=&staff_id= */
export async function GET(req: NextRequest) {
  const s = await workforceScope(req, false);
  if (!s.ok) return s.res;
  const q = req.nextUrl.searchParams;
  try {
    const year = Number(q.get("year")) || null;
    const balances = await listBalances(s.scope.dataId, { year, staffId: q.get("staff_id") });
    return NextResponse.json({ balances });
  } catch (err) {
    return workforceError(err, "workforce.balances.list");
  }
}

/** PUT /api/workforce/balances {staff_id, kind, year, allotted_hours} — upsert an allotment. */
export async function PUT(req: NextRequest) {
  const s = await workforceScope(req, true);
  if (!s.ok) return s.res;
  const parsed = await parseBody(req, BalanceUpsertSchema, 2_048);
  if (!parsed.ok) return parsed.res;
  try {
    const balance = await upsertBalance(s.scope.dataId, parsed.data);
    void recordAudit(s.scope, { action: "upsert", entity: "leave_balance", entityId: `${parsed.data.staff_id}:${parsed.data.kind}:${parsed.data.year}`, after: parsed.data, req }).catch(() => undefined);
    return NextResponse.json({ balance });
  } catch (err) {
    return workforceError(err, "workforce.balances.upsert");
  }
}
