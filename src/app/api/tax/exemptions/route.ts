import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { errorResponse, parseBody } from "@/lib/money/http";
import { ExemptionInputSchema, createExemption, deleteExemption, listExemptions } from "@/lib/tax-compliance/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "billing" });
    return NextResponse.json({ exemptions: await listExemptions(scope.dataId, req.nextUrl.searchParams.get("contact_id") ?? undefined) });
  } catch (err) {
    return errorResponse(err, "tax.exemptions.GET");
  }
}

export async function POST(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const body = await parseBody(req, ExemptionInputSchema, 4_000);
    if (!body.ok) return body.res;
    return NextResponse.json({ exemption: await createExemption(scope.dataId, body.data) }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "tax.exemptions.POST");
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const id = req.nextUrl.searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id_required" }, { status: 400 });
    const ok = await deleteExemption(scope.dataId, id);
    return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "not_found" }, { status: 404 });
  } catch (err) {
    return errorResponse(err, "tax.exemptions.DELETE");
  }
}
