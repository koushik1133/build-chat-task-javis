import { randomUUID } from "crypto";
import { query } from "@/lib/dsql";
import type { Area } from "@/lib/auth/roles";

/**
 * Import targets: what a CSV can land in, which fields exist, how rows are
 * de-duplicated and how a normalised row is inserted.
 *
 * Normalised values (see run.ts): strings are trimmed, money is an integer in
 * minor units, dates/datetimes are ISO strings, booleans are booleans, tags
 * are string arrays. Each target's `insert` adapts that to its own columns.
 */

export type FieldType = "string" | "email" | "phone" | "number" | "money" | "date" | "datetime" | "boolean" | "enum" | "tags";

export interface ImportField {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  /** Allowed values for `enum` fields (case-insensitive match). */
  values?: string[];
  /** Header names (normalised) that mean this field. */
  synonyms: string[];
  description?: string;
}

export type NormalisedRow = Record<string, string | number | boolean | string[] | null>;

export interface ImportTarget {
  key: ImportTargetKey;
  label: string;
  description: string;
  table: string;
  area: Area;
  fields: ImportField[];
  /** Field keys whose combined value identifies a duplicate. Blank → not de-duplicated. */
  dedupeKey: string[];
  /** Existing dedupe keys for the workspace (lower-cased, joined by "|"). */
  existingKeys(dataId: string): Promise<Set<string>>;
  /** Insert one or more normalised rows. Throws on failure. */
  insert(dataId: string, rows: NormalisedRow[]): Promise<void>;
}

export const IMPORT_TARGET_KEYS = ["crm_contacts", "leads", "tasks", "products", "expenses"] as const;
export type ImportTargetKey = (typeof IMPORT_TARGET_KEYS)[number];

export function isImportTargetKey(v: unknown): v is ImportTargetKey {
  return typeof v === "string" && (IMPORT_TARGET_KEYS as readonly string[]).includes(v);
}

/** Sentinel site id for leads that did not come from a published site. */
export const IMPORTED_LEADS_SITE_ID = "00000000-0000-0000-0000-000000000000";

const s = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Run a multi-row INSERT in chunks. `cols` excludes user_id, which is prepended. */
async function insertRows(table: string, cols: string[], values: unknown[][], chunk = 100): Promise<void> {
  for (let i = 0; i < values.length; i += chunk) {
    const slice = values.slice(i, i + chunk);
    const placeholders: string[] = [];
    const flat: unknown[] = [];
    let p = 1;
    for (const row of slice) {
      placeholders.push(`(${row.map(() => `$${p++}`).join(",")})`);
      flat.push(...row);
    }
    await query(`INSERT INTO ${table} (${cols.join(",")}) VALUES ${placeholders.join(",")}`, flat);
  }
}

const contacts: ImportTarget = {
  key: "crm_contacts",
  label: "Contacts",
  description: "People and companies in the CRM.",
  table: "crm_contacts",
  area: "crm",
  dedupeKey: ["email"],
  fields: [
    { key: "full_name", label: "Full name", type: "string", required: true, synonyms: ["name", "full name", "contact", "contact name", "person", "first name"] },
    { key: "email", label: "Email", type: "email", synonyms: ["email", "e-mail", "email address", "mail"] },
    { key: "phone", label: "Phone", type: "phone", synonyms: ["phone", "telephone", "mobile", "cell", "phone number", "tel"] },
    { key: "company", label: "Company", type: "string", synonyms: ["company", "organisation", "organization", "business", "account", "employer"] },
    { key: "role", label: "Role / title", type: "string", synonyms: ["role", "title", "job title", "position"] },
    {
      key: "lifecycle",
      label: "Lifecycle stage",
      type: "enum",
      values: ["lead", "prospect", "customer", "churned", "donor", "patient", "student"],
      synonyms: ["lifecycle", "stage", "status", "type", "lifecycle stage"],
    },
    { key: "tags", label: "Tags", type: "tags", synonyms: ["tags", "labels", "categories", "segments"] },
    { key: "deal_value", label: "Deal value", type: "money", synonyms: ["deal value", "value", "amount", "deal", "revenue", "deal size"] },
    { key: "last_contact", label: "Last contacted", type: "datetime", synonyms: ["last contact", "last contacted", "last touch", "last activity"] },
    { key: "notes", label: "Notes", type: "string", synonyms: ["notes", "note", "comments", "description", "remarks"] },
  ],
  async existingKeys(dataId) {
    const rows = await query<{ email: string | null }>(
      `SELECT email FROM crm_contacts WHERE user_id = $1 AND email IS NOT NULL AND deleted_at IS NULL`,
      [dataId]
    );
    return new Set(rows.map((r) => (r.email ?? "").trim().toLowerCase()).filter(Boolean));
  },
  async insert(dataId, rows) {
    await insertRows(
      "crm_contacts",
      ["user_id", "domain", "full_name", "email", "phone", "company", "role", "tags", "lifecycle", "notes", "deal_value", "last_contact"],
      rows.map((r) => [
        dataId,
        "general",
        s(r.full_name) ?? "(unnamed)",
        s(r.email)?.toLowerCase() ?? null,
        s(r.phone),
        s(r.company),
        s(r.role),
        JSON.stringify(Array.isArray(r.tags) ? r.tags : []),
        s(r.lifecycle) ?? "lead",
        s(r.notes),
        // crm_contacts.deal_value is NUMERIC(12,2) in major units.
        n(r.deal_value) !== null ? (n(r.deal_value) as number) / 100 : 0,
        s(r.last_contact),
      ])
    );
  },
};

