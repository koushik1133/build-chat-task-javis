import { NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { query, queryOne } from "@/lib/dsql";
import { tableExists } from "@/lib/table-exists";
import { describeProviders as describeLlm } from "@/lib/llm/providers";
import { describeProviders as describePayments } from "@/lib/payments";
import { describeMailProviders } from "@/lib/mail";
import { describeAccountingProviders } from "@/lib/accounting";
import { channelStatus, twilioIsLive } from "@/lib/notifications/status";
import { listRecentErrors } from "@/lib/errors/capture";
import { CRON_TICK_KEY, getSystemState } from "@/lib/system/state";
import { summariseVitals } from "@/lib/vitals";
import { listEvents } from "@/lib/alerts/store";
import { cronAgeMinutes } from "@/lib/metrics/collect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DB_TIMEOUT_MS = 3_000;

interface CountRow { status: string; n: number | string }

/** `dataId` null = deployment-wide (operator org only); otherwise the caller's workspace. */
async function countsBy(table: string, statuses: string[], dataId: string | null): Promise<Record<string, number>> {
  const out: Record<string, number> = Object.fromEntries(statuses.map((s) => [s, 0]));
  if (!(await tableExists(table))) return out;
  const rows = dataId === null
    ? await query<CountRow>(`SELECT status, COUNT(*) AS n FROM ${table} WHERE status = ANY($1::text[]) GROUP BY status`, [statuses]).catch(() => [])
    : await query<CountRow>(`SELECT status, COUNT(*) AS n FROM ${table} WHERE user_id = $2 AND status = ANY($1::text[]) GROUP BY status`, [statuses, dataId]).catch(() => []);
  for (const r of rows) out[r.status] = Number(r.n);
  return out;
}

/** GET /api/system/status — owner/admin only. Platform health for Settings → System health. */
export async function GET() {
  let scope;
  try {
    scope = await requireScope({ area: "settings", edit: false });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (scope.role !== "owner" && scope.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const started = Date.now();
  let database: { ok: boolean; latencyMs: number | null; error?: string };
  try {
    await Promise.race([
      queryOne("SELECT 1 AS ok"),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), DB_TIMEOUT_MS)),
    ]);
    database = { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    database = { ok: false, latencyMs: null, error: err instanceof Error ? err.message : "error" };
  }

  const channels = channelStatus();
  const providers = {
    payments: describePayments().map((p) => ({ id: p.id, configured: p.configured, active: p.active })),
    email: channels.email,
    sms: channels.sms,
    push: channels.push,
    mail: describeMailProviders().map((m) => ({ id: m.id, label: m.label, configured: m.configured })),
    voice: twilioIsLive() ? "live" : "simulated",
    accounting: describeAccountingProviders().map((a) => ({ id: a.id, configured: a.configured, active: a.active })),
    llm: describeLlm().map((l) => ({ id: l.id, label: l.label, model: l.model, configured: l.configured })),
  };

  if (!database.ok) {
    return NextResponse.json({ database, providers, cron: null, queue: null, outbox: null, webhooks: null, errors: [], errorsAvailable: false, vitals: null }, { status: 200 });
  }

  // Deployment-wide queue numbers are operator-only (OPERATOR_ORG_ID); everyone else sees their own workspace.
  const operatorId = process.env.OPERATOR_ORG_ID?.trim();
  const platform = Boolean(operatorId) && (operatorId === scope.dataId || operatorId === scope.orgId);
  const countScope = platform ? null : scope.dataId;
  const [cron, queue, outbox, webhooks, errorsAvailable, vitals, recentAlerts, cronAgeMin] = await Promise.all([
    getSystemState<{ at: string; counts: Record<string, number> }>(CRON_TICK_KEY).catch(() => null),
    countsBy("agent_jobs", ["queued", "running", "failed", "dead"], countScope),
    countsBy("notification_outbox", ["queued", "failed"], countScope),
    countsBy("webhook_deliveries", ["queued", "failed", "dead"], countScope),
    tableExists("app_errors"),
    // Web Vitals are deployment-wide aggregates (anonymous, no tenant key) — not scoped to this org.
    summariseVitals(24).catch(() => null),
    tableExists("alert_events").then((ok) => (ok ? listEvents(scope.dataId, 10) : [])).catch(() => []),
    cronAgeMinutes().catch(() => null),
  ]);
  const errors = errorsAvailable ? await listRecentErrors(50, scope.dataId).catch(() => []) : [];

  return NextResponse.json({
    database,
    providers,
    cron: cron ? { lastTickAt: cron.value?.at ?? cron.updatedAt, counts: cron.value?.counts ?? {} } : null,
    queue,
    outbox,
    webhooks,
    errors,
    errorsAvailable,
    vitals,
    diagnostics: { scope: platform ? "platform" : "workspace", cronAgeMinutes: cronAgeMin === null ? null : Math.round(cronAgeMin * 10) / 10, recentAlerts },
  });
}
