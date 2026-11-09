import { randomUUID } from "crypto";
import { z } from "zod";
import { query, queryOne } from "@/lib/dsql";
import { CurrencySchema } from "@/lib/money/items";
import { EMPLOYMENT_TYPES, parseSkills, type StaffDTO } from "./pure";

/** Staff profiles: people on the rota. A profile may have no login (field crew) — `membership_id` links it to a seat when it does. */

export class WorkforceError extends Error {
  constructor(public readonly status: number, message: string, public readonly details?: unknown) {
    super(message);
    this.name = "WorkforceError";
  }
}

export interface StaffRow {
  id: string;
  user_id: string;
  membership_id: string | null;
  display_name: string;
  email: string | null;
  phone: string | null;
  role_title: string | null;
  employment_type: string;
  hourly_rate_minor: string | number;
  currency: string;
  weekly_hours: number;
  skills: string | null;
  location: string | null;
  start_date: string | Date | null;
  end_date: string | Date | null;
  active: boolean;
  created_at: string | Date;
  updated_at: string | Date;
}

export const STAFF_COLS = `id, user_id, membership_id, display_name, email, phone, role_title, employment_type, hourly_rate_minor, currency, weekly_hours, skills, location, start_date::text AS start_date, end_date::text AS end_date, active, created_at, updated_at`;

const iso = (v: string | Date) => new Date(v).toISOString();
const ymd = (v: string | Date | null) => (v === null ? null : typeof v === "string" ? v.slice(0, 10) : v.toISOString().slice(0, 10));

export function toStaffDTO(r: StaffRow): StaffDTO {
  return {
    id: r.id,
    membership_id: r.membership_id,
    display_name: r.display_name,
    email: r.email,
    phone: r.phone,
    role_title: r.role_title,
    employment_type: (EMPLOYMENT_TYPES as readonly string[]).includes(r.employment_type) ? (r.employment_type as StaffDTO["employment_type"]) : "full_time",
    hourly_rate_minor: Number(r.hourly_rate_minor) || 0,
    currency: r.currency,
    weekly_hours: Number(r.weekly_hours) || 0,
    skills: parseSkills(r.skills),
    location: r.location,
    start_date: ymd(r.start_date),
    end_date: ymd(r.end_date),
    active: Boolean(r.active),
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  };
}

const Ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

export const StaffInputSchema = z
  .object({
    display_name: z.string().trim().min(1).max(120),
    email: z.string().trim().email().max(320).nullable().optional(),
    phone: z.string().trim().max(40).nullable().optional(),
    role_title: z.string().trim().max(80).nullable().optional(),
    employment_type: z.enum(EMPLOYMENT_TYPES).default("full_time"),
    hourly_rate_minor: z.number().int().min(0).max(1_000_000_000).default(0),
    currency: CurrencySchema.default("USD"),
    weekly_hours: z.number().int().min(0).max(168).default(40),
    skills: z.array(z.string().trim().min(1).max(40)).max(50).default([]),
    location: z.string().trim().max(120).nullable().optional(),
    start_date: Ymd.nullable().optional(),
    end_date: Ymd.nullable().optional(),
    membership_id: z.string().trim().max(100).nullable().optional(),
    active: z.boolean().default(true),
  })
  .strict();
export type StaffInput = z.infer<typeof StaffInputSchema>;
export const StaffPatchSchema = StaffInputSchema.partial().strict();
export type StaffPatch = z.infer<typeof StaffPatchSchema>;

export async function listStaff(dataId: string, opts: { includeInactive?: boolean; limit?: number } = {}): Promise<StaffDTO[]> {
  const rows = await query<StaffRow>(
    `SELECT ${STAFF_COLS} FROM staff_profiles WHERE user_id = $1 ${opts.includeInactive ? "" : "AND active = TRUE"} ORDER BY display_name ASC, created_at ASC LIMIT $2`,
    [dataId, Math.min(Math.max(opts.limit ?? 500, 1), 1000)]
  );
  return rows.map(toStaffDTO);
}

export async function getStaff(dataId: string, id: string): Promise<StaffDTO | null> {
  const row = await queryOne<StaffRow>(`SELECT ${STAFF_COLS} FROM staff_profiles WHERE user_id = $1 AND id = $2`, [dataId, id]);
  return row ? toStaffDTO(row) : null;
}

