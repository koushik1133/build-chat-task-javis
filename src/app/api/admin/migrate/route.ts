import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { migrationStatus, runPendingMigrations } from "@/lib/db/migrate";
import { rateLimitAsync, clientIp } from "@/lib/request-limits";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Operator-only schema migration endpoint.
 *   GET  → { total, applied, pending }
 *   POST → applies pending statements for up to ~40 s; call again until `remaining` is 0.
 * Auth: `Authorization: Bearer $CRON_SECRET`. 404 when CRON_SECRET is not configured.
 */
function authorised(req: Request): boolean | null {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return null;
  const given = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const a = Buffer.from(secret);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function gate(req: Request): Promise<NextResponse | null> {
  const ok = authorised(req);
  if (ok === null) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const rl = await rateLimitAsync(`admin-migrate:${clientIp(req)}`, { limit: 30, windowMs: 60_000 });
  if (!rl.allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  if (!ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return null;
}

export async function GET(req: Request) {
  const denied = await gate(req);
  if (denied) return denied;
  try {
    return NextResponse.json(await migrationStatus(), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return NextResponse.json({ error: "database_unreachable", detail: err instanceof Error ? err.message.slice(0, 200) : "unknown" }, { status: 503 });
  }
}

export async function POST(req: Request) {
  const denied = await gate(req);
  if (denied) return denied;
  try {
    const run = await runPendingMigrations({ budgetMs: 40_000 });
    return NextResponse.json({ ok: run.failed.length === 0, ...run }, { status: run.failed.length ? 500 : 200, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return NextResponse.json({ error: "database_unreachable", detail: err instanceof Error ? err.message.slice(0, 200) : "unknown" }, { status: 503 });
  }
}
