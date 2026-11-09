import { z } from "zod";
import { CurrencySchema } from "@/lib/money/items";

/**
 * Projects: client-safe types, zod schemas and pure math (progress, budget,
 * timeline bucketing, quote → project mapping). No DB imports — the pages and
 * the store both consume this file.
 */

export const PROJECT_STATUSES = ["planning", "active", "on_hold", "done", "cancelled"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export const BILLING_MODES = ["fixed", "hourly", "none"] as const;
export type BillingMode = (typeof BILLING_MODES)[number];
export const MILESTONE_STATUSES = ["open", "done"] as const;
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];
export const PROJECT_MEMBER_ROLES = ["lead", "member", "viewer"] as const;
export type ProjectMemberRole = (typeof PROJECT_MEMBER_ROLES)[number];
export const TASK_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/**
 * Stored → project priority. The tasks lane writes `normal` for the tier this
 * module calls `medium`; both spellings live in `tasks.priority`, so readers map
 * instead of leaking an off-enum value. Unknown values read as null.
 */
export function normaliseTaskPriority(v: unknown): TaskPriority | null {
  if (v === "normal") return "medium";
  return typeof v === "string" && (TASK_PRIORITIES as readonly string[]).includes(v) ? (v as TaskPriority) : null;
}

export class ProjectError extends Error {
  constructor(message: string, public readonly status: 400 | 404 | 409 = 400) {
    super(message);
    this.name = "ProjectError";
  }
}

/* ─── DTOs ───────────────────────────────────────────────────────────────── */

export interface ProjectDTO {
  id: string;
  name: string;
  code: string | null;
  description_md: string | null;
  contact_id: string | null;
  contact_name: string | null;
  quote_id: string | null;
  status: ProjectStatus;
  starts_on: string | null;
  due_on: string | null;
  budget_minor: number;
  currency: string;
  billing_mode: BillingMode;
  hourly_rate_minor: number;
  owner_member_id: string | null;
  color: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MilestoneDTO {
  id: string;
  project_id: string;
  name: string;
  due_on: string | null;
  status: MilestoneStatus;
  sort: number;
  completed_at: string | null;
  created_at: string;
}

export interface ProjectMemberDTO {
  id: string;
  project_id: string;
  member_user_id: string | null;
  staff_id: string | null;
  role: ProjectMemberRole;
  created_at: string;
}

/** A task as the projects module sees it (Lane A owns due_at/assignee_id/priority). */
export interface ProjectTaskDTO {
  id: string;
  title: string;
  done: boolean;
  project_id: string | null;
  milestone_id: string | null;
  assignee_id: string | null;
  due_at: string | null;
  priority: TaskPriority | null;
  estimate_minutes: number | null;
  sort: number | null;
  depends_on: string[];
  created_at: string;
  /** Joined for "my tasks" views. */
  project_name?: string | null;
  project_color?: string | null;
}

export interface ProjectProgress {
  tasks_total: number;
  tasks_done: number;
  /** 0–100 */
  percent: number;
  overdue_tasks: number;
  milestones_total: number;
  milestones_done: number;
  next_milestone: { id: string; name: string; due_on: string | null } | null;
  /** Calendar days until due_on (negative when late); null without a due date. */
  days_remaining: number | null;
  estimate_minutes_total: number;
  estimate_minutes_remaining: number;
}

export interface ProjectBudget {
  currency: string;
  budget_minor: number;
  time_minutes: number;
  time_minor: number;
  expense_minor: number;
  stock_minor: number;
  actual_minor: number;
  billed_minor: number;
  paid_minor: number;
  remaining_minor: number;
  /** actual / budget × 100 (null when no budget). */
  burn_pct: number | null;
  over_budget: boolean;
}

export interface TimelineItem {
  kind: "milestone" | "task";
  id: string;
  label: string;
  /** YYYY-MM-DD */
  start: string;
  /** YYYY-MM-DD (same as start for a milestone) */
  end: string;
  done: boolean;
  overdue: boolean;
  assignee_id?: string | null;
  milestone_id?: string | null;
}

export interface TimelineData {
  project: { id: string; name: string; starts_on: string | null; due_on: string | null };
  /** Inclusive range covering the project dates and every item. */
  range: { start: string; end: string; days: number };
  today: string;
  items: TimelineItem[];
}

/* ─── Schemas ────────────────────────────────────────────────────────────── */

const Ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD expected");
const Color = z.string().regex(/^#[0-9a-fA-F]{6}$/, "hex colour expected");

export const ProjectInputSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    code: z.string().trim().max(40).nullable().optional(),
    description_md: z.string().max(20_000).nullable().optional(),
    contact_id: z.string().trim().max(100).nullable().optional(),
    quote_id: z.string().trim().max(100).nullable().optional(),
    status: z.enum(PROJECT_STATUSES).default("planning"),
    starts_on: Ymd.nullable().optional(),
    due_on: Ymd.nullable().optional(),
    budget_minor: z.number().int().min(0).max(1_000_000_000_000).default(0),
    currency: CurrencySchema.default("USD"),
    billing_mode: z.enum(BILLING_MODES).default("none"),
    hourly_rate_minor: z.number().int().min(0).max(1_000_000_000).default(0),
    owner_member_id: z.string().trim().max(100).nullable().optional(),
    color: Color.nullable().optional(),
  })
  .strict();
