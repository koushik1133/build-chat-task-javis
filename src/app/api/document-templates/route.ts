import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { errorResponse, parseBody } from "@/lib/money/http";
import { createTemplate, installStarters, listTemplates, STARTER_TEMPLATES } from "@/lib/documents/templates";
import { TemplateCreateSchema } from "@/lib/documents/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Install = z.object({ install: z.union([z.literal("starters"), z.array(z.string().max(60)).max(20)]) }).strict();

/** GET /api/document-templates — org templates + the installable starters catalogue. */
export async function GET() {
  let scope;
  try {
    scope = await requireScope({ area: "crm" });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const templates = await listTemplates(scope.dataId);
    const installed = new Set(templates.map((t) => t.starter_slug).filter(Boolean));
    return NextResponse.json({
      templates,
      starters: STARTER_TEMPLATES.map((s) => ({ slug: s.slug, name: s.name, kind: s.kind, description: s.description, installed: installed.has(s.slug) })),
      canEdit: scope.can("crm", true),
    });
  } catch (err) {
    return errorResponse(err, "document-templates.GET");
  }
}

/** POST /api/document-templates — create, or `{ install: "starters" | [slugs] }`. */
export async function POST(req: NextRequest) {
  let scope;
  try {
    scope = await requireScope({ area: "crm", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await parseBody(req, z.union([Install, TemplateCreateSchema]), 300_000);
  if (!body.ok) return body.res;
  try {
    if ("install" in body.data) {
      const out = await installStarters(scope.dataId, body.data.install === "starters" ? null : body.data.install, scope.userId);
      return NextResponse.json(out, { status: 201 });
    }
    const template = await createTemplate(scope.dataId, body.data, scope.userId);
    return NextResponse.json({ template }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "document-templates.POST");
  }
}
