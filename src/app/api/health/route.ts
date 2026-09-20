import { NextResponse } from "next/server";
import { query } from "@/lib/dsql";
import { isLlmConfigured } from "@/lib/llm";

export const runtime = "nodejs";

const DB_TIMEOUT_MS = 3000;

/** Lightweight health check — no auth required. */
export async function GET() {
  try {
    await Promise.race([
      query("SELECT 1 AS ok"),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("health check timed out")), DB_TIMEOUT_MS)
      ),
    ]);
    return NextResponse.json({
      ok: true,
      database: "connected",
      llm: isLlmConfigured() ? "configured" : "missing",
      time: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[health] database probe failed:", err);
    return NextResponse.json({ ok: false, database: "error" }, { status: 503 });
  }
}
