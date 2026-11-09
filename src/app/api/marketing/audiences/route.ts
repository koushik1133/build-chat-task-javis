import { NextResponse, type NextRequest } from "next/server";
import { parseBody } from "@/lib/money/http";
import { recordAudit } from "@/lib/audit";
import { normaliseCursor, page, parseListParams } from "@/lib/public-api/pagination";
import { tableExists } from "@/lib/table-exists";
import { createAudience, listAudiences } from "@/lib/marketing/audiences";
import { marketingError, marketingScope } from "@/lib/marketing/http";
import { AudienceCreateSchema } from "@/lib/marketing/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/marketing/audiences?cursor=&limit= — keyset-paginated, newest first. */
export async function GET(req: NextRequest) {
  const s = await marketingScope(false);
  if (!s.ok) return s.res;
  try {
    const list = parseListParams(req.nextUrl, { limit: 200 });
    if (list.badCursor) return NextResponse.json({ error: "invalid cursor" }, { status: 400 });
    const migrated = await tableExists("audiences");
    const rows = migrated ? await listAudiences(s.scope.dataId, { cursor: list.cursor, limit: list.limit + 1 }) : [];
    const pg = page(rows, list.limit, (r) => normaliseCursor(r));
    return NextResponse.json({ audiences: pg.data, next_cursor: pg.next_cursor, migrated });
  } catch (err) {
    return marketingError(err, "marketing/audiences.list");
  }
}

export async function POST(req: NextRequest) {
  const s = await marketingScope(true);
  if (!s.ok) return s.res;
  const body = await parseBody(req, AudienceCreateSchema, 32_000);
  if (!body.ok) return body.res;
  try {
    const audience = await createAudience(s.scope.dataId, body.data);
    await recordAudit(s.scope, { action: "marketing.audience.created", entity: "audience", entityId: audience.id, after: { summary: audience.name } });
    return NextResponse.json({ audience }, { status: 201 });
  } catch (err) {
    return marketingError(err, "marketing/audiences.create");
  }
}
