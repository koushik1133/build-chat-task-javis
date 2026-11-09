import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { claimJobs, completeJob, failJob, parsePayload } from "@/lib/agents/queue";
import { executeRun, resumeRun } from "@/lib/agents/runner";
import { promoteDueTriggers } from "@/lib/agents/triggers";
import { ensureToolsLoaded } from "@/lib/agents/tools";
import { drainOutbox } from "@/lib/notifications/outbox";
import { runSlaSweep } from "@/lib/helpdesk/tickets";
import { deliverPending, fanOutNewEvents } from "@/lib/webhooks/dispatch";
import { expireQuotes } from "@/lib/money/quotes";
import { syncDueAccounts } from "@/lib/mail/sync";
import { dialNext } from "@/lib/voice/dialer";
import { pruneRateLimits } from "@/lib/request-limits";
import { getSystemState, recordCronTick, setSystemState } from "@/lib/system/state";
import { captureError } from "@/lib/errors/capture";
import { processAccountingEvents, pullDue, pushDue } from "@/lib/accounting/sync";
import { remindDueSoon } from "@/lib/privacy/dsr";
import { applyRetention } from "@/lib/privacy/retention";
import { markOverdue, sendReminders } from "@/lib/money/dunning";
import { runDueSchedules } from "@/lib/money/recurring";
import { pruneVitals } from "@/lib/vitals";
import { sendDueDigests, sendDueReportSchedules } from "@/lib/reports/digest";
import { expireDocuments } from "@/lib/documents/documents";
import type { JobRow } from "@/lib/agents/types";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Stop claiming new jobs once a tick has been running this long. */
const DRAIN_BUDGET_MS = 45_000;
const CLAIM_BATCH = 5;

/**
 * Retention sweeps and DSR reminders are day-granular work that scans every
 * org's policies; running them on every (minute) tick is wasted load. They run
 * at most once per hour, gated by a system_state timestamp shared across
 * instances. Any failure reading the gate falls back to running (old behaviour).
 */
const HOURLY_KEY = "cron:agents:hourly_jobs";
const HOURLY_MS = 60 * 60 * 1000;

async function claimHourlySlot(now: Date): Promise<boolean> {
  try {
    const prev = await getSystemState<{ at?: string }>(HOURLY_KEY);
    const at = prev?.value?.at ? Date.parse(prev.value.at) : Number.NaN;
    if (Number.isFinite(at) && now.getTime() - at < HOURLY_MS) return false;
    await setSystemState(HOURLY_KEY, { at: now.toISOString() });
    return true;
  } catch (err) {
    console.warn("[cron/agents] hourly gate unavailable; running hourly jobs:", err instanceof Error ? err.message : err);
    return true;
  }
}

type PlaybookModule = {
  runPlaybook?: (userId: string, playbookId: string, entityId?: string) => Promise<unknown>;
  runPlaybookDetectors?: (userId?: string) => Promise<unknown>;
};

/** The playbooks module is owned by another lane; load it lazily so a broken module only fails playbook jobs. */
async function loadPlaybooks(): Promise<PlaybookModule | null> {
  try {
    return (await import("@/lib/agents/playbooks")) as PlaybookModule;
  } catch {
    return null;
  }
}

async function processJob(job: JobRow): Promise<"done" | "failed"> {
  const payload = parsePayload(job);
  if (!payload) throw new Error("unparseable job payload");

  switch (payload.kind) {
    case "run": {
      const out = await executeRun(payload.runId, job.locked_by ?? "cron");
      if (out.status === "failed") throw new Error(out.error);
      return "done";
    }
    case "resume": {
      const out = await resumeRun(payload.runId, payload.approvalId, job.locked_by ?? "cron");
      if (out.status === "failed") throw new Error(out.error);
      return "done";
    }
    case "eval": {
      const { executeEvalRun } = await import("@/lib/evals/run");
      const out = await executeEvalRun(payload.evalRunId);
      if (out?.status === "failed") throw new Error(out.error ?? "eval failed");
      return "done";
    }
    case "playbook": {
      const mod = await loadPlaybooks();
      if (!mod?.runPlaybook) throw new Error("playbooks module not available");
      await mod.runPlaybook(job.user_id, payload.playbookId, payload.entityId);
      return "done";
    }
    case "outbox":
      return "done"; // no-op until the outbox lane lands
    default:
      throw new Error(`unknown job kind ${(payload as { kind: string }).kind}`);
  }
}

