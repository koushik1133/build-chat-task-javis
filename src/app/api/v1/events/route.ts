import { query as sql } from "@/lib/dsql";
import { ROUTES } from "@/lib/public-api/registry";
import { ApiError } from "@/lib/public-api/envelope";
import { op } from "@/lib/public-api/handler";
import { keysetClause, page } from "@/lib/public-api/pagination";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface EventRow {
  id: string;
  type: string;
  entity: string;
  entity_id: string;
  data: string | null;
  created_at: string | Date;
}

function parseData(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export const GET = op(ROUTES.listEvents, async ({ principal, query, list }) => {
  const params: unknown[] = [principal.dataId];
  let where = `user_id = $1`;
  if (query.type) {
    params.push(query.type);
    where += ` AND type = $${params.length}`;
  }
  if (query.since) {
    const d = new Date(query.since);
    if (Number.isNaN(d.getTime())) throw ApiError.validation([{ in: "query", path: "since", message: "must be an ISO-8601 date" }]);
    params.push(d.toISOString());
    where += ` AND created_at > $${params.length}`;
  }
  where += keysetClause(list.cursor, params);
  params.push(list.limit + 1);
  const rows = await sql<EventRow>(
    `SELECT id, type, entity, entity_id, data, created_at FROM events WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
    params
  );
  const p = page(rows, list.limit, (r) => ({ created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at), id: r.id }));
  return {
    data: p.data.map((r) => ({ id: r.id, type: r.type, entity: r.entity, entity_id: r.entity_id, data: parseData(r.data), created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at) })),
    meta: { next_cursor: p.next_cursor },
  };
});
