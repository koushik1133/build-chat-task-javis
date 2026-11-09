import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { installListing } from "@/lib/marketplace/install";
import { errorResponse, paramId } from "@/lib/money/http";
import { recordAudit } from "@/lib/audit";

export const runtime = "nodejs";

/** Install into the caller's org. Idempotent per listing version. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const scope = await requireScope({ area: "agents", edit: true });
    const id = decodeURIComponent(await paramId(ctx));
    const out = await installListing(scope.dataId, id);
    if (out.created) await recordAudit(scope, { action: "create", entity: "marketplace_install", entityId: id, after: { kind: out.entityKind }, req });
    return NextResponse.json({ install: { created: out.created, entityKind: out.entityKind, entityId: out.entityId, note: out.note }, listing: out.listing }, { status: out.created ? 201 : 200 });
  } catch (err) {
    return errorResponse(err, "marketplace.id.install.POST");
  }
}