async function handleTick(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 503 });
  }
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  ensureToolsLoaded();
  const tickStart = Date.now();
  const workerId = `cron-${randomUUID().slice(0, 8)}`;

  const counts = { promoted: 0, claimed: 0, done: 0, failed: 0, dead: 0, outbox: 0, sla: 0, quotes_expired: 0, webhooks_fanout: 0, webhooks: 0, mail: 0, calls: 0, accounting_events: 0, accounting_push: 0, accounting_pull: 0, privacy_reminders: 0, retention: 0, invoices_overdue: 0, invoice_reminders: 0, recurring_invoices: 0, report_schedules: 0, digests: 0, documents_expired: 0, hourly_ran: 0, ms: 0 };

  try {
    const promoted = await promoteDueTriggers(new Date());
    counts.promoted = promoted.promoted;
  } catch (err) {
    console.error("[cron/agents] promoteDueTriggers failed:", err);
  }

  try {
    const mod = await loadPlaybooks();
    if (mod?.runPlaybookDetectors) await mod.runPlaybookDetectors();
  } catch (err) {
    console.error("[cron/agents] playbook detectors failed:", err);
  }

  while (Date.now() - tickStart < DRAIN_BUDGET_MS) {
    const jobs = await claimJobs(workerId, CLAIM_BATCH).catch((err) => {
      console.error("[cron/agents] claim failed:", err);
      return [] as JobRow[];
    });
    if (jobs.length === 0) break;
    counts.claimed += jobs.length;

    for (const job of jobs) {
      try {
        await processJob(job);
        await completeJob(job.id);
        counts.done++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[cron/agents] job ${job.id} (${job.kind}) failed:`, message);
        void captureError(err, { route: "/api/cron/agents", method: "POST", status: 500 });
        const fate = await failJob(job, message).catch(() => "retry" as const);
        if (fate === "dead") counts.dead++;
        else counts.failed++;
      }
      if (Date.now() - tickStart >= DRAIN_BUDGET_MS) break;
    }
  }

  try {
    counts.outbox = (await drainOutbox(50)).claimed;
  } catch (err) {
    console.error("[cron/agents] outbox drain failed:", err);
  }
  try {
    const sla = await runSlaSweep(200);
    counts.sla = sla.breachedFirstResponse + sla.breachedResolution;
  } catch (err) {
    console.error("[cron/agents] SLA sweep failed:", err);
  }

  try { counts.quotes_expired = (await expireQuotes(200)).expired; } catch (err) { console.error("[cron/agents] quote expiry sweep failed:", err); }
  try { counts.webhooks_fanout = (await fanOutNewEvents(200)).created; } catch (err) { console.error("[cron/agents] webhook fan-out failed:", err); }
  try { counts.webhooks = (await deliverPending(50)).delivered; } catch (err) { console.error("[cron/agents] webhook delivery failed:", err); }
  try { counts.mail = (await syncDueAccounts(20)).claimed; } catch (err) { console.error("[cron/agents] mail sync failed:", err); }
  try { counts.calls = (await dialNext(20)).dialed; } catch (err) { console.error("[cron/agents] dialer failed:", err); }

  try { counts.accounting_events = (await processAccountingEvents(200)).pushed; } catch (err) { console.error("[cron/agents] accounting events failed:", err); }
  try { counts.accounting_push = (await pushDue(50)).pushed; } catch (err) { console.error("[cron/agents] accounting push failed:", err); }
  try { counts.accounting_pull = (await pullDue(10)).recorded; } catch (err) { console.error("[cron/agents] accounting pull failed:", err); }
  if (await claimHourlySlot(new Date())) {
    counts.hourly_ran = 1;
    try { counts.privacy_reminders = (await remindDueSoon(200)).reminded; } catch (err) { console.error("[cron/agents] privacy reminders failed:", err); }
    try { const r = await applyRetention(500); counts.retention = Object.values(r.affected).reduce((a, b) => a + b, 0); } catch (err) { console.error("[cron/agents] retention failed:", err); }
    await pruneVitals(30).catch(() => 0);
    try { counts.digests = (await sendDueDigests(50)).sent; } catch (err) { console.error("[cron/agents] digests failed:", err); }
  }
  try { counts.report_schedules = (await sendDueReportSchedules(20)).sent; } catch (err) { console.error("[cron/agents] report schedules failed:", err); }
  try { counts.documents_expired = (await expireDocuments(200)).expired; } catch (err) { console.error("[cron/agents] document expiry failed:", err); }
  try { counts.invoices_overdue = (await markOverdue(200)).marked; } catch (err) { console.error("[cron/agents] overdue sweep failed:", err); }
  try { counts.invoice_reminders = (await sendReminders(100)).sent; } catch (err) { console.error("[cron/agents] reminder sweep failed:", err); }
  try { counts.recurring_invoices = (await runDueSchedules(50)).created; } catch (err) { console.error("[cron/agents] recurring sweep failed:", err); }
  await pruneRateLimits().catch(() => 0);

  counts.ms = Date.now() - tickStart;
  await recordCronTick(counts).catch(() => undefined);
  return NextResponse.json({ ok: true, worker: workerId, ...counts, server_time: new Date().toISOString() });
}

export async function GET(req: Request) {
  try {
    return await handleTick(req);
  } catch (err) {
    console.error("[cron/agents] unhandled:", err);
    return NextResponse.json({ error: "cron failed" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    return await handleTick(req);
  } catch (err) {
    console.error("[cron/agents] unhandled:", err);
    return NextResponse.json({ error: "cron failed" }, { status: 500 });
  }
}
