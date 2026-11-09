import { NextRequest, NextResponse } from "next/server";
import { recordAudit } from "@/lib/audit";
import { body, engScope, fail, isResponse, limitParam, writeLimit } from "@/lib/engagement/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
import { createVoucher, listVouchers } from "@/lib/engagement/vouchers";
import { VoucherInputSchema } from "@/lib/engagement/pure";

export async function GET(req: NextRequest) {
  const scope = await engScope("billing", false);
  if (isResponse(scope)) return scope;
  try {
    return NextResponse.json({ vouchers: await listVouchers(scope.dataId, { q: req.nextUrl.searchParams.get("q"), limit: limitParam(req, 100) }) });
  } catch (err) {
    return fail(err, "engagement.vouchers.GET");
  }
}

export async function POST(req: NextRequest) {
  const scope = await engScope("billing", true);
  if (isResponse(scope)) return scope;
  const limited = await writeLimit(scope, "vouchers");
  if (limited) return limited;
  const b = await body(req, VoucherInputSchema);
  if (!b.ok) return b.res;
  try {
    const v = await createVoucher(scope.dataId, b.data);
    await recordAudit(scope, { action: "voucher.create", entity: "voucher", entityId: v.id, after: { code: v.code_upper, kind: v.kind, value: v.value } });
    return NextResponse.json({ voucher: v }, { status: 201 });
  } catch (err) {
    return fail(err, "engagement.vouchers.POST");
  }
}
