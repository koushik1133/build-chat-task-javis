import { query, queryOne } from "@/lib/dsql";
import { emitEvent } from "@/lib/events/bus";
import { likeContains } from "@/lib/like";
import { keysetClause, type Cursor } from "@/lib/public-api/pagination";

/**
 * CRM contacts data layer (used by the public API; the in-app route keeps its
 * own handler). Emits the same events the UI emits so triggers and webhooks
 * fire regardless of which surface made the change.
 */

export interface ContactRow {
  id: string;
  user_id: string;
  domain: string;
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

export interface ContactDTO {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  role: string | null;
  tags: string[];
  lifecycle: string;
  notes: string | null;
  deal_value: number;
  domain: string;
  last_contact: string | null;
  created_at: string;
  updated_at: string;
}

const COLS = "id, user_id, domain, full_name, email, phone, company, role, tags, lifecycle, notes, last_contact, deal_value, created_at, updated_at";

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export function toContactDTO(r: ContactRow): ContactDTO {
  return {
    id: r.id,
    full_name: r.full_name,
    email: r.email,
    phone: r.phone,
    company: r.company,
    role: r.role,
    tags: parseTags(r.tags),
    lifecycle: r.lifecycle,
    notes: r.notes,
    deal_value: Number(r.deal_value ?? 0),
    domain: r.domain,
    last_contact: r.last_contact,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export interface ListContactsOptions {
  q?: string | null;
  lifecycle?: string | null;
  domain?: string | null;
  limit?: number;
  cursor?: Cursor | null;
}

export async function listContacts(dataId: string, opts: ListContactsOptions = {}): Promise<ContactDTO[]> {
  const params: unknown[] = [dataId];
  let sql = `SELECT ${COLS} FROM crm_contacts WHERE user_id = $1`;
  if (opts.lifecycle) {
    params.push(opts.lifecycle);
    sql += ` AND lifecycle = $${params.length}`;
  }
  if (opts.domain) {
    params.push(opts.domain);
    sql += ` AND domain = $${params.length}`;
  }
  if (opts.q?.trim()) {
    params.push(likeContains(opts.q.trim().slice(0, 200)));
    const i = params.length;
    sql += ` AND (full_name ILIKE $${i} OR email ILIKE $${i} OR company ILIKE $${i} OR phone ILIKE $${i})`;
  }
  sql += keysetClause(opts.cursor, params);
  params.push(Math.min(Math.max(opts.limit ?? 50, 1), 500));
  sql += ` ORDER BY created_at DESC, id DESC LIMIT $${params.length}`;
  return (await query<ContactRow>(sql, params)).map(toContactDTO);
}

export async function getContact(dataId: string, id: string): Promise<ContactDTO | null> {
  const row = await queryOne<ContactRow>(`SELECT ${COLS} FROM crm_contacts WHERE id = $1 AND user_id = $2`, [id, dataId]);
  return row ? toContactDTO(row) : null;
}

export interface ContactInput {
  full_name: string;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  role?: string | null;
  tags?: string[];
  lifecycle?: string;
  notes?: string | null;
  deal_value?: number;
  domain?: string;
}

export async function createContact(dataId: string, input: ContactInput): Promise<ContactDTO> {
  const row = await queryOne<ContactRow>(
    `INSERT INTO crm_contacts (user_id, domain, full_name, email, phone, company, role, tags, lifecycle, notes, deal_value)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${COLS}`,
    [
      dataId,
      input.domain ?? "general",
      input.full_name.trim(),
      input.email?.trim().toLowerCase() || null,
      input.phone?.trim() || null,
      input.company?.trim() || null,
      input.role?.trim() || null,
      JSON.stringify((input.tags ?? []).map((t) => t.trim()).filter(Boolean)),
      input.lifecycle ?? "lead",
      input.notes ?? null,
      input.deal_value ?? 0,
    ]
  );
  if (!row) throw new Error("Insert returned no row");
  void emitEvent(dataId, { type: "crm.contact.created", entity: "crm_contact", entityId: row.id, data: { lifecycle: row.lifecycle, source: "api" } });
  return toContactDTO(row);
}

export async function updateContact(dataId: string, id: string, patch: Partial<ContactInput>): Promise<ContactDTO> {
  const existing = await getContact(dataId, id);
  if (!existing) throw new Error("Contact not found");
  const sets: string[] = ["updated_at = NOW()"];
  const params: unknown[] = [id, dataId];
  const push = (col: string, v: unknown) => {
    params.push(v);
    sets.push(`${col} = $${params.length}`);
  };
  if (patch.full_name !== undefined) push("full_name", patch.full_name.trim());
  if (patch.email !== undefined) push("email", patch.email?.trim().toLowerCase() || null);
  if (patch.phone !== undefined) push("phone", patch.phone?.trim() || null);
  if (patch.company !== undefined) push("company", patch.company?.trim() || null);
  if (patch.role !== undefined) push("role", patch.role?.trim() || null);
  if (patch.tags !== undefined) push("tags", JSON.stringify(patch.tags.map((t) => t.trim()).filter(Boolean)));
  if (patch.lifecycle !== undefined) push("lifecycle", patch.lifecycle);
  if (patch.notes !== undefined) push("notes", patch.notes);
  if (patch.deal_value !== undefined) push("deal_value", patch.deal_value);
  if (patch.domain !== undefined) push("domain", patch.domain);
  const row = await queryOne<ContactRow>(`UPDATE crm_contacts SET ${sets.join(", ")} WHERE id = $1 AND user_id = $2 RETURNING ${COLS}`, params);
  if (!row) throw new Error("Contact not found");
  if (patch.lifecycle !== undefined && patch.lifecycle !== existing.lifecycle) {
    void emitEvent(dataId, { type: "crm.contact.stage_changed", entity: "crm_contact", entityId: id, data: { from: existing.lifecycle, to: patch.lifecycle } });
  }
  return toContactDTO(row);
}

export async function deleteContact(dataId: string, id: string): Promise<boolean> {
  const rows = await query<{ id: string }>(`DELETE FROM crm_contacts WHERE id = $1 AND user_id = $2 RETURNING id`, [id, dataId]);
  return rows.length > 0;
}
