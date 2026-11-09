import { randomUUID } from "crypto";
import { query, queryOne } from "@/lib/dsql";
import { recordAudit } from "@/lib/audit";
import { enqueueNotification } from "@/lib/notifications/outbox";
import { breachDeadline, type IncidentSeverity, type IncidentStatus } from "./constants";

/** Security incident / breach log. The 72-hour clock starts at `detected_at`. */

export interface IncidentRow {
  id: string;
  user_id: string;
  title: string;
  description: string | null;
  severity: IncidentSeverity;
  status: IncidentStatus;
  detected_at: string;
  contained_at: string | null;
  notified_authority_at: string | null;
  notified_subjects_at: string | null;
  affected_count: number | null;
  created_at: string;
  updated_at: string;
}

const COLS = `id, user_id, title, description, severity, status, detected_at, contained_at, notified_authority_at, notified_subjects_at, affected_count, created_at, updated_at`;

export interface IncidentInput {
  title: string;
  description?: string | null;
  severity: IncidentSeverity;
  detected_at: string;
  affected_count?: number | null;
}

export async function listIncidents(dataId: string, limit = 200): Promise<IncidentRow[]> {
  return query<IncidentRow>(`SELECT ${COLS} FROM security_incidents WHERE user_id = $1 ORDER BY (status = 'closed') ASC, detected_at DESC LIMIT $2`, [dataId, Math.max(1, Math.min(500, limit))]).catch(() => []);
}

export async function createIncident(dataId: string, input: IncidentInput, actorId: string | null): Promise<IncidentRow> {
  const row = await queryOne<IncidentRow>(
    `INSERT INTO security_incidents (id, user_id, title, description, severity, status, detected_at, affected_count, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'open', $6, $7, $8, NOW(), NOW()) RETURNING ${COLS}`,
    [randomUUID(), dataId, input.title, input.description ?? null, input.severity, input.detected_at, input.affected_count ?? null, actorId]
  );
  if (!row) throw new Error("incident insert returned no row");
  await recordAudit({ dataId, userId: actorId }, { action: "privacy.incident.opened", entity: "security_incident", entityId: row.id, after: { title: row.title, severity: row.severity } });
  const deadline = breachDeadline(row.detected_at);
  await enqueueNotification(dataId, {
    channel: "in_app",
    recipient: dataId,
    subject: `Security incident logged: ${row.title}`,
    body: `Authority notification is due by ${deadline.toISOString()} (72 hours after detection). Affected people must be told without delay.`,
    data: { kind: "incident_opened", incident_id: row.id, href: "/settings/privacy" },
  }).catch(() => undefined);
  return row;
}

export interface IncidentPatch {
  title?: string;
  description?: string | null;
  severity?: IncidentSeverity;
  status?: IncidentStatus;
  contained_at?: string | null;
  notified_authority_at?: string | null;
  notified_subjects_at?: string | null;
  affected_count?: number | null;
}

export async function updateIncident(dataId: string, id: string, patch: IncidentPatch, actorId: string | null): Promise<IncidentRow | null> {
  const before = await queryOne<IncidentRow>(`SELECT ${COLS} FROM security_incidents WHERE id = $1 AND user_id = $2`, [id, dataId]);
  if (!before) return null;
  const sets: string[] = ["updated_at = NOW()"];
  const values: unknown[] = [id, dataId];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    values.push(v);
    sets.push(`${k} = $${values.length}`);
  }
  const row = await queryOne<IncidentRow>(`UPDATE security_incidents SET ${sets.join(", ")} WHERE id = $1 AND user_id = $2 RETURNING ${COLS}`, values);
  if (row) await recordAudit({ dataId, userId: actorId }, { action: "privacy.incident.updated", entity: "security_incident", entityId: id, before: { ...before }, after: { ...row } });
  return row;
}
