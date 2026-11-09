import { randomUUID } from "crypto";
import { query, queryOne } from "@/lib/dsql";
import { tableExists } from "@/lib/table-exists";
import { REDACTED } from "./anonymize";
import { enforceRetentionFloor, RETENTION_KINDS, RETENTION_META, type RetentionAction, type RetentionKind } from "./constants";

/**
 * Retention policies + the cron sweep. Floors from RETENTION_META are
 * enforced on write and again on apply, so a stale row can never purge
 * below the statutory minimum. Invoices / payments are never touched.
 */

export interface RetentionPolicyRow {
  id: string;
  user_id: string;
  entity_kind: RetentionKind;
  keep_days: number;
  action: RetentionAction;
  enabled: boolean;
  last_run_at: string | null;
  last_affected: number | null;
  updated_at: string;
}

const COLS = `id, user_id, entity_kind, keep_days, action, enabled, last_run_at, last_affected, updated_at`;

/** Every kind, with stored policy or defaults (disabled). */
export async function listPolicies(dataId: string): Promise<RetentionPolicyRow[]> {
  const rows = await query<RetentionPolicyRow>(`SELECT ${COLS} FROM retention_policies WHERE user_id = $1`, [dataId]).catch(() => []);
  const byKind = new Map(rows.map((r) => [r.entity_kind, r]));
  return RETENTION_KINDS.map(
    (k) =>
      byKind.get(k) ?? {
        id: "",
        user_id: dataId,
        entity_kind: k,
        keep_days: RETENTION_META[k].defaultDays,
        action: RETENTION_META[k].actions[0],
        enabled: false,
        last_run_at: null,
        last_affected: null,
        updated_at: new Date(0).toISOString(),
      }
  );
}

export async function upsertPolicy(dataId: string, kind: RetentionKind, input: { keep_days: number; action: RetentionAction; enabled: boolean }): Promise<RetentionPolicyRow> {
  const keep = enforceRetentionFloor(kind, input.keep_days);
  const action = RETENTION_META[kind].actions.includes(input.action) ? input.action : RETENTION_META[kind].actions[0];
  const updated = await queryOne<RetentionPolicyRow>(
    `UPDATE retention_policies SET keep_days = $3, action = $4, enabled = $5, updated_at = NOW() WHERE user_id = $1 AND entity_kind = $2 RETURNING ${COLS}`,
    [dataId, kind, keep, action, input.enabled]
  );
  if (updated) return updated;
  const row = await queryOne<RetentionPolicyRow>(
    `INSERT INTO retention_policies (id, user_id, entity_kind, keep_days, action, enabled, updated_at) VALUES ($1, $2, $3, $4, $5, $6, NOW()) RETURNING ${COLS}`,
    [randomUUID(), dataId, kind, keep, action, input.enabled]
  );
  if (!row) throw new Error("retention insert returned no row");
  return row;
}

/* ---------- sweep ---------- */

export interface RetentionRunResult {
  policies: number;
  affected: Record<string, number>;
}

async function affectedCount(table: string, sql: string, params: unknown[]): Promise<number> {
  if (!(await tableExists(table))) return 0;
  const rows = await query<{ id: string }>(`${sql} RETURNING id`, params).catch((err) => {
    console.error(`[retention] ${table} failed:`, err instanceof Error ? err.message : err);
    return [];
  });
  return rows.length;
}

