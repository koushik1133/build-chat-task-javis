import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { issueShareToken, revokeShareTokens } from "@/lib/share-tokens";

export const dynamic = "force-dynamic";

const Body = z.object({ calendar_id: z.string().min(1).max(100).optional(), rotate: z.boolean().optional() }).strict();

/** POST: issue (or rotate) the private ICS subscription link. The token is shown once. */
export async function POST(req: NextRequest) {
  let scope;
  try {
    scope = await requireScope({ area: "calendar", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const entity = parsed.data.calendar_id ? `cal:${scope.dataId}:${parsed.data.calendar_id}` : `org:${scope.dataId}`;
  if (parsed.data.rotate) await revokeShareTokens("calfeed", entity);
  const t = await issueShareToken(scope.dataId, "calfeed", entity, 3650);
  return NextResponse.json({ url: t.url, webcal: t.url.replace(/^https?:/, "webcal:") });
}
