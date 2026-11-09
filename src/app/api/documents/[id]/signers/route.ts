import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { errorResponse, paramId, parseBody } from "@/lib/money/http";
import { getDocument, listSignersWithEvidence, replaceSigners, signerToDto } from "@/lib/documents/documents";
import { SignerInputSchema } from "@/lib/documents/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/documents/[id]/signers — signers incl. evidence (IP / UA / consent) for the audit view. */
export async function GET(_req: NextRequest, ctx: Ctx) {
  let scope;
  try {
    scope = await requireScope({ area: "crm" });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const id = await paramId(ctx);
    const doc = await getDocument(scope.dataId, id);
    if (!doc) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const rows = await listSignersWithEvidence(id);
    return NextResponse.json({ signers: rows.map((r) => ({ ...signerToDto(r), ip: r.ip, user_agent: r.user_agent, consent_text: r.consent_text })) });
  } catch (err) {
    return errorResponse(err, "documents.id.signers.GET");
  }
}

const Body = z.object({ signers: z.array(SignerInputSchema).min(1).max(10) }).strict();

/** PUT /api/documents/[id]/signers — replace the signer list (drafts only). */
export async function PUT(req: NextRequest, ctx: Ctx) {
  let scope;
  try {
    scope = await requireScope({ area: "crm", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await parseBody(req, Body, 16_384);
  if (!body.ok) return body.res;
  try {
    const id = await paramId(ctx);
    const doc = await getDocument(scope.dataId, id);
    if (!doc) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (doc.status !== "draft") return NextResponse.json({ error: "bad_request", detail: "Signers can only be changed on drafts" }, { status: 400 });
    await replaceSigners(scope.dataId, id, body.data.signers);
    return NextResponse.json({ document: await getDocument(scope.dataId, id) });
  } catch (err) {
    return errorResponse(err, "documents.id.signers.PUT");
  }
}
