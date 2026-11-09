import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope } from "@/lib/auth/scope";
import { FxRateInputSchema, deleteFxRate, listFxRates, upsertFxRate } from "@/lib/money/fx";
import { errorResponse, parseBody } from "@/lib/money/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const scope = await requireScope({ area: "billing" });
    return NextResponse.json({ rates: await listFxRates(scope.dataId) });
  } catch (err) {
    return errorResponse(err, "fx-rates.GET");
  }
}

/** POST /api/fx-rates — add a dated rate (1 base = rate quote). Newest rate per pair wins. */
export async function POST(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const body = await parseBody(req, FxRateInputSchema, 4_000);
    if (!body.ok) return body.res;
    const rate = await upsertFxRate(scope.dataId, body.data);
    return NextResponse.json({ rate }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "fx-rates.POST");
  }
}

const DeleteBody = z.object({ id: z.string().min(1).max(100) }).strict();

export async function DELETE(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const fromQuery = req.nextUrl.searchParams.get("id");
    let id = fromQuery;
    if (!id) {
      const body = await parseBody(req, DeleteBody, 2_000);
      if (!body.ok) return body.res;
      id = body.data.id;
    }
    const ok = await deleteFxRate(scope.dataId, id);
    if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "fx-rates.DELETE");
  }
}
