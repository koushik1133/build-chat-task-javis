import { listSnapshots } from "@/lib/snapshots/store";
import { ROUTES } from "@/lib/public-api/registry";
import { op, singlePage } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.listSnapshots, async ({ principal, list }) => singlePage((await listSnapshots(principal.dataId)).slice(0, list.limit)));