/** Apply one policy; returns rows touched. `limit` bounds each statement. */
export async function applyPolicy(p: RetentionPolicyRow, limit: number): Promise<number> {
  const keep = enforceRetentionFloor(p.entity_kind, p.keep_days); // floor re-applied at run time
  const cutoff = new Date(Date.now() - keep * 86_400_000).toISOString();
  const u = p.user_id;
  const del = p.action === "delete";
  switch (p.entity_kind) {
    case "tickets_closed": {
      const ids = (
        await query<{ id: string }>(`SELECT id FROM tickets WHERE user_id = $1 AND status IN ('resolved','closed') AND COALESCE(resolved_at, updated_at) < $2 ORDER BY updated_at ASC LIMIT $3`, [u, cutoff, limit]).catch(() => [])
      ).map((r) => r.id);
      if (ids.length === 0) return 0;
      if (del) {
        await affectedCount("ticket_messages", `DELETE FROM ticket_messages WHERE user_id = $1 AND ticket_id = ANY($2)`, [u, ids]);
        return affectedCount("tickets", `DELETE FROM tickets WHERE user_id = $1 AND id = ANY($2)`, [u, ids]);
      }
      await affectedCount("ticket_messages", `UPDATE ticket_messages SET body = $3 WHERE user_id = $1 AND ticket_id = ANY($2) AND body <> $3`, [u, ids, REDACTED]);
      return affectedCount("tickets", `UPDATE tickets SET requester_email = NULL, requester_name = NULL, contact_id = NULL, updated_at = NOW() WHERE user_id = $1 AND id = ANY($2) AND (requester_email IS NOT NULL OR requester_name IS NOT NULL OR contact_id IS NOT NULL)`, [u, ids]);
    }
    case "mail_bodies":
      return del
        ? affectedCount("mail_messages", `DELETE FROM mail_messages WHERE id IN (SELECT id FROM mail_messages WHERE user_id = $1 AND COALESCE(received_at, created_at) < $2 LIMIT $3)`, [u, cutoff, limit])
        : affectedCount("mail_messages", `UPDATE mail_messages SET body_text = NULL, body_html = NULL, snippet = NULL WHERE id IN (SELECT id FROM mail_messages WHERE user_id = $1 AND COALESCE(received_at, created_at) < $2 AND (body_text IS NOT NULL OR body_html IS NOT NULL) LIMIT $3)`, [u, cutoff, limit]);
    case "leads_resolved":
      return del
        ? affectedCount("site_leads", `DELETE FROM site_leads WHERE id IN (SELECT id FROM site_leads WHERE user_id = $1 AND status NOT IN ('new','contacted') AND created_at < $2 LIMIT $3)`, [u, cutoff, limit])
        : affectedCount("site_leads", `UPDATE site_leads SET data = '{}', research_summary = NULL, draft_email_subject = NULL, draft_email_body = NULL WHERE id IN (SELECT id FROM site_leads WHERE user_id = $1 AND status NOT IN ('new','contacted') AND created_at < $2 AND data <> '{}' LIMIT $3)`, [u, cutoff, limit]);
    case "voice_recordings":
      return affectedCount("voice_calls", `UPDATE voice_calls SET recording_url = NULL, transcript = NULL WHERE id IN (SELECT id FROM voice_calls WHERE user_id = $1 AND created_at < $2 AND (recording_url IS NOT NULL OR transcript IS NOT NULL) LIMIT $3)`, [u, cutoff, limit]);
    case "outbox":
      return affectedCount("notification_outbox", `DELETE FROM notification_outbox WHERE id IN (SELECT id FROM notification_outbox WHERE user_id = $1 AND status <> 'queued' AND created_at < $2 LIMIT $3)`, [u, cutoff, limit]);
    case "audit_log":
      // "archive" keeps the row but drops ip/user_agent; "delete" removes rows past the (≥365 day) floor.
      return del
        ? affectedCount("audit_log", `DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log WHERE user_id = $1 AND created_at < $2 LIMIT $3)`, [u, cutoff, limit])
        : affectedCount("audit_log", `UPDATE audit_log SET ip = NULL, user_agent = NULL WHERE id IN (SELECT id FROM audit_log WHERE user_id = $1 AND created_at < $2 AND (ip IS NOT NULL OR user_agent IS NOT NULL) LIMIT $3)`, [u, cutoff, limit]);
  }
}

/** Cron hook: run every enabled policy across all orgs. Never throws. */
export async function applyRetention(limit = 500): Promise<RetentionRunResult> {
  const result: RetentionRunResult = { policies: 0, affected: {} };
  if (!(await tableExists("retention_policies"))) return result;
  const policies = await query<RetentionPolicyRow>(`SELECT ${COLS} FROM retention_policies WHERE enabled = TRUE ORDER BY updated_at ASC LIMIT 2000`, []).catch(() => []);
  for (const p of policies) {
    result.policies++;
    const n = await applyPolicy(p, Math.max(1, Math.min(5000, limit))).catch(() => 0);
    result.affected[p.entity_kind] = (result.affected[p.entity_kind] ?? 0) + n;
    await query(`UPDATE retention_policies SET last_run_at = NOW(), last_affected = $2 WHERE id = $1`, [p.id, n]).catch(() => undefined);
  }
  return result;
}
