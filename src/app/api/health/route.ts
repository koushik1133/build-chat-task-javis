import { NextResponse } from "next/server";
import { query } from "@/lib/dsql";
import { isLlmConfigured } from "@/lib/llm";
import { validateEnv } from "@/lib/env";
import { requireScope } from "@/lib/auth/scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DB_TIMEOUT_MS = 3000;

/**
 * Is the caller allowed to see the verbose env report?
 * Either `Authorization: Bearer <CRON_SECRET>` (deploy tooling) or a signed-in
 * org owner/admin. Any failure → false; the public shape is returned instead.
 */
async function canSeeVerbose(req: Request): Promise<boolean> {
  const secret = process.env.CRON_SECRET?.trim();
  const auth = req.headers.get("authorization");
  if (secret && auth === `Bearer ${secret}`) return true;
  try {
    const scope = await requireScope({ area: "settings", edit: false });
    return scope.role === "owner" || scope.role === "admin";
  } catch {
    return false;
  }
}

/**
 * GET /api/health — public liveness/readiness probe (DB round-trip, 3s cap).
 * GET /api/health?verbose=1 — adds the environment audit (missing/invalid
 * vars, provider matrix, service-role key sanity) for owners/admins or
 * callers holding CRON_SECRET. Never leaks values, only names.
 */
export async function GET(req: Request) {
  const started = Date.now();
  let database: "connected" | "error" = "connected";
  try {
    await Promise.race([
      query("SELECT 1 AS ok"),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("health check timed out")), DB_TIMEOUT_MS)
      ),
    ]);
  } catch (err) {
    console.error("[health] database probe failed:", err);
    database = "error";
  }

  const base = {
    ok: database === "connected",
    database,
    llm: isLlmConfigured() ? "configured" : "missing",
    time: new Date().toISOString(),
  };
  if (database === "error") return NextResponse.json(base, { status: 503 });

  // `req?.url`: unit tests call GET() bare; Next always passes a Request.
  const verbose = req?.url ? new URL(req.url).searchParams.get("verbose") === "1" : false;
  if (!verbose || !(await canSeeVerbose(req))) return NextResponse.json(base);

  const env = validateEnv({ strict: false });
  return NextResponse.json({
    ...base,
    latencyMs: Date.now() - started,
    version: process.env.npm_package_version ?? null,
    node: process.version,
    env: {
      ok: env.ok,
      database: env.database,
      missing: env.missing,
      invalid: env.invalid,
      warnings: env.warnings,
      providers: env.providers,
    },
  });
}
