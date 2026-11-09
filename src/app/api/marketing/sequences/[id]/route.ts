import { NextResponse, type NextRequest } from "next/server";
import { parseBody, paramId } from "@/lib/money/http";
import { recordAudit } from "@/lib/audit";
import { deleteSequence, getSequence, updateSequence } from "@/lib/marketing/sequences";
import { marketingError, marketingScope } from "@/lib/marketing/http";
import { SequencePatchSchema } from "@/lib/marketing/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const s = await marketingScope(false);
  if (!s.ok) return s.res;
  try {
    const sequence = await getSequence(s.scope.dataId, await paramId(ctx));
    if (!sequence) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ sequence });
  } catch (err) {
    return marketingError(err, "marketing/sequences.get");
  }
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const s = await marketingScope(true);
  if (!s.ok) return s.res;
  const body = await parseBody(req, SequencePatchSchema, 200_000);
  if (!body.ok) return body.res;
  try {
    const sequence = await updateSequence(s.scope.dataId, await paramId(ctx), body.data);
    if (!sequence) return NextResponse.json({ error: "not_found" }, { status: 404 });
    await recordAudit(s.scope, { action: "marketing.sequence.updated", entity: "sequence", entityId: sequence.id, after: { summary: sequence.name } });
    return NextResponse.json({ sequence });
  } catch (err) {
    return marketingError(err, "marketing/sequences.update");
  }
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const s = await marketingScope(true);
  if (!s.ok) return s.res;
  try {
    const id = await paramId(ctx);
    const ok = await deleteSequence(s.scope.dataId, id);
    if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
    await recordAudit(s.scope, { action: "marketing.sequence.deleted", entity: "sequence", entityId: id });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return marketingError(err, "marketing/sequences.delete");
  }
}
