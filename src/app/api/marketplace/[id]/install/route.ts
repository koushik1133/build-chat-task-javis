import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { installListing } from "@/lib/marketplace/install";
import { errorResponse, paramId } from "@/lib/money/http";

export const runtime = "nodejs";

/** Install into the caller's org. Idempotent per listing version. */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const scope = await requireScope({ area: "agents", edit: true });
    const id = decodeURIComponent(await paramId(ctx));
    const out = await installListing(scope.dataId, id);
    return NextResponse.json({ install: { created: out.created, entityKind: out.entityKind, entityId: out.entityId, note: out.note }, listing: out.listing }, { status: out.created ? 201 : 200 });
  } catch (err) {
    return errorResponse(err, "marketplace.id.install.POST");
  }
}
