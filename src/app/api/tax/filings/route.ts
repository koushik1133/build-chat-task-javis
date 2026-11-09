import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope } from "@/lib/auth/scope";
import { errorResponse, parseBody } from "@/lib/money/http";
import { recordAudit } from "@/lib/audit";
import { listFilings, markFiled, voidFiling } from "@/lib/tax-compliance/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const scope = await requireScope({ area: "billing" });
    return NextResponse.json({ filings: await listFilings(scope.dataId) });
  } catch (err) {
    return errorResponse(err, "tax.filings.GET");
  }
}

const Patch = z.discriminatedUnion("action", [
  z.object({ id: z.string().max(100), action: z.literal("file"), filed_ref: z.string().trim().min(1).max(120) }).strict(),
  z.object({ id: z.string().max(100), action: z.literal("void") }).strict(),
]);

/** PATCH - manual "mark filed" (with the government reference) or void. KernelHub never files on your behalf. */
export async function PATCH(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const body = await parseBody(req, Patch, 2_000);
    if (!body.ok) return body.res;
    try {
      const filing = body.data.action === "file" ? await markFiled(scope.dataId, body.data.id, body.data.filed_ref) : await voidFiling(scope.dataId, body.data.id);
      await recordAudit(scope, { action: `tax.filing.${body.data.action}`, entity: "tax_filing", entityId: filing.id });
      return NextResponse.json({ filing });
    } catch (e) {
      if (e instanceof Error && /not found/i.test(e.message)) return NextResponse.json({ error: "not_found" }, { status: 404 });
      throw e;
    }
  } catch (err) {
    return errorResponse(err, "tax.filings.PATCH");
  }
}
