import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { RecordTypeInputSchema } from "@/lib/records/schema";
import { createType, listTypes } from "@/lib/records/store";
import { parseBody, recordsErrorResponse } from "@/lib/records/http";

export const runtime = "nodejs";

export async function GET() {
  try {
    const scope = await requireScope({ area: "crm" });
    const types = await listTypes(scope.dataId);
    return NextResponse.json({ types });
  } catch (err) {
    return recordsErrorResponse(err, "records.types.GET");
  }
}

export async function POST(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "crm", edit: true });
    const body = await parseBody(req, RecordTypeInputSchema);
    if (!body.ok) return body.res;
    const type = await createType(scope.dataId, body.data);
    return NextResponse.json({ type }, { status: 201 });
  } catch (err) {
    return recordsErrorResponse(err, "records.types.POST");
  }
}
