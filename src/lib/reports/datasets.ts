import type { Area } from "@/lib/auth/roles";
import type { FieldDef } from "@/lib/records/types";

/**
 * Report datasets: the only tables, columns and expressions the report
 * compiler may ever emit. Field keys are looked up here; user input never
 * becomes an identifier. Client-safe (no DB imports) so the builder UI can
 * render the catalogue from the same definitions.
 */

export type FieldKind = "dimension" | "measure" | "date";
export const AGGREGATIONS = ["count", "sum", "avg", "min", "max", "count_distinct"] as const;
export type Aggregation = (typeof AGGREGATIONS)[number];
export const DATE_BUCKETS = ["day", "week", "month", "quarter", "year"] as const;
export type DateBucket = (typeof DATE_BUCKETS)[number];

export interface DatasetField {
  key: string;
  label: string;
  kind: FieldKind;
  /** SQL expression (whitelisted literal). Omitted for JSON fields, which are built from `jsonKey`. */
  column?: string;
  /** records only: key inside `data` JSON (validated snake_case from the type definition). */
  jsonKey?: string;
  /** How to render numeric measures. */
  format?: "money" | "number" | "minutes" | "percent";
  /** Aggregations allowed on this field (dimensions default to count_distinct only). */
  aggregations?: readonly Aggregation[];
}

export interface Dataset {
  key: string;
  label: string;
  description: string;
  /** FROM clause (tables/aliases are literals from this file). */
  from: string;
  /** Table whose existence is probed before running. */
  table: string;
  /** Column holding the org data id. */
  scopeColumn: string;
  area: Area;
  fields: DatasetField[];
  /** Default date field key for relative-range filters and buckets. */
  defaultDate: string;
  /** Extra WHERE fragment (literal). */
  where?: string;
  /** Soft-delete column to exclude. */
  deletedColumn?: string;
  /** Currency column (for money formatting hints). */
  currencyColumn?: string;
}

const MEASURE: readonly Aggregation[] = ["sum", "avg", "min", "max", "count", "count_distinct"];
const money = (key: string, label: string, column = key): DatasetField => ({ key, label, kind: "measure", column, format: "money", aggregations: MEASURE });
const num = (key: string, label: string, column = key, format: DatasetField["format"] = "number"): DatasetField => ({ key, label, kind: "measure", column, format, aggregations: MEASURE });
const dim = (key: string, label: string, column = key): DatasetField => ({ key, label, kind: "dimension", column, aggregations: ["count", "count_distinct"] });
const date = (key: string, label: string, column = key): DatasetField => ({ key, label, kind: "date", column, aggregations: ["count", "count_distinct", "min", "max"] });

