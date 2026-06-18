import { NextResponse } from "next/server";
import { query } from "@/lib/dsql";

export const runtime = "nodejs";

/** Lightweight health check — no auth required. */
export async function GET() {
  try {
    await query("SELECT 1 AS ok");
    return NextResponse.json({
      ok: true,
      database: "connected",
      time: new Date().toISOString(),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      {
        ok: false,
        database: "error",
        detail,
        hint: "Check DSQL_ENDPOINT and AWS credentials in .env.local (dev) or Cloud Run secrets (prod).",
      },
      { status: 503 }
    );
  }
}
