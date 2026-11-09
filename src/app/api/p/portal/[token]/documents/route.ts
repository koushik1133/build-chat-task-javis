import { NextResponse, type NextRequest } from "next/server";
import { rateLimitAsync } from "@/lib/request-limits";
import { resolveShareToken } from "@/lib/share-tokens";
import { listDocuments } from "@/lib/documents/documents";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ token: string }> };

function ip(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "anon";
}

/** GET /api/p/portal/[token]/documents — the contact's sent/signed documents (whitelisted fields; drafts hidden). */
export async function GET(req: NextRequest, ctx: Ctx) {
  if (!(await rateLimitAsync(`portal:docs:${ip(req)}`, 60, 60_000)).allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  try {
    const { token } = await ctx.params;
    const t = await resolveShareToken("portal", token);
    if (!t) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const docs = await listDocuments(t.user_id, { contactId: t.entity_id, limit: 100 }).catch(() => []);
    const documents = docs
      .filter((d) => d.status !== "draft" && d.status !== "void")
      .map((d) => ({
        id: d.id,
        title: d.title,
        kind: d.kind,
        status: d.status,
        sent_at: d.sent_at,
        completed_at: d.completed_at,
        expires_at: d.expires_at,
        pending_signers: d.signers.filter((s) => s.status !== "signed" && s.status !== "declined").map((s) => s.name),
      }));
    return NextResponse.json({ documents });
  } catch (err) {
    console.error("[portal] documents failed:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