export type ProjectInput = z.infer<typeof ProjectInputSchema>;
export const ProjectPatchSchema = ProjectInputSchema.partial().strict();
export type ProjectPatch = z.infer<typeof ProjectPatchSchema>;

export const MilestoneInputSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    due_on: Ymd.nullable().optional(),
    sort: z.number().int().min(0).max(100_000).optional(),
  })
  .strict();
export type MilestoneInput = z.infer<typeof MilestoneInputSchema>;
export const MilestonePatchSchema = MilestoneInputSchema.partial().extend({ status: z.enum(MILESTONE_STATUSES).optional() }).strict();
export type MilestonePatch = z.infer<typeof MilestonePatchSchema>;

export const ProjectMemberInputSchema = z
  .object({
    member_user_id: z.string().trim().max(100).nullable().optional(),
    staff_id: z.string().trim().max(100).nullable().optional(),
    role: z.enum(PROJECT_MEMBER_ROLES).default("member"),
  })
  .strict()
  .refine((v) => Boolean(v.member_user_id || v.staff_id), { message: "member_user_id or staff_id is required" });
export type ProjectMemberInput = z.infer<typeof ProjectMemberInputSchema>;

export const ProjectTaskInputSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    milestone_id: z.string().trim().max(100).nullable().optional(),
    assignee_id: z.string().trim().max(100).nullable().optional(),
    due_at: z.string().datetime({ offset: true }).nullable().optional(),
    priority: z.enum(TASK_PRIORITIES).nullable().optional(),
    estimate_minutes: z.number().int().min(0).max(100_000).nullable().optional(),
    sort: z.number().int().min(0).max(1_000_000).nullable().optional(),
    depends_on: z.array(z.string().max(100)).max(50).optional(),
  })
  .strict();
export type ProjectTaskInput = z.infer<typeof ProjectTaskInputSchema>;
export const ProjectTaskPatchSchema = ProjectTaskInputSchema.partial().extend({ done: z.boolean().optional(), project_id: z.string().trim().max(100).nullable().optional() }).strict();
export type ProjectTaskPatch = z.infer<typeof ProjectTaskPatchSchema>;

export const FromQuoteSchema = z
  .object({
    quoteId: z.string().trim().min(1).max(100),
    name: z.string().trim().min(1).max(200).optional(),
    /** Create one milestone per quote line item (default true). */
    milestonesFromItems: z.boolean().default(true),
    starts_on: Ymd.nullable().optional(),
    due_on: Ymd.nullable().optional(),
  })
  .strict();
export type FromQuoteInput = z.infer<typeof FromQuoteSchema>;

/* ─── Pure math ──────────────────────────────────────────────────────────── */

export const DAY_MS = 86_400_000;

export function ymd(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d.length === 10 ? `${d}T00:00:00Z` : d) : d;
  return date.toISOString().slice(0, 10);
}

