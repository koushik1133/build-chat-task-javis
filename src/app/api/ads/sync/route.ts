import { NextResponse } from "next/server";
import { z } from "zod";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { syncAllForUser, defaultRange } from "@/lib/ads/sync";

export const runtime = "nodejs";
export const maxDuration = 60;

const BodySchema = z.object({
  days: z.number().int().min(1).max(90).optional(),
});

/** POST /api/ads/sync — refresh every connected ad account for the caller. */
export async function POST(req: Request) {
  let scope;
  try { scope = await requireScope({ area: "ads", edit: true }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  const raw = await req.json().catch(() => ({}));
  const parsed = BodySchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: "days must be between 1 and 90" }, { status: 400 });
  }

  const { since, until } = defaultRange(parsed.data.days ?? 30);
  const results = await syncAllForUser(scope.dataId, since, until);

  const synced = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);

  return NextResponse.json({
    since,
    until,
    synced,
    rows: results.reduce((sum, r) => sum + r.rows, 0),
    failed: failed.map((f) => ({ accountId: f.accountId, platform: f.platform, error: f.error })),
  });
}