export const STATIC_DATASETS: Record<string, Dataset> = {
  contacts: {
    key: "contacts", label: "Contacts", description: "CRM contacts by lifecycle, company and owner.", from: "crm_contacts", table: "crm_contacts", scopeColumn: "user_id", area: "crm",
    deletedColumn: "deleted_at", defaultDate: "created_at",
    fields: [dim("id", "Contact"), dim("full_name", "Name"), dim("email", "Email"), dim("company", "Company"), dim("role", "Role"), dim("lifecycle", "Lifecycle"), money("deal_value", "Deal value"), date("created_at", "Created"), date("last_contact", "Last contact"), date("updated_at", "Updated")],
  },
  leads: {
    key: "leads", label: "Leads", description: "Captured site leads and their follow-up status.", from: "site_leads", table: "site_leads", scopeColumn: "user_id", area: "leads", defaultDate: "created_at",
    fields: [dim("id", "Lead"), dim("site_id", "Site"), dim("status", "Status"), date("created_at", "Captured"), date("sent_at", "Replied"), date("enriched_at", "Enriched"), date("follow_up_at", "Follow-up")],
  },
  quotes: {
    key: "quotes", label: "Quotes", description: "Quotes by status, contact and value.", from: "quotes", table: "quotes", scopeColumn: "user_id", area: "billing", defaultDate: "created_at", currencyColumn: "currency",
    fields: [dim("id", "Quote"), dim("number", "Number"), dim("status", "Status"), dim("contact_id", "Contact"), dim("currency", "Currency"), money("subtotal_minor", "Subtotal"), money("tax_minor", "Tax"), money("total_minor", "Total"), date("created_at", "Created"), date("sent_at", "Sent"), date("accepted_at", "Accepted"), date("valid_until", "Valid until")],
  },
  invoices: {
    key: "invoices", label: "Invoices", description: "Invoices issued, paid and outstanding.", from: "invoices", table: "invoices", scopeColumn: "user_id", area: "billing", defaultDate: "created_at", currencyColumn: "currency",
    fields: [dim("id", "Invoice"), dim("number", "Number"), dim("status", "Status"), dim("contact_id", "Contact"), dim("currency", "Currency"), money("subtotal_minor", "Subtotal"), money("tax_minor", "Tax"), money("total_minor", "Total"), money("paid_minor", "Paid"), money("outstanding_minor", "Outstanding", "(total_minor - COALESCE(paid_minor, 0))"), date("created_at", "Created"), date("sent_at", "Sent"), date("due_at", "Due"), date("paid_at", "Paid at")],
  },
  orders: {
    key: "orders", label: "Orders", description: "Storefront orders by status, customer and value.", from: "orders", table: "orders", scopeColumn: "user_id", area: "billing", defaultDate: "created_at", currencyColumn: "currency",
    fields: [dim("id", "Order"), dim("number", "Number"), dim("status", "Status"), dim("customer_email", "Customer email"), dim("customer_name", "Customer"), dim("contact_id", "Contact"), dim("invoice_id", "Invoice"), dim("currency", "Currency"), money("subtotal_minor", "Subtotal"), money("tax_minor", "Tax"), money("shipping_minor", "Shipping"), money("total_minor", "Total"), date("created_at", "Created"), date("paid_at", "Paid at"), date("fulfilled_at", "Fulfilled at"), date("cancelled_at", "Cancelled at")],
  },
  payments: {
    key: "payments", label: "Payments", description: "Payments received against invoices.", from: "invoice_payments p JOIN invoices i ON i.id = p.invoice_id", table: "invoice_payments", scopeColumn: "i.user_id", area: "billing", defaultDate: "created_at", currencyColumn: "p.currency",
    fields: [dim("id", "Payment", "p.id"), dim("invoice_id", "Invoice", "p.invoice_id"), dim("invoice_number", "Invoice number", "i.number"), dim("contact_id", "Contact", "i.contact_id"), dim("provider", "Provider", "p.provider"), dim("status", "Status", "p.status"), dim("currency", "Currency", "p.currency"), money("amount_minor", "Amount", "p.amount_minor"), money("refunded_minor", "Refunded", "COALESCE(p.refunded_minor, 0)"), money("net_minor", "Net", "(p.amount_minor - COALESCE(p.refunded_minor, 0))"), date("created_at", "Received", "p.created_at"), date("refunded_at", "Refunded at", "p.refunded_at")],
  },
  expenses: {
    key: "expenses", label: "Expenses", description: "Cash out by category, vendor and job.", from: "expenses", table: "expenses", scopeColumn: "user_id", area: "billing", defaultDate: "spent_at", currencyColumn: "currency",
    fields: [dim("id", "Expense"), dim("category", "Category"), dim("vendor", "Vendor"), dim("ref_kind", "Job kind"), dim("ref_id", "Job"), dim("billable", "Billable", "billable::text"), dim("currency", "Currency"), money("amount_minor", "Amount"), money("tax_minor", "Tax"), date("spent_at", "Spent"), date("created_at", "Logged")],
  },
  time_entries: {
    key: "time_entries", label: "Time entries", description: "Logged time by member and job.", from: "time_entries", table: "time_entries", scopeColumn: "user_id", area: "billing", defaultDate: "started_at", currencyColumn: "currency",
    fields: [dim("id", "Entry"), dim("member_id", "Member"), dim("ref_kind", "Job kind"), dim("ref_id", "Job"), dim("billable", "Billable", "billable::text"), num("minutes", "Minutes", "minutes", "minutes"), money("rate_minor", "Rate"), money("value_minor", "Value", "(COALESCE(minutes, 0) * COALESCE(rate_minor, 0) / 60)"), date("started_at", "Started"), date("ended_at", "Ended"), date("created_at", "Logged")],
  },
  bookings: {
    key: "bookings", label: "Bookings", description: "Appointments by type, status and source.", from: "bookings", table: "bookings", scopeColumn: "user_id", area: "calendar", defaultDate: "starts_at",
    fields: [dim("id", "Booking"), dim("booking_type_id", "Booking type"), dim("calendar_id", "Calendar"), dim("contact_id", "Contact"), dim("status", "Status"), dim("source", "Source"), num("duration_minutes", "Duration", "(EXTRACT(EPOCH FROM (ends_at - starts_at)) / 60)", "minutes"), date("starts_at", "Starts"), date("created_at", "Booked")],
  },
  tickets: {
    key: "tickets", label: "Tickets", description: "Helpdesk tickets, SLA and response times.", from: "tickets", table: "tickets", scopeColumn: "user_id", area: "helpdesk", defaultDate: "created_at",
    fields: [dim("id", "Ticket"), dim("number", "Number", "number::text"), dim("status", "Status"), dim("priority", "Priority"), dim("source", "Source"), dim("assigned_to", "Assignee"), dim("contact_id", "Contact"), dim("breached_first_response", "Breached first response", "breached_first_response::text"), dim("breached_resolution", "Breached resolution", "breached_resolution::text"), num("first_response_minutes", "First response (min)", "(EXTRACT(EPOCH FROM (first_responded_at - created_at)) / 60)", "minutes"), num("resolution_minutes", "Resolution (min)", "(EXTRACT(EPOCH FROM (resolved_at - created_at)) / 60)", "minutes"), date("created_at", "Opened"), date("first_responded_at", "First response"), date("resolved_at", "Resolved")],
  },
  products: {
    key: "products", label: "Products", description: "Pricebook and stock on hand.", from: "products", table: "products", scopeColumn: "user_id", area: "billing", deletedColumn: "deleted_at", defaultDate: "created_at", currencyColumn: "currency",
    fields: [dim("id", "Product"), dim("sku", "SKU"), dim("name", "Name"), dim("kind", "Kind"), dim("unit", "Unit"), dim("active", "Active", "active::text"), dim("currency", "Currency"), money("unit_price_minor", "Unit price"), money("cost_minor", "Cost"), num("stock_on_hand", "Stock on hand"), num("stock_reserved", "Reserved"), num("reorder_point", "Reorder point"), date("created_at", "Created"), date("updated_at", "Updated")],
  },
  stock_movements: {
    key: "stock_movements", label: "Stock movements", description: "Stock in/out by product and reason.", from: "stock_movements", table: "stock_movements", scopeColumn: "user_id", area: "billing", defaultDate: "created_at",
    fields: [dim("id", "Movement"), dim("product_id", "Product"), dim("kind", "Kind"), dim("ref_kind", "Reference kind"), dim("ref_id", "Reference"), num("qty", "Quantity"), date("created_at", "Recorded")],
  },
  agent_runs: {
    key: "agent_runs", label: "Agent runs", description: "Agent executions, status and token spend.", from: "agent_runs", table: "agent_runs", scopeColumn: "user_id", area: "agents", defaultDate: "created_at",
    fields: [dim("id", "Run", "id::text"), dim("agent_id", "Agent", "agent_id::text"), dim("workflow_name", "Workflow"), dim("status", "Status"), dim("trigger_kind", "Trigger"), num("tokens_in", "Tokens in"), num("tokens_out", "Tokens out"), num("cost_micros", "Cost (µ)"), num("duration_seconds", "Duration (s)", "EXTRACT(EPOCH FROM (finished_at - started_at))"), date("created_at", "Started")],
  },
  ai_usage: {
    key: "ai_usage", label: "AI usage", description: "Model calls by feature, provider and cost.", from: "ai_usage", table: "ai_usage", scopeColumn: "user_id", area: "agents", defaultDate: "created_at",
    fields: [dim("id", "Call"), dim("feature", "Feature"), dim("provider", "Provider"), dim("model", "Model"), num("prompt_tokens", "Prompt tokens"), num("completion_tokens", "Completion tokens"), num("cost_micros", "Cost (µ)"), date("created_at", "At")],
  },
  webchat_sessions: {
    key: "webchat_sessions", label: "Web chat sessions", description: "Website chat sessions by site and outcome.", from: "chat_sessions", table: "chat_sessions", scopeColumn: "user_id", area: "messaging", defaultDate: "started_at",
    fields: [dim("id", "Session"), dim("site_id", "Site"), dim("status", "Status"), dim("contact_id", "Contact"), dim("lead_id", "Lead"), num("duration_minutes", "Duration", "(EXTRACT(EPOCH FROM (COALESCE(closed_at, last_seen_at) - started_at)) / 60)", "minutes"), date("started_at", "Started"), date("closed_at", "Closed")],
  },
  voice_targets: {
    key: "voice_targets", label: "Voice campaign targets", description: "Dial outcomes per campaign.", from: "voice_campaign_targets", table: "voice_campaign_targets", scopeColumn: "user_id", area: "messaging", defaultDate: "created_at",
    fields: [dim("id", "Target"), dim("campaign_id", "Campaign"), dim("status", "Status"), dim("contact_id", "Contact"), num("attempts", "Attempts"), date("created_at", "Added"), date("last_attempt_at", "Last attempt")],
  },
  shifts: {
    key: "shifts", label: "Shifts", description: "Rostered shifts by staff, role and location.", from: "shifts", table: "shifts", scopeColumn: "user_id", area: "team", defaultDate: "starts_at",
    fields: [dim("id", "Shift"), dim("staff_id", "Staff"), dim("role_title", "Role"), dim("location", "Location"), dim("status", "Status"), num("break_minutes", "Break (min)", "break_minutes", "minutes"), num("hours", "Hours", "(EXTRACT(EPOCH FROM (ends_at - starts_at)) / 3600)"), date("starts_at", "Starts"), date("ends_at", "Ends"), date("published_at", "Published")],
  },
  campaigns: {
    key: "campaigns", label: "Marketing campaigns", description: "Email / SMS campaigns with funnel counters.", from: "campaigns", table: "campaigns", scopeColumn: "user_id", area: "crm", defaultDate: "created_at",
    fields: [dim("id", "Campaign"), dim("name", "Name"), dim("channel", "Channel"), dim("status", "Status"), dim("audience_id", "Audience"), dim("template_id", "Template"), num("sent_count", "Sent"), num("delivered_count", "Delivered"), num("opened_count", "Opened"), num("clicked_count", "Clicked"), num("bounced_count", "Bounced"), num("unsubscribed_count", "Unsubscribed"), num("skipped_count", "Skipped (no consent)"), date("created_at", "Created"), date("started_at", "Started"), date("finished_at", "Finished")],
  },
  campaign_recipients: {
    key: "campaign_recipients", label: "Campaign recipients", description: "Per-recipient delivery, open and click outcomes.", from: "campaign_recipients", table: "campaign_recipients", scopeColumn: "user_id", area: "crm", defaultDate: "created_at",
    fields: [dim("id", "Recipient"), dim("campaign_id", "Campaign"), dim("contact_id", "Contact"), dim("status", "Status"), dim("opened", "Opened", "(opened_at IS NOT NULL)::text"), dim("clicked", "Clicked", "(clicked_at IS NOT NULL)::text"), date("created_at", "Added"), date("sent_at", "Sent"), date("opened_at", "Opened at"), date("clicked_at", "Clicked at")],
  },
  projects: {
    key: "projects", label: "Projects", description: "Projects by status, owner and client with budget.", from: "projects", table: "projects", scopeColumn: "user_id", area: "tasks", defaultDate: "created_at", currencyColumn: "currency",
    fields: [dim("id", "Project"), dim("name", "Name"), dim("code", "Code"), dim("status", "Status"), dim("billing_mode", "Billing mode"), dim("contact_id", "Client"), dim("owner_member_id", "Owner"), dim("currency", "Currency"), money("budget_minor", "Budget"), money("hourly_rate_minor", "Hourly rate"), date("starts_on", "Starts"), date("due_on", "Due"), date("archived_at", "Archived"), date("created_at", "Created"), date("updated_at", "Updated")],
  },
  project_milestones: {
    key: "project_milestones", label: "Project milestones", description: "Milestones by project and status with due and completion dates.", from: "project_milestones", table: "project_milestones", scopeColumn: "user_id", area: "tasks", defaultDate: "due_on",
    fields: [dim("id", "Milestone"), dim("project_id", "Project"), dim("name", "Name"), dim("status", "Status"), num("sort", "Order"), date("due_on", "Due"), date("completed_at", "Completed"), date("created_at", "Created")],
  },
};

