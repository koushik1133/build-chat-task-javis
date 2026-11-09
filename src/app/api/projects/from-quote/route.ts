import { NextResponse, type NextRequest } from "next/server";
import { recordAudit } from "@/lib/audit";
import { parseBody } from "@/lib/money/http";
import { createProjectFromQuote } from "@/lib/projects/convert";
import { projectError, projectScope } from "@/lib/projects/http";
import { FromQuoteSchema } from "@/lib/projects/pure";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/projects/from-quote {quoteId, name?, milestonesFromItems?, starts_on?, due_on?} */
export async function POST(req: NextRequest) {
  const s = await projectScope(req, true);
  if (!s.ok) return s.res;
  const parsed = await parseBody(req, FromQuoteSchema, 8_192);
  if (!parsed.ok) return parsed.res;
  try {
    const out = await createProjectFromQuote(s.scope.dataId, parsed.data, s.scope.userId);
    void recordAudit(s.scope, { action: "create", entity: "project", entityId: out.project.id, after: { from_quote: parsed.data.quoteId, milestones: out.milestones.length }, req }).catch(() => undefined);
    return NextResponse.json(out, { status: 201 });
  } catch (err) {
    return projectError(err, "projects.from_quote");
  }
}
