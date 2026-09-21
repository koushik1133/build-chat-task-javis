import { z } from "zod";
import { query, queryOne } from "@/lib/dsql";
import { registerTool } from "@/lib/agents/registry";
import { emitEvent } from "@/lib/events/bus";
import type { ToolResult } from "@/lib/agents/types";

/** CRM tools: contacts + activity log. Every query is scoped to ctx.userId. */

const LIFECYCLES = ["lead", "prospect", "customer", "churned", "donor", "patient", "student"] as const;

const CONTACT_COLS =
  "id, full_name, email, phone, company, role, tags, lifecycle, notes, last_contact, deal_value, created_at, updated_at";

interface ContactRow {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  role: string | null;
  tags: string | null;
  lifecycle: string;
  notes: string | null;
  last_contact: string | null;
  deal_value: string | number | null;
  created_at: string;
  updated_at: string;
}

function fail(error: string): ToolResult {
  return { ok: false, summary: error, error };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* ---------- crm.search_contacts ---------- */
const SearchInput = z.object({
  query: z.string().max(200).optional(),
  lifecycle: z.enum(LIFECYCLES).optional(),
});
type SearchInputT = z.infer<typeof SearchInput>;

registerTool<SearchInputT>({
  name: "crm.search_contacts",
  module: "crm",
  description: "Search CRM contacts by name, email or company, optionally filtered by lifecycle stage. Returns up to 25.",
  input: SearchInput,
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Free-text match on name, email or company" },
      lifecycle: { type: "string", enum: [...LIFECYCLES] },
    },
  },
  scope: "read",
  preview: (i) => `Search contacts${i.query ? ` for "${i.query}"` : ""}${i.lifecycle ? ` (${i.lifecycle})` : ""}`,
  async run(ctx, input) {
    try {
      const params: unknown[] = [ctx.userId];
      let sql = `SELECT ${CONTACT_COLS} FROM crm_contacts WHERE user_id = $1`;
      if (input.lifecycle) {
        params.push(input.lifecycle);
        sql += ` AND lifecycle = $${params.length}`;
      }
      if (input.query?.trim()) {
        params.push(`%${input.query.trim()}%`);
        const i = params.length;
        sql += ` AND (full_name ILIKE $${i} OR email ILIKE $${i} OR company ILIKE $${i})`;
      }
      sql += ` ORDER BY updated_at DESC LIMIT 25`;
      const rows = await query<ContactRow>(sql, params);
      return { ok: true, data: rows, summary: `Found ${rows.length} contact(s)` };
    } catch (err) {
      return fail(`Search failed: ${errMsg(err)}`);
    }
  },
});

/* ---------- crm.get_contact ---------- */
const GetInput = z.object({ id: z.string().min(1) });
type GetInputT = z.infer<typeof GetInput>;

registerTool<GetInputT>({
  name: "crm.get_contact",
  module: "crm",
  description: "Fetch one CRM contact by id, with its 10 most recent activities.",
  input: GetInput,
  parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  scope: "read",
  preview: (i) => `Get contact ${i.id}`,
  async run(ctx, input) {
    try {
      const contact = await queryOne<ContactRow>(
        `SELECT ${CONTACT_COLS} FROM crm_contacts WHERE id = $1 AND user_id = $2`,
        [input.id, ctx.userId]
      );
      if (!contact) return fail("Contact not found");
      const activities = await query(
        `SELECT id, type, title, body, created_at FROM crm_activities
         WHERE contact_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 10`,
        [input.id, ctx.userId]
      ).catch(() => []);
      return { ok: true, data: { ...contact, activities }, summary: `Contact ${contact.full_name}` };
    } catch (err) {
      return fail(`Lookup failed: ${errMsg(err)}`);
    }
  },
});

/* ---------- crm.create_contact ---------- */
const CreateInput = z.object({
  full_name: z.string().min(1).max(200),
  email: z.string().email().max(200).optional(),
  company: z.string().max(200).optional(),
  role: z.string().max(120).optional(),
  lifecycle: z.enum(LIFECYCLES).optional(),
  deal_value: z.number().min(0).optional(),
  notes: z.string().max(4000).optional(),
});
type CreateInputT = z.infer<typeof CreateInput>;

registerTool<CreateInputT>({
  name: "crm.create_contact",
  module: "crm",
  description: "Create a new CRM contact.",
  input: CreateInput,
  parameters: {
    type: "object",
    properties: {
      full_name: { type: "string" },
      email: { type: "string" },
      company: { type: "string" },
      role: { type: "string" },
      lifecycle: { type: "string", enum: [...LIFECYCLES] },
      deal_value: { type: "number" },
      notes: { type: "string" },
    },
    required: ["full_name"],
  },
  scope: "write",
  requiresApproval: false,
  preview: (i) => `Create contact "${i.full_name}"${i.company ? ` at ${i.company}` : ""}`,
  async run(ctx, input) {
    try {
      const row = await queryOne<ContactRow>(
        `INSERT INTO crm_contacts (user_id, full_name, email, company, role, lifecycle, deal_value, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${CONTACT_COLS}`,
        [
          ctx.userId,
          input.full_name.trim(),
          input.email ?? null,
          input.company ?? null,
          input.role ?? null,
          input.lifecycle ?? "lead",
          input.deal_value ?? 0,
          input.notes ?? null,
        ]
      );
      if (!row) return fail("Insert returned no row");
      void emitEvent(ctx.userId, { type: "crm.contact.created", entity: "crm_contact", entityId: row.id, data: { source: "tool" } });
      return { ok: true, data: row, summary: `Created contact ${row.full_name} (${row.id})` };
    } catch (err) {
      return fail(`Create failed: ${errMsg(err)}`);
    }
  },
});

