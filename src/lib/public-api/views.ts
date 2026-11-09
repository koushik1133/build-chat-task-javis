import { parseTags, type TicketMessageRow, type TicketRow } from "@/lib/helpdesk/tickets";

/** Public views of rows that carry internal columns. */

const TICKET_INTERNAL = new Set(["user_id", "sla_policy_id", "conversation_id", "escalated_at"]);

function omit<T extends object>(row: T, keys: ReadonlySet<string>): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(row)) if (!keys.has(k)) (out as Record<string, unknown>)[k] = v;
  return out;
}

export function ticketView(t: TicketRow) {
  return { ...(omit(t, TICKET_INTERNAL) as Omit<TicketRow, "user_id" | "sla_policy_id" | "conversation_id" | "escalated_at" | "tags">), tags: parseTags(t.tags) };
}

export function ticketMessageView(m: TicketMessageRow): Omit<TicketMessageRow, "user_id"> {
  return omit(m, new Set(["user_id"])) as Omit<TicketMessageRow, "user_id">;
}

/* ─── Phase 6 views ───────────────────────────────────────────────────── */

import type { EquipmentCheckoutDTO } from "@/lib/inventory/stock";
import type { SlaPolicyRow } from "@/lib/helpdesk/tickets";
import { parseJsonArray, type KbArticleRow } from "@/lib/kb/articles";
import type { ListingDTO } from "@/lib/marketplace/types";
import type { ConsentRow } from "@/lib/privacy/consent";
import type { DsrRow } from "@/lib/privacy/dsr";
import type { CampaignRow, TargetRow } from "@/lib/voice/campaigns";
import type { ApprovalRow } from "@/lib/approvals/decide";

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const isoOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : iso(v));

function parseObject(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function checkoutView(c: EquipmentCheckoutDTO) {
  const { user_id: _u, ...rest } = c;
  void _u;
  return { ...rest, due_back_at: isoOrNull(c.due_back_at), returned_at: isoOrNull(c.returned_at), created_at: iso(c.created_at) };
}

export function slaPolicyView(p: SlaPolicyRow) {
  return {
    id: p.id,
    name: p.name,
    first_response_minutes: Number(p.first_response_minutes),
    resolution_minutes: Number(p.resolution_minutes),
    business_hours_only: Boolean(p.business_hours_only),
    priority_overrides: parseObject(p.priority_overrides),
    is_default: Boolean(p.is_default),
    created_at: iso(p.created_at),
  };
}

export function kbArticleView(a: KbArticleRow) {
  return {
    id: a.id,
    slug: a.slug,
    title: a.title,
    body_md: a.body_md,
    excerpt: a.excerpt,
    category: a.category,
    tags: parseJsonArray(a.tags),
    status: a.status,
    is_public: Boolean(a.is_public),
    views: Number(a.views) || 0,
    source_ticket_ids: parseJsonArray(a.source_ticket_ids),
    created_at: iso(a.created_at),
    updated_at: iso(a.updated_at),
    published_at: isoOrNull(a.published_at),
  };
}

export function listingView(l: ListingDTO) {
  const { definition: _d, rating_sum: _s, ...rest } = l;
  void _d;
  void _s;
  return rest;
}

export function consentView(c: ConsentRow) {
  return {
    id: c.id,
    subject_kind: c.subject_kind,
    subject_id: c.subject_id,
    purpose: c.purpose,
    status: c.status,
    source: c.source,
    occurred_at: iso(c.occurred_at),
    created_at: iso(c.created_at),
  };
}

export function dsrView(r: DsrRow) {
  return {
    id: r.id,
    subject_kind: r.subject_kind,
    subject_id: r.subject_id,
    subject_email: r.subject_email,
    kind: r.kind,
    status: r.status,
    source: r.source,
    requested_at: iso(r.requested_at),
    due_at: iso(r.due_at),
    verified_at: isoOrNull(r.verified_at),
    completed_at: isoOrNull(r.completed_at),
    handled_by: r.handled_by,
    notes: r.notes,
    result: r.result,
    created_at: iso(r.created_at),
  };
}

export function campaignView(c: CampaignRow) {
  return {
    id: c.id,
    name: c.name,
    script: c.script,
    voice: c.voice,
    status: c.status,
    schedule_at: isoOrNull(c.schedule_at),
    window_start: c.window_start,
    window_end: c.window_end,
    timezone: c.timezone,
    max_attempts: Number(c.max_attempts),
    require_consent: c.require_consent,
    created_at: iso(c.created_at),
    updated_at: iso(c.updated_at),
  };
}

export function targetView(t: TargetRow) {
  return {
    id: t.id,
    contact_id: t.contact_id,
    phone: t.phone,
    first_name: t.first_name,
    status: t.status,
    attempts: Number(t.attempts),
    last_attempt_at: isoOrNull(t.last_attempt_at),
    outcome: t.outcome,
    created_at: iso(t.created_at),
  };
}

export interface AgentRow {
  id: string;
  name: string;
  role: string;
  status: string;
  autonomy_level: string | null;
  tools: string | null;
  model: string | null;
  tasks_completed: number | null;
  created_at: string | Date;
}
export const AGENT_COLS = `id::text AS id, name, role, status, autonomy_level, tools, model, tasks_completed, created_at`;

export function agentView(a: AgentRow) {
  let tools: string[] | null = null;
  if (a.tools) {
    try {
      const v: unknown = JSON.parse(a.tools);
      if (Array.isArray(v)) tools = v.filter((t): t is string => typeof t === "string");
    } catch {
      tools = null;
    }
  }
  return { id: a.id, name: a.name, role: a.role, status: a.status, autonomy_level: a.autonomy_level, tools, model: a.model, tasks_completed: a.tasks_completed === null ? null : Number(a.tasks_completed), created_at: iso(a.created_at) };
}

export interface RunRow {
  id: string;
  agent_id: string;
  agent_name: string | null;
  status: string | null;
  trigger_kind: string | null;
  prompt: string | null;
  output: string | null;
  error: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  started_at: string | Date | null;
  finished_at: string | Date | null;
  created_at: string | Date;
}
export const RUN_SELECT = `SELECT r.id::text AS id, r.agent_id::text AS agent_id, a.name AS agent_name, r.status, r.trigger_kind, r.prompt, r.output, r.error, r.tokens_in, r.tokens_out, r.started_at, r.finished_at, r.created_at
  FROM agent_runs r LEFT JOIN agents a ON a.id = r.agent_id`;

export function runView(r: RunRow) {
  return {
    id: r.id,
    agent_id: r.agent_id,
    agent_name: r.agent_name,
    status: r.status ?? "done",
    trigger_kind: r.trigger_kind,
    prompt: r.prompt,
    output: r.output,
    error: r.error,
    tokens_in: r.tokens_in,
    tokens_out: r.tokens_out,
    started_at: isoOrNull(r.started_at),
    finished_at: isoOrNull(r.finished_at),
    created_at: iso(r.created_at),
  };
}

export type ApprovalWithAgent = ApprovalRow & { agent_name: string | null };

export function approvalView(a: ApprovalWithAgent) {
  return {
    id: a.id,
    run_id: a.run_id,
    agent_id: a.agent_id,
    agent_name: a.agent_name,
    tool_name: a.tool_name,
    input: parseObject(a.input) ?? {},
    preview: a.preview,
    status: a.status,
    decided_by: a.decided_by,
    decided_at: isoOrNull(a.decided_at),
    expires_at: isoOrNull(a.expires_at),
    created_at: iso(a.created_at),
  };
}
