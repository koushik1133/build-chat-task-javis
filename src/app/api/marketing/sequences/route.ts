import { NextResponse, type NextRequest } from "next/server";
import { parseBody } from "@/lib/money/http";
import { recordAudit } from "@/lib/audit";
import { normaliseCursor, page, parseListParams } from "@/lib/public-api/pagination";
import { tableExists } from "@/lib/table-exists";
import { createSequence, listSequences } from "@/lib/marketing/sequences";
import { marketingError, marketingScope } from "@/lib/marketing/http";
import { SequenceCreateSchema } from "@/lib/marketing/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/marketing/sequences?cursor=&limit= — keyset-paginated; each row includes `audience_name` for audience_join triggers. */
export async function GET(req: NextRequest) {
  const s = await marketingScope(false);
  if (!s.ok) return s.res;
  try {
    const list = parseListParams(req.nextUrl, { limit: 200 });
    if (list.badCursor) return NextResponse.json({ error: "invalid cursor" }, { status: 400 });
    const migrated = await tableExists("sequences");
    const rows = migrated ? await listSequences(s.scope.dataId, { cursor: list.cursor, limit: list.limit + 1 }) : [];
    const pg = page(rows, list.limit, (r) => normaliseCursor(r));
    return NextResponse.json({ sequences: pg.data, next_cursor: pg.next_cursor, migrated });
  } catch (err) {
    return marketingError(err, "marketing/sequences.list");
  }
}

export async function POST(req: NextRequest) {
  const s = await marketingScope(true);
  if (!s.ok) return s.res;
  const body = await parseBody(req, SequenceCreateSchema, 200_000);
  if (!body.ok) return body.res;
  try {
    const sequence = await createSequence(s.scope.dataId, body.data);
    await recordAudit(s.scope, { action: "marketing.sequence.created", entity: "sequence", entityId: sequence.id, after: { summary: sequence.name } });
    return NextResponse.json({ sequence }, { status: 201 });
  } catch (err) {
    return marketingError(err, "marketing/sequences.create");
  }
}
