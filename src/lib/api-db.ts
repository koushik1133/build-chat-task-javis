import { NextResponse } from "next/server";

/** Return a safe JSON error when the database is down or misconfigured. */
export function dbUnavailableResponse(err: unknown, context?: string) {
  const detail = err instanceof Error ? err.message : String(err);
  console.error(context ? `[${context}] DSQL error:` : "[api] DSQL error:", detail);
  return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
}
