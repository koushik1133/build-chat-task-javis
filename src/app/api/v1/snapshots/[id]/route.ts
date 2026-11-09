import { getSnapshotMeta } from "@/lib/snapshots/store";
import { ROUTES } from "@/lib/public-api/registry";
import { op, mustFind } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.getSnapshot, async ({ principal, params }) => ({ data: mustFind(await getSnapshotMeta(principal.dataId, params.id), "Snapshot") }));