export const RECORDS_DATASET_PREFIX = "records:";

/** Base fields every records dataset has, before the type's own fields are appended. */
const RECORD_BASE_FIELDS: DatasetField[] = [dim("id", "Record"), dim("title", "Title"), dim("stage", "Stage"), dim("contact_id", "Contact"), dim("assigned_to", "Assignee"), dim("currency", "Currency"), money("amount_minor", "Amount"), date("created_at", "Created"), date("updated_at", "Updated"), date("due_at", "Due")];

const JSON_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * Build a dataset for one record type. JSON keys are taken from the type's
 * stored field definitions (snake_case validated) and bound as parameters by
 * the compiler, never interpolated.
 */
export function recordsDataset(type: { id: string; name: string; fields: FieldDef[] }): Dataset {
  const base = new Set(RECORD_BASE_FIELDS.map((f) => f.key));
  const extra: DatasetField[] = [];
  for (const f of type.fields) {
    if (!JSON_KEY_RE.test(f.key) || base.has(`f_${f.key}`)) continue;
    const key = `f_${f.key}`;
    if (f.type === "number") extra.push({ key, label: f.label, kind: "measure", jsonKey: f.key, format: "number", aggregations: MEASURE });
    else if (f.type === "money") extra.push({ key, label: f.label, kind: "measure", jsonKey: f.key, format: "money", aggregations: MEASURE });
    else if (f.type === "date") extra.push({ key, label: f.label, kind: "date", jsonKey: f.key, aggregations: ["count", "count_distinct", "min", "max"] });
    else if (f.type === "textarea") continue;
    else extra.push({ key, label: f.label, kind: "dimension", jsonKey: f.key, aggregations: ["count", "count_distinct"] });
  }
  return {
    key: `${RECORDS_DATASET_PREFIX}${type.id}`,
    label: type.name,
    description: `Records of type ${type.name}.`,
    from: "records",
    table: "records",
    scopeColumn: "user_id",
    area: "crm",
    deletedColumn: "deleted_at",
    defaultDate: "created_at",
    currencyColumn: "currency",
    where: "type_id = {{type_id}}",
    fields: [...RECORD_BASE_FIELDS, ...extra],
  };
}

export function isRecordsDatasetKey(key: string): boolean {
  return key.startsWith(RECORDS_DATASET_PREFIX) && key.length > RECORDS_DATASET_PREFIX.length && key.length <= 140;
}

export function recordTypeIdFromKey(key: string): string | null {
  return isRecordsDatasetKey(key) ? key.slice(RECORDS_DATASET_PREFIX.length) : null;
}

export function fieldByKey(ds: Dataset, key: string): DatasetField | null {
  return ds.fields.find((f) => f.key === key) ?? null;
}

/** Catalogue entry as the API exposes it (fields + allowed aggregations). */
export function describeDataset(ds: Dataset) {
  return {
    key: ds.key,
    label: ds.label,
    description: ds.description,
    area: ds.area,
    default_date: ds.defaultDate,
    fields: ds.fields.map((f) => ({ key: f.key, label: f.label, kind: f.kind, format: f.format ?? null, aggregations: f.aggregations ?? (f.kind === "dimension" ? ["count", "count_distinct"] : MEASURE) })),
  };
}
export type DatasetDescription = ReturnType<typeof describeDataset>;
