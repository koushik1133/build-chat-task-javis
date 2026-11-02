import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { getPack, installPack, listPacks } from "@/lib/records/packs";
import { InstallPackSchema, parseBody, recordsErrorResponse } from "@/lib/records/http";

export const runtime = "nodejs";

export async function GET() {
  try {
    const scope = await requireScope({ area: "crm" });
    const packs = await listPacks(scope.dataId);
    return NextResponse.json({ packs });
  } catch (err) {
    return recordsErrorResponse(err, "records.packs.GET");
  }
}

export async function POST(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "crm", edit: true });
    const body = await parseBody(req, InstallPackSchema);
    if (!body.ok) return body.res;
    if (!getPack(body.data.slug)) return NextResponse.json({ error: "not_found", detail: "Pack not found" }, { status: 404 });
    const types = await installPack(scope.dataId, body.data.slug);
    return NextResponse.json({ types }, { status: 201 });
  } catch (err) {
    return recordsErrorResponse(err, "records.packs.POST");
  }
}
