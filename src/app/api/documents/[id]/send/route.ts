import { NextResponse, type NextRequest } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { rateLimitAsync } from "@/lib/request-limits";
import { errorResponse, paramId, parseBody } from "@/lib/money/http";
import { sendForSignature } from "@/lib/documents/signing";
import { DocumentSendSchema } from "@/lib/documents/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/documents/[id]/send — freeze, fingerprint and email the signers whose turn it is. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  let scope;
  try {
    scope = await requireScope({ area: "crm", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!(await rateLimitAsync(`documents:send:${scope.dataId}`, 60, 60_000)).allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  const body = await parseBody(req, DocumentSendSchema, 8_192);
  if (!body.ok) return body.res;
  try {
    const out = await sendForSignature(scope.dataId, await paramId(ctx), body.data, scope.userId);
    return NextResponse.json(out);
  } catch (err) {
    return errorResponse(err, "documents.id.send");
  }
}