const leads: ImportTarget = {
  key: "leads",
  label: "Leads",
  description: "Inbound leads for the Lead Inbox.",
  table: "site_leads",
  area: "leads",
  dedupeKey: ["email"],
  fields: [
    { key: "name", label: "Name", type: "string", synonyms: ["name", "full name", "contact", "lead", "lead name"] },
    { key: "email", label: "Email", type: "email", required: true, synonyms: ["email", "e-mail", "email address"] },
    { key: "phone", label: "Phone", type: "phone", synonyms: ["phone", "telephone", "mobile", "phone number"] },
    { key: "company", label: "Company", type: "string", synonyms: ["company", "organisation", "organization", "business"] },
    { key: "message", label: "Message", type: "string", synonyms: ["message", "notes", "enquiry", "inquiry", "comments", "details"] },
    { key: "source", label: "Source", type: "string", synonyms: ["source", "channel", "origin", "campaign", "utm source"] },
    {
      key: "status",
      label: "Status",
      type: "enum",
      values: ["new", "contacted", "qualified", "won", "lost"],
      synonyms: ["status", "stage", "state"],
    },
    { key: "created_at", label: "Received at", type: "datetime", synonyms: ["created", "created at", "date", "received", "submitted", "timestamp"] },
  ],
  async existingKeys(dataId) {
    const rows = await query<{ data: string }>(`SELECT data FROM site_leads WHERE user_id = $1`, [dataId]);
    const keys = new Set<string>();
    for (const r of rows) {
      try {
        const d = JSON.parse(r.data) as { email?: unknown };
        if (typeof d.email === "string" && d.email.trim()) keys.add(d.email.trim().toLowerCase());
      } catch {
        /* ignore malformed rows */
      }
    }
    return keys;
  },
  async insert(dataId, rows) {
    await insertRows(
      "site_leads",
      ["id", "site_id", "user_id", "data", "status", "created_at"],
      rows.map((r) => [
        randomUUID(),
        IMPORTED_LEADS_SITE_ID,
        dataId,
        JSON.stringify({
          name: s(r.name),
          email: s(r.email)?.toLowerCase() ?? null,
          phone: s(r.phone),
          company: s(r.company),
          message: s(r.message),
          source: s(r.source) ?? "import",
        }),
        s(r.status) ?? "new",
        s(r.created_at) ?? new Date().toISOString(),
      ])
    );
  },
};

const tasks: ImportTarget = {
  key: "tasks",
  label: "Tasks",
  description: "To-dos for the Tasks board.",
  table: "tasks",
  area: "tasks",
  dedupeKey: ["title"],
  fields: [
    { key: "title", label: "Title", type: "string", required: true, synonyms: ["title", "task", "name", "summary", "subject", "todo", "to do", "item"] },
    { key: "done", label: "Done", type: "boolean", synonyms: ["done", "completed", "complete", "finished", "status", "checked"] },
    { key: "created_at", label: "Created at", type: "datetime", synonyms: ["created", "created at", "date", "added"] },
  ],
  async existingKeys(dataId) {
    const rows = await query<{ title: string }>(`SELECT title FROM tasks WHERE user_id = $1 AND deleted_at IS NULL`, [dataId]);
    return new Set(rows.map((r) => r.title.trim().toLowerCase()));
  },
  async insert(dataId, rows) {
    // tasks.created_at has a NOT NULL default; only pass it when mapped.
    const withDate = rows.filter((r) => s(r.created_at));
    const withoutDate = rows.filter((r) => !s(r.created_at));
    if (withoutDate.length) {
      await insertRows("tasks", ["user_id", "title", "done"], withoutDate.map((r) => [dataId, s(r.title) ?? "(untitled)", r.done === true]));
    }
    if (withDate.length) {
      await insertRows(
        "tasks",
        ["user_id", "title", "done", "created_at"],
        withDate.map((r) => [dataId, s(r.title) ?? "(untitled)", r.done === true, s(r.created_at)])
      );
    }
  },
};

