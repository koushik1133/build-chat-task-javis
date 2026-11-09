import { NextResponse, type NextRequest } from "next/server";
import { parseBody } from "@/lib/money/http";
import { recordAudit } from "@/lib/audit";
import { normaliseCursor, page, parseListParams } from "@/lib/public-api/pagination";
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
    const list = parseListParams(req.nextUrl, { limit: 200 });
    if (list.badCursor) return NextResponse.json({ error: "invalid cursor" }, { status: 400 });
    const rows = migrated ? await listTemplates(s.scope.dataId, { category: req.nextUrl.searchParams.get("category"), cursor: list.cursor, limit: list.limit + 1 }) : [];
    const pg = page(rows, list.limit, (r) => normaliseCursor(r));
    return NextResponse.json({ templates: pg.data, next_cursor: pg.next_cursor, migrated });
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
