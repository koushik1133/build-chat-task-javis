import { NextResponse, type NextRequest } from "next/server";
import { parseBody, paramId } from "@/lib/money/http";
import { recordAudit } from "@/lib/audit";
import { deleteAudience, getAudience, updateAudience } from "@/lib/marketing/audiences";
import { marketingError, marketingScope } from "@/lib/marketing/http";
import { AudiencePatchSchema } from "@/lib/marketing/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const s = await marketingScope(false);
  if (!s.ok) return s.res;
  try {
    const audience = await getAudience(s.scope.dataId, await paramId(ctx));
    if (!audience) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ audience });
  } catch (err) {
    return marketingError(err, "marketing/audiences.get");
  }
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const s = await marketingScope(true);
  if (!s.ok) return s.res;
  const body = await parseBody(req, AudiencePatchSchema, 32_000);
  if (!body.ok) return body.res;
  try {
    const audience = await updateAudience(s.scope.dataId, await paramId(ctx), body.data);
    if (!audience) return NextResponse.json({ error: "not_found" }, { status: 404 });
    await recordAudit(s.scope, { action: "marketing.audience.updated", entity: "audience", entityId: audience.id, after: { summary: audience.name } });
    return NextResponse.json({ audience });
  } catch (err) {
    return marketingError(err, "marketing/audiences.update");
  }
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const s = await marketingScope(true);
  if (!s.ok) return s.res;
  try {
    const id = await paramId(ctx);
    const ok = await deleteAudience(s.scope.dataId, id);
    if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
    await recordAudit(s.scope, { action: "marketing.audience.deleted", entity: "audience", entityId: id });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return marketingError(err, "marketing/audiences.delete");
  }
}
