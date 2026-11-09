import { randomUUID } from "crypto";
import { z } from "zod";
import { query, queryOne } from "@/lib/dsql";
import { ROLES, type Role } from "@/lib/auth/roles";
import { getOrgSettings } from "@/lib/org-settings";
import { ChartConfigSchema, ReportSpecSchema, type ChartConfig, type ReportSpec } from "./spec";
import { CADENCES, nextRunAt, type Cadence } from "./schedule";

/** Saved reports, schedules and dashboards (CRUD keyed by org data id). */

/* ─── saved reports ─────────────────────────────────────────────────────── */

export interface SavedReportRow {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  spec: string;
  chart: string | null;
  visibility: "private" | "org";
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface SavedReport {
  id: string;
  name: string;
  description: string | null;
  spec: ReportSpec;
  chart: ChartConfig;
  visibility: "private" | "org";
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

export function parseSpec(raw: string): ReportSpec | null {
  try {
    const r = ReportSpecSchema.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

export function parseChart(raw: string | null): ChartConfig {
  if (!raw) return { type: "table" };
  try {
    const r = ChartConfigSchema.safeParse(JSON.parse(raw));
    return r.success ? r.data : { type: "table" };
  } catch {
    return { type: "table" };
  }
}

export function toSavedReport(row: SavedReportRow): SavedReport {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    spec: parseSpec(row.spec) ?? { dataset: "contacts", filters: [], group_by: [], measures: [] },
    chart: parseChart(row.chart),
    visibility: row.visibility === "private" ? "private" : "org",
    created_by: row.created_by,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

export const SavedReportInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().max(1000).optional().nullable(),
    spec: ReportSpecSchema,
    chart: ChartConfigSchema.optional(),
    visibility: z.enum(["private", "org"]).optional(),
  })
  .strict();
export type SavedReportInput = z.infer<typeof SavedReportInputSchema>;
export const SavedReportPatchSchema = SavedReportInputSchema.partial();

/** Private reports are only visible to their author. */
const VISIBLE = `(visibility = 'org' OR created_by = $2)`;

export async function listSavedReports(dataId: string, actorId: string, limit = 200): Promise<SavedReport[]> {
  const rows = await query<SavedReportRow>(`SELECT * FROM saved_reports WHERE user_id = $1 AND ${VISIBLE} ORDER BY updated_at DESC LIMIT $3`, [dataId, actorId, Math.min(500, Math.max(1, limit))]);
  return rows.map(toSavedReport);
}

export async function getSavedReport(dataId: string, actorId: string, id: string): Promise<SavedReport | null> {
  const row = await queryOne<SavedReportRow>(`SELECT * FROM saved_reports WHERE user_id = $1 AND ${VISIBLE} AND id = $3`, [dataId, actorId, id]);
  return row ? toSavedReport(row) : null;
}

/** Used by schedules/digests: no actor visibility filter (the schedule's creator already had access). */
export async function getSavedReportById(dataId: string, id: string): Promise<SavedReport | null> {
  const row = await queryOne<SavedReportRow>(`SELECT * FROM saved_reports WHERE user_id = $1 AND id = $2`, [dataId, id]);
  return row ? toSavedReport(row) : null;
}

export async function createSavedReport(dataId: string, actorId: string, input: SavedReportInput): Promise<SavedReport> {
  const id = randomUUID();
  const row = await queryOne<SavedReportRow>(
    `INSERT INTO saved_reports (id, user_id, name, description, spec, chart, visibility, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW()) RETURNING *`,
    [id, dataId, input.name, input.description ?? null, JSON.stringify(input.spec), JSON.stringify(input.chart ?? { type: "table" }), input.visibility ?? "org", actorId]
  );
  if (!row) throw new Error("insert failed");
  return toSavedReport(row);
}

export async function updateSavedReport(dataId: string, actorId: string, id: string, patch: Partial<SavedReportInput>): Promise<SavedReport | null> {
  const current = await getSavedReport(dataId, actorId, id);
  if (!current) return null;
  const row = await queryOne<SavedReportRow>(
    `UPDATE saved_reports SET name = $3, description = $4, spec = $5, chart = $6, visibility = $7, updated_at = NOW() WHERE user_id = $1 AND id = $2 RETURNING *`,
    [dataId, id, patch.name ?? current.name, patch.description === undefined ? current.description : patch.description, JSON.stringify(patch.spec ?? current.spec), JSON.stringify(patch.chart ?? current.chart), patch.visibility ?? current.visibility]
  );
  return row ? toSavedReport(row) : null;
}

export async function deleteSavedReport(dataId: string, actorId: string, id: string): Promise<boolean> {
  const current = await getSavedReport(dataId, actorId, id);
  if (!current) return false;
  await query(`DELETE FROM report_schedules WHERE user_id = $1 AND report_id = $2`, [dataId, id]);
  await query(`DELETE FROM saved_reports WHERE user_id = $1 AND id = $2`, [dataId, id]);
  return true;
}

/* ─── schedules ─────────────────────────────────────────────────────────── */

export type ScheduleFormat = "csv" | "pdf" | "inline";

export interface ReportScheduleRow {
  id: string;
  user_id: string;
  report_id: string;
  cadence: Cadence;
  hour: number;
  weekday: number | null;
  day_of_month: number | null;
  recipients: string;
  format: ScheduleFormat;
  enabled: boolean;
  last_sent_at: string | null;
  next_run_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReportSchedule extends Omit<ReportScheduleRow, "recipients" | "user_id" | "last_sent_at" | "next_run_at" | "created_at" | "updated_at"> {
  recipients: string[];
  last_sent_at: string | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export function toSchedule(row: ReportScheduleRow): ReportSchedule {
  let recipients: string[] = [];
  try {
    const v = JSON.parse(row.recipients) as unknown;
    if (Array.isArray(v)) recipients = v.filter((x): x is string => typeof x === "string");
  } catch {
    /* empty */
  }
  return {
    id: row.id,
    report_id: row.report_id,
    cadence: CADENCES.includes(row.cadence) ? row.cadence : "weekly",
    hour: Number(row.hour ?? 8),
    weekday: row.weekday === null ? null : Number(row.weekday),
    day_of_month: row.day_of_month === null ? null : Number(row.day_of_month),
    recipients,
    format: row.format === "csv" || row.format === "pdf" ? row.format : "inline",
    enabled: Boolean(row.enabled),
    last_sent_at: row.last_sent_at ? iso(row.last_sent_at) : null,
    next_run_at: row.next_run_at ? iso(row.next_run_at) : null,
    created_by: row.created_by,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

export const ScheduleInputSchema = z
  .object({
    report_id: z.string().min(1).max(100),
    cadence: z.enum(["daily", "weekly", "monthly"]).default("weekly"),
    hour: z.number().int().min(0).max(23).default(8),
    weekday: z.number().int().min(0).max(6).optional().nullable(),
    day_of_month: z.number().int().min(1).max(28).optional().nullable(),
    recipients: z.array(z.string().trim().email().max(200)).min(1).max(20),
    format: z.enum(["csv", "pdf", "inline"]).default("inline"),
    enabled: z.boolean().optional(),
  })
  .strict();
export type ScheduleInput = z.infer<typeof ScheduleInputSchema>;
export const SchedulePatchSchema = ScheduleInputSchema.partial().omit({ report_id: true });

export async function listSchedules(dataId: string, reportId?: string | null): Promise<ReportSchedule[]> {
  const rows = reportId
    ? await query<ReportScheduleRow>(`SELECT * FROM report_schedules WHERE user_id = $1 AND report_id = $2 ORDER BY created_at DESC LIMIT 200`, [dataId, reportId])
    : await query<ReportScheduleRow>(`SELECT * FROM report_schedules WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200`, [dataId]);
  return rows.map(toSchedule);
}

export async function getSchedule(dataId: string, id: string): Promise<ReportSchedule | null> {
  const row = await queryOne<ReportScheduleRow>(`SELECT * FROM report_schedules WHERE user_id = $1 AND id = $2`, [dataId, id]);
  return row ? toSchedule(row) : null;
}

export async function createSchedule(dataId: string, actorId: string, input: ScheduleInput, now = new Date()): Promise<ReportSchedule> {
  const tz = (await getOrgSettings(dataId).catch(() => null))?.timezone ?? "UTC";
  const next = nextRunAt({ cadence: input.cadence, hour: input.hour, weekday: input.weekday, dayOfMonth: input.day_of_month }, now, tz);
  const id = randomUUID();
  const row = await queryOne<ReportScheduleRow>(
    `INSERT INTO report_schedules (id, user_id, report_id, cadence, hour, weekday, day_of_month, recipients, format, enabled, next_run_at, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW()) RETURNING *`,
    [id, dataId, input.report_id, input.cadence, input.hour, input.weekday ?? null, input.day_of_month ?? null, JSON.stringify(input.recipients), input.format, input.enabled ?? true, next.toISOString(), actorId]
  );
  if (!row) throw new Error("insert failed");
  return toSchedule(row);
}

export async function updateSchedule(dataId: string, id: string, patch: z.infer<typeof SchedulePatchSchema>, now = new Date()): Promise<ReportSchedule | null> {
  const cur = await getSchedule(dataId, id);
  if (!cur) return null;
  const merged = { ...cur, ...patch };
  const tz = (await getOrgSettings(dataId).catch(() => null))?.timezone ?? "UTC";
  const next = nextRunAt({ cadence: merged.cadence, hour: merged.hour, weekday: merged.weekday, dayOfMonth: merged.day_of_month }, now, tz);
  const row = await queryOne<ReportScheduleRow>(
    `UPDATE report_schedules SET cadence = $3, hour = $4, weekday = $5, day_of_month = $6, recipients = $7, format = $8, enabled = $9, next_run_at = $10, updated_at = NOW() WHERE user_id = $1 AND id = $2 RETURNING *`,
    [dataId, id, merged.cadence, merged.hour, merged.weekday ?? null, merged.day_of_month ?? null, JSON.stringify(merged.recipients), merged.format, merged.enabled, next.toISOString()]
  );
  return row ? toSchedule(row) : null;
}

export async function deleteSchedule(dataId: string, id: string): Promise<boolean> {
  const rows = await query<{ id: string }>(`DELETE FROM report_schedules WHERE user_id = $1 AND id = $2 RETURNING id`, [dataId, id]);
  return rows.length > 0;
}

/* ─── dashboards ────────────────────────────────────────────────────────── */

export const BUILTIN_WIDGETS = ["kpis", "needs_you", "job_costing", "agency_rollup", "cashflow"] as const;
export type BuiltinWidget = (typeof BUILTIN_WIDGETS)[number];

export const LayoutItemSchema = z
  .object({
    report_id: z.string().min(1).max(100).optional().nullable(),
    builtin: z.enum(BUILTIN_WIDGETS).optional().nullable(),
    x: z.number().int().min(0).max(11).default(0),
    y: z.number().int().min(0).max(999).default(0),
    w: z.number().int().min(1).max(12).default(6),
    h: z.number().int().min(1).max(6).default(2),
  })
  .strict()
  .refine((i) => Boolean(i.report_id) !== Boolean(i.builtin), "layout item needs report_id or builtin");
export type LayoutItem = z.infer<typeof LayoutItemSchema>;

export const DashboardInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    role: z.enum(ROLES).optional().nullable(),
    layout: z.array(LayoutItemSchema).max(40).default([]),
    is_default: z.boolean().optional(),
  })
  .strict();
export type DashboardInput = z.infer<typeof DashboardInputSchema>;
export const DashboardPatchSchema = DashboardInputSchema.partial();

export interface DashboardRow {
  id: string;
  user_id: string;
  name: string;
  role: string | null;
  layout: string;
  is_default: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface Dashboard {
  id: string;
  name: string;
  role: Role | null;
  layout: LayoutItem[];
  is_default: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export function parseLayout(raw: string): LayoutItem[] {
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v.map((i) => LayoutItemSchema.safeParse(i)).filter((r) => r.success).map((r) => (r as { data: LayoutItem }).data);
  } catch {
    return [];
  }
}

export function toDashboard(row: DashboardRow): Dashboard {
  return {
    id: row.id,
    name: row.name,
    role: (ROLES as readonly string[]).includes(row.role ?? "") ? (row.role as Role) : null,
    layout: parseLayout(row.layout),
    is_default: Boolean(row.is_default),
    created_by: row.created_by,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

/** Starter layout when a role has no default yet (not persisted). */
export function starterDashboard(role: Role): Dashboard {
  const layout: LayoutItem[] = [{ builtin: "kpis", x: 0, y: 0, w: 12, h: 1 }, { builtin: "needs_you", x: 0, y: 1, w: 6, h: 2 }];
  if (role === "owner" || role === "admin" || role === "manager") layout.push({ builtin: "job_costing", x: 6, y: 1, w: 6, h: 2 }, { builtin: "cashflow", x: 0, y: 3, w: 12, h: 2 });
  return { id: "", name: `${role.replace(/^\w/, (c) => c.toUpperCase())} dashboard`, role, layout, is_default: true, created_by: null, created_at: "", updated_at: "" };
}

export async function listDashboards(dataId: string): Promise<Dashboard[]> {
  const rows = await query<DashboardRow>(`SELECT * FROM dashboards WHERE user_id = $1 ORDER BY is_default DESC, updated_at DESC LIMIT 100`, [dataId]);
  return rows.map(toDashboard);
}

export async function getDashboard(dataId: string, id: string): Promise<Dashboard | null> {
  const row = await queryOne<DashboardRow>(`SELECT * FROM dashboards WHERE user_id = $1 AND id = $2`, [dataId, id]);
  return row ? toDashboard(row) : null;
}

/** The default dashboard for a role (null when none has been saved). */
export async function defaultDashboardForRole(dataId: string, role: Role): Promise<Dashboard | null> {
  const row = await queryOne<DashboardRow>(`SELECT * FROM dashboards WHERE user_id = $1 AND role = $2 AND is_default = TRUE ORDER BY updated_at DESC LIMIT 1`, [dataId, role]);
  return row ? toDashboard(row) : null;
}

export async function createDashboard(dataId: string, actorId: string, input: DashboardInput): Promise<Dashboard> {
  const id = randomUUID();
  if (input.is_default && input.role) await query(`UPDATE dashboards SET is_default = FALSE WHERE user_id = $1 AND role = $2 AND is_default = TRUE`, [dataId, input.role]);
  const row = await queryOne<DashboardRow>(
    `INSERT INTO dashboards (id, user_id, name, role, layout, is_default, created_by, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW()) RETURNING *`,
    [id, dataId, input.name, input.role ?? null, JSON.stringify(input.layout), Boolean(input.is_default && input.role), actorId]
  );
  if (!row) throw new Error("insert failed");
  return toDashboard(row);
}

export async function updateDashboard(dataId: string, id: string, patch: Partial<DashboardInput>): Promise<Dashboard | null> {
  const cur = await getDashboard(dataId, id);
  if (!cur) return null;
  const role = patch.role === undefined ? cur.role : patch.role;
  const isDefault = Boolean((patch.is_default ?? cur.is_default) && role);
  if (isDefault && role) await query(`UPDATE dashboards SET is_default = FALSE WHERE user_id = $1 AND role = $2 AND is_default = TRUE AND id <> $3`, [dataId, role, id]);
  const row = await queryOne<DashboardRow>(
    `UPDATE dashboards SET name = $3, role = $4, layout = $5, is_default = $6, updated_at = NOW() WHERE user_id = $1 AND id = $2 RETURNING *`,
    [dataId, id, patch.name ?? cur.name, role, JSON.stringify(patch.layout ?? cur.layout), isDefault]
  );
  return row ? toDashboard(row) : null;
}

export async function deleteDashboard(dataId: string, id: string): Promise<boolean> {
  const rows = await query<{ id: string }>(`DELETE FROM dashboards WHERE user_id = $1 AND id = $2 RETURNING id`, [dataId, id]);
  return rows.length > 0;
}
