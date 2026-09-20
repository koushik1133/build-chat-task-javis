import { randomUUID } from "crypto";
import { query, queryOne, withRetry } from "@/lib/dsql";
import { RUN_LIMITS, type JobKind, type JobPayload, type JobRow } from "./types";

/**
 * Durable job queue on the `agent_jobs` table.
 *
 * Claiming is a conditional UPDATE … RETURNING (the same pattern the
 * automation cron uses), so parallel ticks never run the same job twice.
 * A job whose lease expires is reclaimed; one that exhausts its attempts is
 * parked as `dead` rather than retried forever.
 */

export interface EnqueueOptions {
  runAfter?: Date;
  maxAttempts?: number;
}

export async function enqueueJob(
  userId: string,
  payload: JobPayload,
  opts: EnqueueOptions = {}
): Promise<string> {
  const id = randomUUID();
  await query(
    `INSERT INTO agent_jobs (id, user_id, kind, payload, status, attempts, max_attempts, run_after)
     VALUES ($1, $2, $3, $4, 'queued', 0, $5, $6)`,
    [
      id,
      userId,
      payload.kind satisfies JobKind,
      JSON.stringify(payload),
      opts.maxAttempts ?? 3,
      (opts.runAfter ?? new Date()).toISOString(),
    ]
  );
  return id;
}

/**
 * Claim up to `limit` due jobs for this worker. Jobs whose lease has expired
 * (a worker died mid-run) are eligible again.
 */
export async function claimJobs(workerId: string, limit = 5): Promise<JobRow[]> {
  const staleBefore = new Date(Date.now() - RUN_LIMITS.leaseMs).toISOString();

  const candidates = await query<{ id: string }>(
    `SELECT id FROM agent_jobs
     WHERE run_after <= NOW()
       AND (status = 'queued' OR (status = 'running' AND locked_at < $1))
     ORDER BY run_after ASC
     LIMIT $2`,
    [staleBefore, limit]
  );

  const claimed: JobRow[] = [];
  for (const c of candidates) {
    const row = await withRetry(() =>
      queryOne<JobRow>(
        `UPDATE agent_jobs
         SET status = 'running', locked_at = NOW(), locked_by = $2, attempts = attempts + 1
         WHERE id = $1
           AND (status = 'queued' OR (status = 'running' AND locked_at < $3))
         RETURNING *`,
        [c.id, workerId, staleBefore]
      )
    ).catch(() => null);
    if (row) claimed.push(row);
  }
  return claimed;
}

export async function completeJob(id: string): Promise<void> {
  await query(`UPDATE agent_jobs SET status = 'done', locked_by = NULL WHERE id = $1`, [id]);
}

/** Retry with exponential backoff until attempts are exhausted, then dead-letter. */
export async function failJob(job: JobRow, error: string): Promise<"retry" | "dead"> {
  const message = error.slice(0, 1000);
  if (job.attempts >= job.max_attempts) {
    await query(
      `UPDATE agent_jobs SET status = 'dead', last_error = $2, locked_by = NULL WHERE id = $1`,
      [job.id, message]
    );
    return "dead";
  }
  const delayMs = Math.min(15 * 60_000, 30_000 * 2 ** (job.attempts - 1));
  await query(
    `UPDATE agent_jobs
     SET status = 'queued', last_error = $2, locked_by = NULL, run_after = $3
     WHERE id = $1`,
    [job.id, message, new Date(Date.now() + delayMs).toISOString()]
  );
  return "retry";
}

export function parsePayload(job: JobRow): JobPayload | null {
  try {
    const p = JSON.parse(job.payload);
    return p && typeof p === "object" && typeof p.kind === "string" ? (p as JobPayload) : null;
  } catch {
    return null;
  }
}
