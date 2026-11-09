import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope } from "@/lib/auth/scope";
import { draftArticleFromTickets } from "@/lib/kb/articles";
import { llmNotConfiguredResponse } from "@/lib/llm-response";
import { errorResponse, parseBody } from "@/lib/money/http";
import { rateLimitAsync } from "@/lib/request-limits";

export const runtime = "nodejs";
export const maxDuration = 60;

const DraftSchema = z.object({ ticketIds: z.array(z.string().min(1).max(100)).min(1).max(10) }).strict();

/** POST /api/kb/draft — { ticketIds } → { draft: { title, body_md, excerpt, tags, source_ticket_ids } } */
export async function POST(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "knowledge", edit: true });
    if (!(await rateLimitAsync(`kb-draft:${scope.dataId}`, 20, 60 * 60 * 1000)).allowed) {
      return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    }
    const body = await parseBody(req, DraftSchema);
    if (!body.ok) return body.res;
    const draft = await draftArticleFromTickets(scope.dataId, body.data.ticketIds);
    return NextResponse.json({ draft });
  } catch (err) {
    const mapped = llmNotConfiguredResponse(err);
    if (mapped) return mapped;
    return errorResponse(err, "kb.draft.POST");
  }
}
