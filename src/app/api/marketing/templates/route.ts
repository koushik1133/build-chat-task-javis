import { NextResponse, type NextRequest } from "next/server";
import { parseBody } from "@/lib/money/http";
import { recordAudit } from "@/lib/audit";
import { tableExists } from "@/lib/table-exists";
import { createTemplate, listTemplates } from "@/lib/marketing/templates";
import { marketingError, marketingScope } from "@/lib/marketing/http";
import { TemplateCreateSchema } from "@/lib/marketing/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const s = await marketingScope(false);
  if (!s.ok) return s.res;
  try {
    const migrated = await tableExists("email_templates");
    const templates = migrated ? await listTemplates(s.scope.dataId, { category: req.nextUrl.searchParams.get("category") }) : [];
    return NextResponse.json({ templates, migrated });
  } catch (err) {
    return marketingError(err, "marketing/templates.list");
  }
}

export async function POST(req: NextRequest) {
  const s = await marketingScope(true);
  if (!s.ok) return s.res;
  const body = await parseBody(req, TemplateCreateSchema, 80_000);
  if (!body.ok) return body.res;
  try {
    const template = await createTemplate(s.scope.dataId, body.data);
    await recordAudit(s.scope, { action: "marketing.template.created", entity: "email_template", entityId: template.id, after: { summary: template.name } });
    return NextResponse.json({ template }, { status: 201 });
  } catch (err) {
    return marketingError(err, "marketing/templates.create");
  }
}
