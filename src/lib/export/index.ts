import { query } from "@/lib/dsql";
import type { Area } from "@/lib/auth/roles";
import { tableExists } from "@/lib/table-exists";
import { toCsv } from "./csv";

/**
 * Generic entity export. Every entity has a column whitelist (never SELECT *),
 * an auth area, a date column for ?from=&to= and an optional post-processor
 * (JSON text columns are expanded for JSON output).
 */

export interface ExportEntity {
  key: ExportEntityKey;
  label: string;
  table: string;
  area: Area;
  columns: string[];
  dateColumn: string;
  orderBy?: string;
  /** Columns stored as JSON text. */
  jsonColumns?: string[];
  /** Extra WHERE fragment (uses $N placeholders appended after user_id/from/to). */
  where?: string;
  /** Soft-delete column to exclude. */
  deletedColumn?: string;
}

export const EXPORT_ENTITY_KEYS = ["contacts", "leads", "tasks", "bookings", "quotes", "invoices", "tickets", "records"] as const;
export type ExportEntityKey = (typeof EXPORT_ENTITY_KEYS)[number];

export function isExportEntityKey(v: unknown): v is ExportEntityKey {
  return typeof v === "string" && (EXPORT_ENTITY_KEYS as readonly string[]).includes(v);
}

export const EXPORT_ENTITIES: Record<ExportEntityKey, ExportEntity> = {
  contacts: {
    key: "contacts",
    label: "Contacts",
    table: "crm_contacts",
    area: "crm",
    columns: ["id", "full_name", "email", "phone", "company", "role", "lifecycle", "tags", "deal_value", "last_contact", "notes", "created_at", "updated_at"],
    jsonColumns: ["tags"],
    dateColumn: "created_at",
    deletedColumn: "deleted_at",
  },
  leads: {
    key: "leads",
    label: "Leads",
    table: "site_leads",
    area: "leads",
    columns: ["id", "site_id", "data", "status", "research_summary", "follow_up_at", "sent_at", "enriched_at", "created_at"],
    jsonColumns: ["data"],
    dateColumn: "created_at",
  },
  tasks: {
    key: "tasks",
    label: "Tasks",
    table: "tasks",
    area: "tasks",
    columns: ["id", "title", "done", "chat_id", "created_at"],
    dateColumn: "created_at",
    deletedColumn: "deleted_at",
  },
  bookings: {
    key: "bookings",
    label: "Bookings",
    table: "bookings",
    area: "calendar",
    columns: ["id", "calendar_id", "booking_type_id", "contact_id", "name", "email", "phone", "starts_at", "ends_at", "status", "source", "notes", "created_at", "updated_at"],
    dateColumn: "starts_at",
    orderBy: "starts_at",
  },
  quotes: {
    key: "quotes",
    label: "Quotes",
    table: "quotes",
    area: "billing",
    columns: ["id", "number", "status", "contact_id", "currency", "subtotal_minor", "tax_minor", "total_minor", "valid_until", "notes", "created_at", "sent_at", "accepted_at", "updated_at"],
    dateColumn: "created_at",
  },
  invoices: {
    key: "invoices",
    label: "Invoices",
    table: "invoices",
    area: "billing",
    columns: ["id", "number", "status", "contact_id", "quote_id", "currency", "subtotal_minor", "tax_minor", "total_minor", "paid_minor", "due_at", "items", "notes", "created_at", "sent_at", "paid_at", "updated_at"],
    jsonColumns: ["items"],
    dateColumn: "created_at",
  },
  tickets: {
    key: "tickets",
    label: "Tickets",
    table: "tickets",
    area: "helpdesk",
    columns: ["id", "number", "subject", "status", "priority", "source", "contact_id", "requester_email", "requester_name", "assigned_to", "first_response_due_at", "resolution_due_at", "first_responded_at", "resolved_at", "breached_first_response", "breached_resolution", "tags", "created_at", "updated_at"],
    jsonColumns: ["tags"],
    dateColumn: "created_at",
  },
  records: {
    key: "records",
    label: "Records",
    table: "records",
    // Records are read/written under the CRM area (see src/app/api/records); the export must not widen that.
    area: "crm",
    columns: ["id", "type_id", "title", "stage", "data", "summary", "contact_id", "amount_minor", "currency", "due_at", "assigned_to", "created_at", "updated_at"],
    jsonColumns: ["data"],
    dateColumn: "created_at",
    deletedColumn: "deleted_at",
  },
};

