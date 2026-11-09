import { NextResponse, type NextRequest } from "next/server";
import { paramId } from "@/lib/money/http";
import { decodeCursor, encodeCursor } from "@/lib/public-api/pagination";
import { getCampaign, listRecipients } from "@/lib/marketing/campaigns";
import { marketingError, marketingScope } from "@/lib/marketing/http";
import { RecipientListQuerySchema } from "@/lib/marketing/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET ?status=&cursor=&limit= — keyset-paginated recipients with contact names. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = await marketingScope(false);
  if (!s.ok) return s.res;
  const q = RecipientListQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!q.success) return NextResponse.json({ error: "invalid_query", detail: q.error.flatten() }, { status: 400 });
  try {
    const id = await paramId(ctx);
    if (!(await getCampaign(s.scope.dataId, id))) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const limit = q.data.limit ?? 50;
    const rows = await listRecipients(s.scope.dataId, id, { status: q.data.status ?? null, limit: limit + 1, cursor: decodeCursor(q.data.cursor) });
    const pageRows = rows.slice(0, limit);
    const last = pageRows[pageRows.length - 1];
    return NextResponse.json({ recipients: pageRows, next_cursor: rows.length > limit && last ? encodeCursor({ created_at: last.created_at, id: last.id }) : null });
  } catch (err) {
    return marketingError(err, "marketing/campaigns.recipients");
  }
}
