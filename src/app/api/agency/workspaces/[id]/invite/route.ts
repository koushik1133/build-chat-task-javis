import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { ROLES, canManageRole } from "@/lib/auth/roles";
import { dbUnavailableResponse } from "@/lib/api-db";
import { recordAudit } from "@/lib/audit";
import { paramId, parseBody } from "@/lib/money/http";
import { rateLimitAsync } from "@/lib/request-limits";
import { getChildOrg, inviteClientUser } from "@/lib/agency/orgs";
import { AlreadyMemberError } from "@/lib/team";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

const Body = z
  .object({
    email: z.string().trim().email().max(254),
    role: z.enum(ROLES.filter((r) => r !== "owner") as [Exclude<(typeof ROLES)[number], "owner">, ...Array<Exclude<(typeof ROLES)[number], "owner">>]),
    message: z.string().trim().max(1000).optional(),
  })
  .strict();

/** POST /api/agency/workspaces/:id/invite {email, role, message?} — invite a client user; emails via the outbox. */
export async function POST(req: NextRequest, ctx: Ctx) {
  let scope;
  try {
    scope = await requireScope({ area: "settings", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const limit = await rateLimitAsync(`agency-invite:${scope.userId}`, 30, 60 * 60 * 1000);
  if (!limit.allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  const parsed = await parseBody(req, Body, 8_192);
  if (!parsed.ok) return parsed.res;
  if (!canManageRole(scope.role, parsed.data.role)) {
    return NextResponse.json({ error: "forbidden", detail: "You cannot assign that role." }, { status: 403 });
  }
  try {
    const id = await paramId(ctx);
    const client = await getChildOrg(scope.dataId, id);
    if (!client) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (client.archived) return NextResponse.json({ error: "bad_request", detail: "This workspace is archived." }, { status: 400 });
    const invite = await inviteClientUser(client.id, parsed.data.email, parsed.data.role, {
      invitedBy: scope.userId,
      origin: new URL(req.url).origin,
      message: parsed.data.message,
    });
    void recordAudit(scope, { action: "invite", entity: "client_workspace", entityId: id, after: { email: invite.email, role: invite.role }, req }).catch(() => undefined);
    return NextResponse.json({ inviteUrl: invite.inviteUrl, email: invite.email, role: invite.role, reissued: invite.reissued }, { status: 201 });
  } catch (err) {
    if (err instanceof AlreadyMemberError) return NextResponse.json({ error: "conflict", detail: "Already a member of this workspace." }, { status: 409 });
    return dbUnavailableResponse(err, "agency/workspaces/invite");
  }
}
