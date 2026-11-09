import { listConnectedForUser } from "@/lib/accounting/connections";
import { pushEntity } from "@/lib/accounting/sync";
import { ROUTES } from "@/lib/public-api/registry";
import { ApiError } from "@/lib/public-api/envelope";
import { op, singlePage } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = op(ROUTES.pushAccounting, async ({ principal, body }) => {
  const conns = (await listConnectedForUser(principal.dataId)).filter((c) => !body.connection_id || c.id === body.connection_id);
  if (conns.length === 0) throw new ApiError(422, "unprocessable", body.connection_id ? "That accounting connection is not available" : "No accounting system is connected");
  const out = [];
  for (const c of conns) {
    const r = await pushEntity(c.id, body.kind, body.id, { force: body.force ?? false });
    out.push({ connection_id: c.id, provider: c.provider, kind: r.kind, id: r.id, status: r.status, remote_id: r.remoteId ?? null, message: r.message ?? null });
  }
  return singlePage(out);
});
