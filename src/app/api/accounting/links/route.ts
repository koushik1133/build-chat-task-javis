import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { listLinks } from "@/lib/accounting/connections";
import { ACCOUNTING_ENTITY_KINDS } from "@/lib/accounting/types";
import { tableExists } from "@/lib/table-exists";
import { billingScope, isResponse } from "../_shared";

export const dynamic = "force-dynamic";

const Query = z.object({ kind: z.enum(ACCOUNTING_ENTITY_KINDS), connection_id: z.string().trim().min(1).max(100).optional(), limit: z.coerce.number().int().min(1).max(2000).optional() });

/** Sync state per entity for list pills: { links: [{ entity_id, state, ... }] }. */
export async function GET(req: NextRequest) {
  const scope = await billingScope(false);
  if (isResponse(scope)) return scope;
  const q = Query.safeParse(Object.fromEntries([...req.nextUrl.searchParams.entries()].filter(([, v]) => v !== "")));
  if (!q.success) return NextResponse.json({ error: "Invalid query", detail: q.error.flatten() }, { status: 400 });
  if (!(await tableExists("accounting_links"))) return NextResponse.json({ links: [], migrated: false });
  const links = await listLinks(scope.dataId, q.data.kind, { connectionId: q.data.connection_id, limit: q.data.limit });
  return NextResponse.json({ links, migrated: true });
}
