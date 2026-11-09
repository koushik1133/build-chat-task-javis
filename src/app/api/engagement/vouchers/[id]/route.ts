import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { recordAudit } from "@/lib/audit";
import { body, engScope, fail, isResponse, writeLimit } from "@/lib/engagement/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
import { getVoucher, updateVoucher } from "@/lib/engagement/vouchers";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const scope = await engScope("billing", false);
  if (isResponse(scope)) return scope;
  const v = await getVoucher(scope.dataId, (await ctx.params).id);
  return v ? NextResponse.json({ voucher: v }) : NextResponse.json({ error: "not_found" }, { status: 404 });
}

const Patch = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    min_subtotal_minor: z.number().int().min(0).max(1_000_000_000_000).optional(),
    max_uses: z.number().int().min(1).max(10_000_000).nullable().optional(),
    per_contact_limit: z.number().int().min(1).max(10_000).nullable().optional(),
    starts_at: z.string().datetime({ offset: true }).nullable().optional(),
    ends_at: z.string().datetime({ offset: true }).nullable().optional(),
    stackable: z.boolean().optional(),
    active: z.boolean().optional(),
  })
  .strict();

/** Value, kind and code are immutable once issued (redemptions reference them); everything else can change. */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const scope = await engScope("billing", true);
  if (isResponse(scope)) return scope;
  const limited = await writeLimit(scope, "vouchers");
  if (limited) return limited;
  const b = await body(req, Patch);
  if (!b.ok) return b.res;
  try {
    const id = (await ctx.params).id;
    const v = await updateVoucher(scope.dataId, id, b.data);
    await recordAudit(scope, { action: "voucher.update", entity: "voucher", entityId: id, after: b.data });
    return NextResponse.json({ voucher: v });
  } catch (err) {
    return fail(err, "engagement.vouchers.PATCH");
  }
}
