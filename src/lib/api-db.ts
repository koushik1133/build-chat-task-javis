import { NextResponse } from "next/server";

/** Return a safe JSON error when Aurora DSQL is down or misconfigured. */
export function dbUnavailableResponse(err: unknown, context?: string) {
  const detail = err instanceof Error ? err.message : String(err);
  console.error(context ? `[${context}] DSQL error:` : "[api] DSQL error:", detail);
  return NextResponse.json(
    {
      error: "Database temporarily unavailable",
      detail:
        detail.includes("DSQL_ENDPOINT")
          ? "DSQL_ENDPOINT is not set in .env.local (local) or Cloud Run secrets (production)."
          : detail,
    },
    { status: 503 }
  );
}
