import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { claimJobs, completeJob, failJob, parsePayload } from "@/lib/agents/queue";
import { executeRun, resumeRun } from "@/lib/agents/runner";
import { promoteDueTriggers } from "@/lib/agents/triggers";
import { ensureToolsLoaded } from "@/lib/agents/tools";
import { drainOutbox } from "@/lib/notifications/outbox";
import type { JobRow } from "@/lib/agents/types";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Stop claiming new jobs once a tick has been running this long. */
const DRAIN_BUDGET_MS = 45_000;
const CLAIM_BATCH = 5;

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

  const counts = { promoted: 0, claimed: 0, done: 0, failed: 0, dead: 0, outbox: 0, ms: 0 };

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
        const fate = await failJob(job, message).catch(() => "retry" as const);
        if (fate === "dead") counts.dead++;
        else counts.failed++;
      }
      if (Date.now() - tickStart >= DRAIN_BUDGET_MS) break;
    }
  }

  counts.outbox = (await drainOutbox(50)).claimed;

  counts.ms = Date.now() - tickStart;
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
