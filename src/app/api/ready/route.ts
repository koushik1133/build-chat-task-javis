import { NextResponse } from "next/server";
import { query } from "@/lib/dsql";
import { tableExists } from "@/lib/table-exists";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Tables whose absence means migrations were not applied. */
const CRITICAL_TABLES = ["organizations", "memberships", "notification_outbox", "agent_jobs", "audit_log", "system_state", "alert_rules"];

/** GET /api/ready — readiness for orchestrators: DB ping + critical tables present. Names only, no detail. */
export async function GET() {
  try {
    await Promise.race([query("SELECT 1 AS ok"), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 3000))]);
  } catch {
    return NextResponse.json({ ready: false, database: "error" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  const missing: string[] = [];
  for (const t of CRITICAL_TABLES) if (!(await tableExists(t))) missing.push(t);
  const ready = missing.length === 0;
  return NextResponse.json({ ready, database: "connected", migrations: ready ? "applied" : "incomplete", missing }, { status: ready ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