/** Map of staff id → display name for the given ids (used to decorate shifts/leave). */
export async function staffNames(dataId: string, ids: Iterable<string | null | undefined>): Promise<Map<string, string>> {
  const unique = [...new Set([...ids].filter((x): x is string => Boolean(x)))];
  if (unique.length === 0) return new Map();
  const rows = await query<{ id: string; display_name: string }>(`SELECT id, display_name FROM staff_profiles WHERE user_id = $1 AND id = ANY($2)`, [dataId, unique]);
  return new Map(rows.map((r) => [r.id, r.display_name]));
}

async function assertMembership(dataId: string, membershipId: string | null | undefined): Promise<void> {
  if (!membershipId) return;
  const row = await queryOne<{ id: string }>(
    `SELECT m.id FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE m.id = $1 AND o.owner_user_id = $2 AND m.status = 'active'`,
    [membershipId, dataId]
  );
  if (!row) throw new WorkforceError(400, "membership_id does not belong to this workspace");
}

export async function createStaff(dataId: string, input: StaffInput): Promise<StaffDTO> {
  if (input.start_date && input.end_date && input.end_date < input.start_date) throw new WorkforceError(400, "end_date must not be before start_date");
  await assertMembership(dataId, input.membership_id);
  const id = randomUUID();
  await query(
    `INSERT INTO staff_profiles (id, user_id, membership_id, display_name, email, phone, role_title, employment_type, hourly_rate_minor, currency, weekly_hours, skills, location, start_date, end_date, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
    [
      id,
      dataId,
      input.membership_id ?? null,
      input.display_name,
      input.email?.toLowerCase() ?? null,
      input.phone ?? null,
      input.role_title ?? null,
      input.employment_type,
      input.hourly_rate_minor,
      input.currency,
      input.weekly_hours,
      JSON.stringify(input.skills),
      input.location ?? null,
      input.start_date ?? null,
      input.end_date ?? null,
      input.active,
    ]
  );
  const created = await getStaff(dataId, id);
  if (!created) throw new WorkforceError(500, "staff profile not found after insert");
  return created;
}

export async function updateStaff(dataId: string, id: string, patch: StaffPatch): Promise<StaffDTO> {
  const existing = await getStaff(dataId, id);
  if (!existing) throw new WorkforceError(404, "Staff profile not found");
  if (patch.membership_id !== undefined) await assertMembership(dataId, patch.membership_id);
  const next = { ...existing, ...patch, email: patch.email === undefined ? existing.email : patch.email?.toLowerCase() ?? null };
  if (next.start_date && next.end_date && next.end_date < next.start_date) throw new WorkforceError(400, "end_date must not be before start_date");
  await query(
    `UPDATE staff_profiles SET membership_id = $3, display_name = $4, email = $5, phone = $6, role_title = $7, employment_type = $8, hourly_rate_minor = $9, currency = $10,
        weekly_hours = $11, skills = $12, location = $13, start_date = $14, end_date = $15, active = $16, updated_at = NOW()
      WHERE user_id = $1 AND id = $2`,
    [
      dataId,
      id,
      next.membership_id ?? null,
      next.display_name,
      next.email,
      next.phone ?? null,
      next.role_title ?? null,
      next.employment_type,
      next.hourly_rate_minor,
      next.currency,
      next.weekly_hours,
      JSON.stringify(next.skills),
      next.location ?? null,
      next.start_date ?? null,
      next.end_date ?? null,
      next.active,
    ]
  );
  const updated = await getStaff(dataId, id);
  if (!updated) throw new WorkforceError(404, "Staff profile not found");
  return updated;
}

/** Soft-deactivate: keeps history (shifts, attendance, payroll) intact. */
export async function deactivateStaff(dataId: string, id: string): Promise<boolean> {
  const rows = await query<{ id: string }>(`UPDATE staff_profiles SET active = FALSE, updated_at = NOW() WHERE user_id = $1 AND id = $2 RETURNING id`, [dataId, id]);
  return rows.length > 0;
}

/** Staff profile linked to a crew share token (share_tokens.staff_id), or null. */
export async function staffForShareToken(dataId: string, tokenId: string): Promise<StaffDTO | null> {
  const link = await queryOne<{ staff_id: string | null }>(`SELECT staff_id FROM share_tokens WHERE id = $1 AND user_id = $2`, [tokenId, dataId]).catch(() => null);
  if (!link?.staff_id) return null;
  return getStaff(dataId, link.staff_id);
}
