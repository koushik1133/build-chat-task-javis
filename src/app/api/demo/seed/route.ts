import { NextResponse } from "next/server";
import { z } from "zod";
import { dbUnavailableResponse } from "@/lib/api-db";
import { rateLimit } from "@/lib/request-limits";
import { requireDemoActor } from "@/lib/demo/auth";
import { seedDemoWorkspace, demoRowCount } from "@/lib/demo/seed";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.object({ industry: z.string().trim().min(1).max(40).optional(), currency: z.string().trim().length(3).optional() }).strict();

/** GET /api/demo/seed — is sample data loaded? */
export async function GET(req: Request) {
  const actor = await requireDemoActor(req);
  if (actor instanceof NextResponse) return actor;
  try {
    const rows = await demoRowCount(actor.dataId);
    return NextResponse.json({ active: rows > 0, rows });
  } catch (err) {
    return dbUnavailableResponse(err, "demo/seed");
  }
}

/** POST /api/demo/seed — load the sample workspace (owner/admin or API key). Idempotent. */
export async function POST(req: Request) {
  const actor = await requireDemoActor(req);
  if (actor instanceof NextResponse) return actor;
  const limit = rateLimit(`demo-seed:${actor.dataId}`, 5, 60 * 60 * 1000);
  if (!limit.allowed) return NextResponse.json({ error: "rate limited" }, { status: 429 });
  const raw = await req.text().catch(() => "");
  let json: unknown = {};
  if (raw.trim()) {
    try { json = JSON.parse(raw); } catch { return NextResponse.json({ error: "bad request" }, { status: 400 }); }
  }
  const parsed = Body.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: "bad request", issues: parsed.error.issues }, { status: 400 });
  try {
    const result = await seedDemoWorkspace(actor.dataId, { industry: parsed.data.industry, currency: parsed.data.currency?.toUpperCase(), actorId: actor.userId });
    return NextResponse.json(result, { status: result.seeded ? 201 : 200 });
  } catch (err) {
    return dbUnavailableResponse(err, "demo/seed");
  }
}