/* ---------- crm.update_contact ---------- */
const UpdateInput = z.object({
  id: z.string().min(1),
  full_name: z.string().min(1).max(200).optional(),
  email: z.string().email().max(200).nullable().optional(),
  phone: z.string().max(60).nullable().optional(),
  company: z.string().max(200).nullable().optional(),
  role: z.string().max(120).nullable().optional(),
  lifecycle: z.enum(LIFECYCLES).optional(),
  deal_value: z.number().min(0).optional(),
  notes: z.string().max(4000).nullable().optional(),
});
type UpdateInputT = z.infer<typeof UpdateInput>;

registerTool<UpdateInputT>({
  name: "crm.update_contact",
  module: "crm",
  description: "Update fields on an existing CRM contact (partial update).",
  input: UpdateInput,
  parameters: {
    type: "object",
    properties: {
      id: { type: "string" },
      full_name: { type: "string" },
      email: { type: "string" },
      phone: { type: "string" },
      company: { type: "string" },
      role: { type: "string" },
      lifecycle: { type: "string", enum: [...LIFECYCLES] },
      deal_value: { type: "number" },
      notes: { type: "string" },
    },
    required: ["id"],
  },
  scope: "write",
  requiresApproval: false,
  preview: (i) => {
    const { id, ...rest } = i;
    return `Update contact ${id}: ${Object.keys(rest).join(", ") || "no fields"}`;
  },
  async run(ctx, input) {
    try {
      const { id, ...rest } = input;
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(rest)) {
        if (v === undefined) continue;
        vals.push(v);
        sets.push(`${k} = $${vals.length}`);
      }
      if (sets.length === 0) return fail("No fields to update");
      const prev = await queryOne<{ lifecycle: string }>(
        `SELECT lifecycle FROM crm_contacts WHERE id = $1 AND user_id = $2`,
        [id, ctx.userId]
      );
      if (!prev) return fail("Contact not found");
      vals.push(id, ctx.userId);
      const row = await queryOne<ContactRow>(
        `UPDATE crm_contacts SET ${sets.join(", ")}, updated_at = NOW()
         WHERE id = $${vals.length - 1} AND user_id = $${vals.length} RETURNING ${CONTACT_COLS}`,
        vals
      );
      if (!row) return fail("Contact not found");
      if (input.lifecycle && input.lifecycle !== prev.lifecycle) {
        void emitEvent(ctx.userId, {
          type: "crm.contact.stage_changed",
          entity: "crm_contact",
          entityId: row.id,
          data: { from: prev.lifecycle, to: input.lifecycle },
        });
      }
      return { ok: true, data: row, summary: `Updated contact ${row.full_name}` };
    } catch (err) {
      return fail(`Update failed: ${errMsg(err)}`);
    }
  },
});

/* ---------- crm.log_activity ---------- */
const LogInput = z.object({
  contact_id: z.string().min(1),
  note: z.string().min(1).max(4000),
  type: z.enum(["note", "call", "email", "meeting", "deal"]).optional(),
});
type LogInputT = z.infer<typeof LogInput>;

registerTool<LogInputT>({
  name: "crm.log_activity",
  module: "crm",
  description: "Append a note/call/email/meeting activity to a contact's timeline and bump last_contact.",
  input: LogInput,
  parameters: {
    type: "object",
    properties: {
      contact_id: { type: "string" },
      note: { type: "string" },
      type: { type: "string", enum: ["note", "call", "email", "meeting", "deal"] },
    },
    required: ["contact_id", "note"],
  },
  scope: "write",
  requiresApproval: false,
  preview: (i) => `Log ${i.type ?? "note"} on contact ${i.contact_id}: ${i.note.slice(0, 80)}`,
  async run(ctx, input) {
    try {
      const contact = await queryOne<{ id: string; full_name: string }>(
        `SELECT id, full_name FROM crm_contacts WHERE id = $1 AND user_id = $2`,
        [input.contact_id, ctx.userId]
      );
      if (!contact) return fail("Contact not found");
      const type = input.type ?? "note";
      const title = input.note.length > 80 ? `${input.note.slice(0, 77)}...` : input.note;
      const row = await queryOne<{ id: string; created_at: string }>(
        `INSERT INTO crm_activities (user_id, contact_id, type, title, body)
         VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
        [ctx.userId, contact.id, type, title, input.note]
      );
      await query(`UPDATE crm_contacts SET last_contact = NOW(), updated_at = NOW() WHERE id = $1 AND user_id = $2`, [
        contact.id,
        ctx.userId,
      ]).catch(() => undefined);
      return { ok: true, data: row, summary: `Logged ${type} on ${contact.full_name}` };
    } catch (err) {
      return fail(`Log failed: ${errMsg(err)}`);
    }
  },
});