export interface ExportOptions {
  from?: string | null;
  to?: string | null;
  /** records only: record_types.slug or id. */
  type?: string | null;
  limit?: number;
}

export const EXPORT_ROW_LIMIT = 50_000;

/** Parse an ISO date (or YYYY-MM-DD) to a Date or null. */
export function parseDateParam(v: string | null | undefined, endOfDay = false): Date | null {
  if (!v) return null;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`) : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export class ExportUnavailableError extends Error {
  constructor(entity: string) {
    super(`${entity} is not available in this workspace`);
    this.name = "ExportUnavailableError";
  }
}

export async function fetchExportRows(dataId: string, entity: ExportEntity, opts: ExportOptions = {}): Promise<Array<Record<string, unknown>>> {
  if (!(await tableExists(entity.table))) throw new ExportUnavailableError(entity.key);

  const values: unknown[] = [dataId];
  const where: string[] = ["user_id = $1"];
  if (entity.deletedColumn) where.push(`${entity.deletedColumn} IS NULL`);
  const from = parseDateParam(opts.from);
  const to = parseDateParam(opts.to, true);
  if (from) {
    values.push(from.toISOString());
    where.push(`${entity.dateColumn} >= $${values.length}`);
  }
  if (to) {
    values.push(to.toISOString());
    where.push(`${entity.dateColumn} <= $${values.length}`);
  }
  if (entity.key === "records" && opts.type) {
    values.push(opts.type);
    where.push(`type_id IN (SELECT id FROM record_types WHERE user_id = $1 AND (slug = $${values.length} OR id = $${values.length}))`);
  }
  const limit = Math.max(1, Math.min(EXPORT_ROW_LIMIT, opts.limit ?? EXPORT_ROW_LIMIT));
  values.push(limit);
  const sql = `SELECT ${entity.columns.join(", ")} FROM ${entity.table} WHERE ${where.join(" AND ")} ORDER BY ${entity.orderBy ?? entity.dateColumn} DESC LIMIT $${values.length}`;
  const rows = await query<Record<string, unknown>>(sql, values);
  return rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const c of entity.columns) {
      let v = r[c];
      if (v instanceof Date) v = v.toISOString();
      out[c] = v ?? null;
    }
    return out;
  });
}

export function expandJson(rows: Array<Record<string, unknown>>, entity: ExportEntity): Array<Record<string, unknown>> {
  if (!entity.jsonColumns?.length) return rows;
  return rows.map((r) => {
    const out = { ...r };
    for (const c of entity.jsonColumns ?? []) {
      const v = out[c];
      if (typeof v === "string") {
        try {
          out[c] = JSON.parse(v);
        } catch {
          /* leave as text */
        }
      }
    }
    return out;
  });
}

export function exportFileName(entity: ExportEntity, format: "csv" | "json", opts: ExportOptions = {}): string {
  const stamp = new Date().toISOString().slice(0, 10);
  const type = entity.key === "records" && opts.type ? `-${opts.type.replace(/[^a-z0-9_-]/gi, "")}` : "";
  return `${entity.key}${type}-${stamp}.${format}`;
}

export function renderExport(rows: Array<Record<string, unknown>>, entity: ExportEntity, format: "csv" | "json"): { body: string; contentType: string } {
  if (format === "json") {
    return { body: JSON.stringify({ entity: entity.key, count: rows.length, rows: expandJson(rows, entity) }, null, 2), contentType: "application/json; charset=utf-8" };
  }
  return { body: toCsv(rows, entity.columns.map((key) => ({ key })), { bom: true }), contentType: "text/csv; charset=utf-8" };
}
