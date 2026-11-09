import { NextResponse, type NextRequest } from "next/server";
import { parseBody, paramId } from "@/lib/money/http";
import { recordAudit } from "@/lib/audit";
import { deleteTemplate, getTemplate, updateTemplate } from "@/lib/marketing/templates";
import { marketingError, marketingScope } from "@/lib/marketing/http";
import { TemplatePatchSchema } from "@/lib/marketing/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const s = await marketingScope(false);
  if (!s.ok) return s.res;
  try {
    const template = await getTemplate(s.scope.dataId, await paramId(ctx));
    if (!template) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ template });
  } catch (err) {
    return marketingError(err, "marketing/templates.get");
  }
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const s = await marketingScope(true);
  if (!s.ok) return s.res;
  const body = await parseBody(req, TemplatePatchSchema, 80_000);
  if (!body.ok) return body.res;
  try {
    const template = await updateTemplate(s.scope.dataId, await paramId(ctx), body.data);
    if (!template) return NextResponse.json({ error: "not_found" }, { status: 404 });
    await recordAudit(s.scope, { action: "marketing.template.updated", entity: "email_template", entityId: template.id, after: { summary: template.name } });
    return NextResponse.json({ template });
  } catch (err) {
    return marketingError(err, "marketing/templates.update");
  }
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const s = await marketingScope(true);
  if (!s.ok) return s.res;
  try {
    const id = await paramId(ctx);
    const ok = await deleteTemplate(s.scope.dataId, id);
    if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
    await recordAudit(s.scope, { action: "marketing.template.deleted", entity: "email_template", entityId: id });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return marketingError(err, "marketing/templates.delete");
  }
}
