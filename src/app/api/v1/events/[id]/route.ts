import { queryOne } from "@/lib/dsql";
import { ROUTES } from "@/lib/public-api/registry";
import { op, mustFind } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface EventRow { id: string; type: string; entity: string; entity_id: string; data: string | null; created_at: string | Date }

export const GET = op(ROUTES.getEvent, async ({ principal, params }) => {
  const r = mustFind(await queryOne<EventRow>(`SELECT id, type, entity, entity_id, data, created_at FROM events WHERE id = $1 AND user_id = $2`, [params.id, principal.dataId]), "Event");
  let data: Record<string, unknown> = {};
  try { const v: unknown = JSON.parse(r.data ?? "{}"); if (v && typeof v === "object" && !Array.isArray(v)) data = v as Record<string, unknown>; } catch { data = {}; }
  return { data: { id: r.id, type: r.type, entity: r.entity, entity_id: r.entity_id, data, created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at) } };
});