const products: ImportTarget = {
  key: "products",
  label: "Products & services",
  description: "Catalogue items with prices and stock.",
  table: "products",
  area: "billing",
  dedupeKey: ["sku"],
  fields: [
    { key: "sku", label: "SKU", type: "string", synonyms: ["sku", "code", "product code", "item code", "part number", "id"] },
    { key: "name", label: "Name", type: "string", required: true, synonyms: ["name", "product", "product name", "item", "title", "service"] },
    { key: "kind", label: "Kind", type: "enum", values: ["product", "service"], synonyms: ["kind", "type", "category"] },
    { key: "unit_price_minor", label: "Unit price", type: "money", synonyms: ["price", "unit price", "amount", "cost", "rate", "unit cost"] },
    { key: "currency", label: "Currency", type: "string", synonyms: ["currency", "ccy", "currency code"] },
    { key: "stock_on_hand", label: "Stock on hand", type: "number", synonyms: ["stock", "stock on hand", "quantity", "qty", "inventory", "on hand"] },
  ],
  async existingKeys(dataId) {
    const rows = await query<{ sku: string | null }>(`SELECT sku FROM products WHERE user_id = $1 AND sku IS NOT NULL`, [dataId]);
    return new Set(rows.map((r) => (r.sku ?? "").trim().toLowerCase()).filter(Boolean));
  },
  async insert(dataId, rows) {
    await insertRows(
      "products",
      ["id", "user_id", "sku", "name", "kind", "unit_price_minor", "currency", "stock_on_hand"],
      rows.map((r) => [
        randomUUID(),
        dataId,
        s(r.sku),
        s(r.name) ?? "(unnamed)",
        s(r.kind) ?? "product",
        n(r.unit_price_minor) ?? 0,
        (s(r.currency) ?? "USD").toUpperCase().slice(0, 3),
        n(r.stock_on_hand) ?? 0,
      ])
    );
  },
};

/** YYYY-MM-DD from whatever pg returned for a date/timestamp column. */
export function isoDay(v: string | Date | null | undefined): string {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "" : v.toISOString().slice(0, 10);
  return String(v ?? "").slice(0, 10);
}

/** Must produce the same key as `dedupeKeyFor` does for a normalised expense row. */
export function expenseDedupeKey(vendor: string | null, amountMinor: string | number, spentAt: string | Date | null): string {
  return [vendor ?? "", String(Number(amountMinor)), isoDay(spentAt)].join("|").toLowerCase();
}

const expenses: ImportTarget = {
  key: "expenses",
  label: "Expenses",
  description: "Money spent, for the accounting ledger.",
  table: "expenses",
  area: "billing",
  dedupeKey: ["vendor", "amount_minor", "spent_at"],
  fields: [
    { key: "spent_at", label: "Date", type: "date", required: true, synonyms: ["date", "spent at", "spent", "transaction date", "paid on", "when", "posted"] },
    { key: "amount_minor", label: "Amount", type: "money", required: true, synonyms: ["amount", "total", "cost", "price", "value", "debit", "spend"] },
    { key: "currency", label: "Currency", type: "string", synonyms: ["currency", "ccy", "currency code"] },
    { key: "vendor", label: "Vendor", type: "string", synonyms: ["vendor", "payee", "merchant", "supplier", "paid to", "store", "name"] },
    { key: "category", label: "Category", type: "string", synonyms: ["category", "type", "account", "class", "bucket"] },
    { key: "description", label: "Description", type: "string", synonyms: ["description", "memo", "notes", "details", "narrative", "reference"] },
  ],
  async existingKeys(dataId) {
    // spent_at is TIMESTAMPTZ: pg hands it back as a Date, whose String() form
    // is "Mon Jan 15 2024 …", so it must be normalised to YYYY-MM-DD to match
    // the ISO date the coercer produces for incoming rows.
    const rows = await query<{ vendor: string | null; amount_minor: string | number; spent_at: string | Date | null }>(
      `SELECT vendor, amount_minor, spent_at FROM expenses WHERE user_id = $1`,
      [dataId]
    );
    return new Set(rows.map((r) => expenseDedupeKey(r.vendor, r.amount_minor, r.spent_at)));
  },
  async insert(dataId, rows) {
    await insertRows(
      "expenses",
      ["id", "user_id", "category", "vendor", "description", "amount_minor", "currency", "spent_at"],
      rows.map((r) => [
        randomUUID(),
        dataId,
        // expenses.category is NOT NULL DEFAULT 'general'; an explicit NULL would fail the insert.
        s(r.category) ?? "general",
        s(r.vendor),
        s(r.description),
        n(r.amount_minor) ?? 0,
        (s(r.currency) ?? "USD").toUpperCase().slice(0, 3),
        s(r.spent_at),
      ])
    );
  },
};

export const IMPORT_TARGETS: Record<ImportTargetKey, ImportTarget> = {
  crm_contacts: contacts,
  leads,
  tasks,
  products,
  expenses,
};

export function getImportTarget(key: ImportTargetKey): ImportTarget {
  return IMPORT_TARGETS[key];
}

/** Serialisable description for the UI (no functions). */
export function describeTargets(): Array<{ key: ImportTargetKey; label: string; description: string; fields: ImportField[]; dedupeKey: string[] }> {
  return IMPORT_TARGET_KEYS.map((k) => {
    const t = IMPORT_TARGETS[k];
    return { key: t.key, label: t.label, description: t.description, fields: t.fields, dedupeKey: t.dedupeKey };
  });
}