export function addDays(ymdStr: string, n: number): string {
  return new Date(Date.parse(`${ymdStr}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Whole calendar days from `today` to `due` (negative when past). */
export function daysBetween(today: string, due: string): number {
  return Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);
}

export interface ProgressTaskLike {
  done: boolean;
  due_at: string | null;
  estimate_minutes: number | null;
}
export interface ProgressMilestoneLike {
  id: string;
  name: string;
  due_on: string | null;
  status: MilestoneStatus;
  sort: number;
}

/** Pure: progress figures from tasks + milestones at `now`. */
export function computeProgress(
  tasks: readonly ProgressTaskLike[],
  milestones: readonly ProgressMilestoneLike[],
  project: { due_on: string | null },
  now: Date = new Date()
): ProjectProgress {
  const nowMs = now.getTime();
  const total = tasks.length;
  const done = tasks.filter((t) => t.done).length;
  const overdue = tasks.filter((t) => !t.done && t.due_at && Date.parse(t.due_at) < nowMs).length;
  const estTotal = tasks.reduce((s, t) => s + (Number(t.estimate_minutes) || 0), 0);
  const estRemaining = tasks.filter((t) => !t.done).reduce((s, t) => s + (Number(t.estimate_minutes) || 0), 0);
  const open = [...milestones].filter((m) => m.status !== "done").sort((a, b) => {
    if (a.due_on && b.due_on && a.due_on !== b.due_on) return a.due_on < b.due_on ? -1 : 1;
    if (a.due_on && !b.due_on) return -1;
    if (!a.due_on && b.due_on) return 1;
    return a.sort - b.sort;
  });
  const next = open[0] ?? null;
  return {
    tasks_total: total,
    tasks_done: done,
    percent: total === 0 ? 0 : Math.round((done / total) * 100),
    overdue_tasks: overdue,
    milestones_total: milestones.length,
    milestones_done: milestones.filter((m) => m.status === "done").length,
    next_milestone: next ? { id: next.id, name: next.name, due_on: next.due_on } : null,
    days_remaining: project.due_on ? daysBetween(ymd(now), project.due_on) : null,
    estimate_minutes_total: estTotal,
    estimate_minutes_remaining: estRemaining,
  };
}

export interface BudgetInputs {
  budget_minor: number;
  currency: string;
  time_minutes: number;
  time_minor: number;
  expense_minor: number;
  stock_minor: number;
  billed_minor: number;
  paid_minor: number;
}

/** Pure: budget vs actual and burn. */
export function computeBudget(i: BudgetInputs): ProjectBudget {
  const actual = Math.round(i.time_minor + i.expense_minor + i.stock_minor);
  const budget = Math.round(i.budget_minor);
  return {
    currency: i.currency,
    budget_minor: budget,
    time_minutes: Math.round(i.time_minutes),
    time_minor: Math.round(i.time_minor),
    expense_minor: Math.round(i.expense_minor),
    stock_minor: Math.round(i.stock_minor),
    actual_minor: actual,
    billed_minor: Math.round(i.billed_minor),
    paid_minor: Math.round(i.paid_minor),
    remaining_minor: budget - actual,
    burn_pct: budget > 0 ? Math.round((actual / budget) * 1000) / 10 : null,
    over_budget: budget > 0 && actual > budget,
  };
}

export interface TimelineTaskLike {
  id: string;
  title: string;
  done: boolean;
  due_at: string | null;
  created_at: string;
  estimate_minutes: number | null;
  assignee_id: string | null;
  milestone_id: string | null;
}

/**
 * Pure: Gantt-lite items. A task spans from max(project start, created) to
 * its due date (or a single day without one); a milestone is a one-day diamond.
 * The range is padded to include every item and today.
 */
export function buildTimeline(
  project: { id: string; name: string; starts_on: string | null; due_on: string | null },
  milestones: readonly ProgressMilestoneLike[],
  tasks: readonly TimelineTaskLike[],
  now: Date = new Date()
): TimelineData {
  const today = ymd(now);
  const items: TimelineItem[] = [];
  for (const m of milestones) {
    const day = m.due_on ?? project.due_on ?? today;
    items.push({ kind: "milestone", id: m.id, label: m.name, start: day, end: day, done: m.status === "done", overdue: m.status !== "done" && day < today });
  }
  for (const t of tasks) {
    const created = ymd(t.created_at);
    const due = t.due_at ? ymd(t.due_at) : null;
    let start = project.starts_on && project.starts_on > created ? project.starts_on : created;
    const end = due ?? start;
    if (start > end) start = end;
    items.push({ kind: "task", id: t.id, label: t.title, start, end, done: t.done, overdue: !t.done && Boolean(due) && (due as string) < today, assignee_id: t.assignee_id, milestone_id: t.milestone_id });
  }
  let start = project.starts_on ?? today;
  let end = project.due_on ?? today;
  for (const it of items) {
    if (it.start < start) start = it.start;
    if (it.end > end) end = it.end;
  }
  if (today < start) start = today;
  if (today > end) end = today;
  // Pad a little so bars never touch the edge; keep at least two weeks.
  start = addDays(start, -1);
  end = addDays(end, 1);
  if (daysBetween(start, end) < 14) end = addDays(start, 14);
  items.sort((a, b) => (a.start === b.start ? (a.kind === b.kind ? a.label.localeCompare(b.label) : a.kind === "milestone" ? -1 : 1) : a.start < b.start ? -1 : 1));
  return { project, range: { start, end, days: daysBetween(start, end) + 1 }, today, items };
}

/** Pure: week buckets (Monday-start, UTC) covering a timeline range — the Gantt header. */
export function weekBuckets(range: { start: string; end: string }): Array<{ start: string; end: string; label: string; days: number }> {
  const first = new Date(`${range.start}T00:00:00Z`);
  const dow = (first.getUTCDay() + 6) % 7;
  let cursor = addDays(range.start, -dow);
  const out: Array<{ start: string; end: string; label: string; days: number }> = [];
  while (cursor <= range.end) {
    const next = addDays(cursor, 7);
    const s = cursor < range.start ? range.start : cursor;
    const e = addDays(next, -1) > range.end ? range.end : addDays(next, -1);
    const d = new Date(`${cursor}T00:00:00Z`);
    out.push({ start: s, end: e, label: `${d.toLocaleString("en-US", { month: "short", timeZone: "UTC" })} ${d.getUTCDate()}`, days: daysBetween(s, e) + 1 });
    cursor = next;
  }
  return out;
}

export interface QuoteLike {
  id: string;
  number: string;
  contact_id: string | null;
  contact_name: string | null;
  currency: string;
  total_minor: number;
  items: ReadonlyArray<{ description: string; qty?: number; quantity?: number }>;
}

/** Pure: project + milestone inputs derived from a quote. */
export function mapQuoteToProject(q: QuoteLike, opts: { name?: string; milestonesFromItems?: boolean; starts_on?: string | null; due_on?: string | null } = {}): {
  project: ProjectInput;
  milestones: MilestoneInput[];
} {
  const name = (opts.name ?? (q.contact_name ? `${q.contact_name} — ${q.number}` : `Project ${q.number}`)).slice(0, 200);
  const project: ProjectInput = {
    name,
    code: q.number.slice(0, 40),
    description_md: null,
    contact_id: q.contact_id,
    quote_id: q.id,
    status: "planning",
    starts_on: opts.starts_on ?? null,
    due_on: opts.due_on ?? null,
    budget_minor: Math.max(0, Math.round(q.total_minor)),
    currency: q.currency,
    billing_mode: "fixed",
    hourly_rate_minor: 0,
    owner_member_id: null,
    color: null,
  };
  const milestones: MilestoneInput[] = [];
  if (opts.milestonesFromItems !== false) {
    const seen = new Set<string>();
    q.items.forEach((it, i) => {
      const label = String(it.description ?? "").trim().slice(0, 200);
      if (!label || seen.has(label.toLowerCase())) return;
      seen.add(label.toLowerCase());
      milestones.push({ name: label, due_on: null, sort: i });
    });
  }
  return { project, milestones };
}

export function parseDependsOn(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 50) : [];
  } catch {
    return [];
  }
}

export const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = { planning: "Planning", active: "Active", on_hold: "On hold", done: "Done", cancelled: "Cancelled" };
