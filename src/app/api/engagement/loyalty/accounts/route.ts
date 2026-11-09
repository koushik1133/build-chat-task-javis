import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { recordAudit } from "@/lib/audit";
import { body, engScope, fail, gate, isResponse, limitParam, writeLimit } from "@/lib/engagement/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
import { adjustPoints, listAccounts } from "@/lib/engagement/loyalty";

export async function GET(req: NextRequest) {
  const scope = await engScope("crm", false);
  if (isResponse(scope)) return scope;
  try {
    return NextResponse.json({ accounts: await listAccounts(scope.dataId, { q: req.nextUrl.searchParams.get("q"), limit: limitParam(req) }) });
  } catch (err) {
    return fail(err, "engagement.loyalty.accounts.GET");
  }
}

const Adjust = z.object({ contact_id: z.string().min(1).max(100), points: z.number().int().min(-10_000_000).max(10_000_000), note: z.string().trim().min(1).max(200) }).strict();

export async function POST(req: NextRequest) {
  const scope = await engScope("crm", true);
  if (isResponse(scope)) return scope;
  const limited = await writeLimit(scope, "loyalty-adjust", 30);
  if (limited) return limited;
  const blocked = await gate(scope, "loyalty");
  if (blocked) return blocked;
  const b = await body(req, Adjust);
  if (!b.ok) return b.res;
  try {
    const res = await adjustPoints(scope.dataId, b.data.contact_id, b.data.points, b.data.note, scope.userId);
    await recordAudit(scope, { action: "loyalty.adjust", entity: "contact", entityId: b.data.contact_id, after: { points: b.data.points, note: b.data.note } });
    return NextResponse.json({ balance: res.balanceAfter }, { status: 201 });
  } catch (err) {
    return fail(err, "engagement.loyalty.accounts.POST");
  }
}
