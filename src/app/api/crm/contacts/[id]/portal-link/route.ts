import { NextRequest, NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { queryOne } from "@/lib/dsql";
import { appOrigin, issueShareToken } from "@/lib/share-tokens";

export const runtime = "nodejs";

/** POST /api/crm/contacts/[id]/portal-link → { url, path, expiresAt } (14-day portal token). */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const scope = await requireScope({ area: "crm", edit: true });
    const { id } = await ctx.params;
    const contact = await queryOne<{ id: string }>(`SELECT id FROM crm_contacts WHERE user_id = $1 AND id = $2`, [scope.dataId, id]);
    if (!contact) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const issued = await issueShareToken(scope.dataId, "portal", id, 14);
    const path = `/p/c/${issued.token}`;
    return NextResponse.json({ url: `${appOrigin()}${path}`, path, expiresAt: issued.expiresAt });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
