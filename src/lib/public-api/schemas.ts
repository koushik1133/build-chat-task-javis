import { z } from "zod";
import { AREAS } from "@/lib/auth/roles";
import { EVENT_TYPES } from "@/lib/events/bus";
import { LineItemSchema } from "@/lib/money/items";
import { TransferCreateSchema } from "@/lib/inventory/transfers";
import { LOCATION_KINDS } from "@/lib/inventory/locations-pure";
import { ProductInputSchema, ProductPatchSchema, PRODUCT_KINDS } from "@/lib/inventory/products";
import { TICKET_PRIORITIES, TICKET_SOURCES, TICKET_STATUSES } from "@/lib/helpdesk/sla";
import { VoucherInputSchema } from "@/lib/engagement/pure";
import { ChartConfigSchema, ReportSpecSchema } from "@/lib/reports/spec";
import { LayoutItemSchema } from "@/lib/reports/store";
import { StaffInputSchema } from "@/lib/workforce/staff";
import { ShiftInputSchema } from "@/lib/workforce/shifts";
import { LeaveRequestSchema } from "@/lib/workforce/leave";
import { EMPLOYMENT_TYPES, LEAVE_KINDS, LEAVE_STATUSES, SHIFT_STATUSES } from "@/lib/workforce/pure";
import { MilestoneInputSchema, ProjectInputSchema, ProjectPatchSchema, ProjectTaskInputSchema, PROJECT_STATUSES } from "@/lib/projects/pure";

/**
 * Zod schemas for every /api/v1 request and response. The route registry
 * references these, the handlers parse with them, and the OpenAPI document is
 * derived from them — one source of truth.
 *
 * Response schemas describe the shape for docs; handlers return lib DTOs as-is.
 */

export const Id = z.string().min(1).max(100).describe("Resource id");
const Iso = z.string().datetime({ offset: true }).describe("ISO-8601 timestamp");
const IsoOrNull = Iso.nullable();
const MaybeIso = z.string().min(1).max(40).describe("ISO-8601 timestamp");

export const IdParams = z.object({ id: Id });

export const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().describe("Page size (default 50, max 200)"),
  cursor: z.string().max(512).optional().describe("Opaque cursor from `meta.next_cursor`"),
});
export const SearchListQuery = ListQuery.extend({ q: z.string().max(200).optional().describe("Free-text search") });

/* ─── Contacts ─────────────────────────────────────────────────────────── */

export const Contact = z.object({
  id: Id,
  full_name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  company: z.string().nullable(),
  role: z.string().nullable(),
  tags: z.array(z.string()),
  lifecycle: z.string(),
  notes: z.string().nullable(),
  deal_value: z.number(),
  domain: z.string(),
  last_contact: IsoOrNull,
  created_at: Iso,
  updated_at: Iso,
});
export const ContactCreate = z
  .object({
    full_name: z.string().trim().min(1).max(200),
    email: z.string().trim().email().max(320).nullable().optional(),
    phone: z.string().trim().max(40).nullable().optional(),
    company: z.string().trim().max(200).nullable().optional(),
    role: z.string().trim().max(120).nullable().optional(),
    tags: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
    lifecycle: z.string().trim().min(1).max(40).optional().describe("lead | prospect | customer | churned | …"),
    notes: z.string().max(10_000).nullable().optional(),
    deal_value: z.number().min(0).max(1_000_000_000).optional(),
    domain: z.string().trim().min(1).max(40).optional(),
  })
  .strict();
export const ContactPatch = ContactCreate.partial().strict();
export const ContactListQuery = SearchListQuery.extend({
  lifecycle: z.string().max(40).optional(),
  domain: z.string().max(40).optional(),
});

/* ─── Tasks ────────────────────────────────────────────────────────────── */

export const TaskPriority = z.enum(["low", "normal", "high", "urgent"]);
export const Task = z.object({
  id: Id,
  title: z.string(),
  done: z.boolean(),
  chat_id: z.string().nullable(),
  due_at: Iso.nullable().describe("Due date-time (ISO 8601); null when none"),
  assignee_id: z.string().nullable().describe("Member user id the task is assigned to"),
  priority: TaskPriority,
  overdue: z.boolean().describe("Open and past due_at"),
  created_at: Iso,
});
const TaskFields = {
  due_at: z.string().datetime({ offset: true }).nullable().optional(),
  assignee_id: z.string().trim().min(1).max(100).nullable().optional(),
  priority: TaskPriority.optional(),
};
export const TaskCreate = z.object({ title: z.string().trim().min(1).max(200), ...TaskFields }).strict();
export const TaskPatch = z.object({ title: z.string().trim().min(1).max(200).optional(), done: z.boolean().optional(), ...TaskFields }).strict();
export const TaskListQuery = ListQuery.extend({
  done: z.enum(["true", "false"]).optional(),
  assignee_id: z.string().max(100).optional().describe("Only tasks assigned to this member user id"),
  overdue: z.enum(["true"]).optional().describe("Only open tasks past their due date"),
});

/* ─── Money ────────────────────────────────────────────────────────────── */

export const LineItem = LineItemSchema;
const Money = z.number().int().describe("Minor units (cents)");
const Currency = z.string().length(3).describe("ISO 4217");

export const Quote = z.object({
  id: Id,
  number: z.string(),
  status: z.enum(["draft", "sent", "viewed", "accepted", "declined", "expired"]),
  contact_id: Id.nullable(),
  contact_name: z.string().nullable(),
  contact_email: z.string().nullable(),
  currency: Currency,
  subtotal_minor: Money,
  tax_minor: Money,
  total_minor: Money,
  valid_until: IsoOrNull,
  terms_version: z.string().nullable(),
  terms_text: z.string().nullable(),
  notes: z.string().nullable(),
  current_version: z.number().int(),
  items: z.array(LineItem),
  tax_breakdown: z.array(z.object({ rate_id: Id.nullable(), name: z.string(), rate_bp: z.number().int(), compound: z.boolean(), taxable_minor: Money, tax_minor: Money })).optional(),
  created_at: Iso,
  updated_at: Iso,
  sent_at: IsoOrNull,
  accepted_at: IsoOrNull,
});
export const QuoteCreate = z
  .object({
    contact_id: Id.nullable().optional(),
    currency: z.string().trim().length(3).optional(),
    items: z.array(LineItem).min(1).max(200),
    valid_until: MaybeIso.nullable().optional(),
    terms_text: z.string().max(10_000).nullable().optional(),
    notes: z.string().max(10_000).nullable().optional(),
  })
  .strict();
export const SendBody = z
  .object({
    to: z.string().trim().email().max(320).nullable().optional().describe("Recipient; defaults to the contact's email"),
    message: z.string().max(5000).nullable().optional(),
  })
  .strict();
export const SendResult = z.object({ url: z.string().url().describe("Public share link"), path: z.string() });
export const QuoteListQuery = ListQuery.extend({ status: z.string().max(20).optional() });

export const Invoice = z.object({
  id: Id,
  number: z.string(),
  status: z.enum(["draft", "sent", "partially_paid", "paid", "void", "overdue"]),
  contact_id: Id.nullable(),
  contact_name: z.string().nullable(),
  contact_email: z.string().nullable(),
  quote_id: Id.nullable(),
  currency: Currency,
  subtotal_minor: Money,
  tax_minor: Money,
  total_minor: Money,
  paid_minor: Money,
  due_at: IsoOrNull,
  terms_days: z.number().int().nullable().optional(),
  reminder_count: z.number().int().optional(),
  items: z.array(LineItem),
  tax_breakdown: z.array(z.object({ rate_id: Id.nullable(), name: z.string(), rate_bp: z.number().int(), compound: z.boolean(), taxable_minor: Money, tax_minor: Money })).optional(),
  notes: z.string().nullable(),
  created_at: Iso,
  updated_at: Iso,
  sent_at: IsoOrNull,
  paid_at: IsoOrNull,
});
export const InvoiceCreate = z
  .object({
    contact_id: Id.nullable().optional(),
    quote_id: Id.nullable().optional(),
    currency: z.string().trim().length(3).optional(),
    items: z.array(LineItem).min(1).max(200),
    due_at: MaybeIso.nullable().optional(),
    terms_days: z.number().int().min(0).max(365).nullable().optional().describe("Payment terms; due date = send date + terms"),
    notes: z.string().max(10_000).nullable().optional(),
  })
  .strict();
export const PaymentCreate = z
  .object({
    amount_minor: z.number().int().positive().max(1_000_000_000_000),
    currency: z.string().trim().length(3).optional().describe("Defaults to the invoice currency"),
    reference: z.string().trim().max(200).nullable().optional().describe("External reference; replays with the same reference are ignored"),
    provider: z.string().trim().min(1).max(40).optional().describe("Defaults to `manual`"),
  })
  .strict();
export const PaymentResult = z.object({ invoice: Invoice, duplicate: z.boolean() });
export const InvoiceListQuery = ListQuery.extend({ status: z.string().max(20).optional() });

/* ─── Billing depth: tax rates, schedules, credit notes ────────────────── */

export const TaxBreakdownRow = z.object({
  rate_id: Id.nullable(),
  name: z.string(),
  rate_bp: z.number().int(),
  compound: z.boolean(),
  taxable_minor: Money,
  tax_minor: Money,
});
export const TaxRate = z.object({
  id: Id,
  name: z.string(),
  rate_bp: z.number().int().describe("Basis points (1000 = 10%)"),
  kind: z.enum(["vat", "gst", "sales", "other"]),
  jurisdiction: z.string().nullable(),
  compound: z.boolean(),
  is_default: z.boolean(),
  active: z.boolean(),
  created_at: Iso,
});
export const TaxRateListQuery = ListQuery.extend({ all: z.enum(["true", "false"]).optional().describe("Include inactive rates") });

export const InvoiceSchedule = z.object({
  id: Id,
  name: z.string(),
  contact_id: Id.nullable(),
  contact_name: z.string().nullable(),
  contact_email: z.string().nullable(),
  items: z.array(LineItem),
  currency: Currency,
  interval: z.enum(["weekly", "monthly", "quarterly", "yearly"]),
  interval_count: z.number().int(),
  day_of_month: z.number().int().nullable(),
  next_run_at: Iso,
  end_at: IsoOrNull,
  auto_send: z.boolean(),
  terms_days: z.number().int().nullable(),
  notes: z.string().nullable(),
  status: z.enum(["active", "paused", "ended"]),
  last_invoice_id: Id.nullable(),
  last_run_at: IsoOrNull,
  run_count: z.number().int(),
  created_at: Iso,
  updated_at: Iso,
});
export const InvoiceScheduleListQuery = ListQuery.extend({ status: z.enum(["active", "paused", "ended"]).optional() });

export const CreditNote = z.object({
  id: Id,
  number: z.string(),
  status: z.enum(["draft", "issued", "applied", "refunded"]),
  invoice_id: Id.nullable(),
  invoice_number: z.string().nullable(),
  contact_id: Id.nullable(),
  contact_name: z.string().nullable(),
  contact_email: z.string().nullable(),
  items: z.array(LineItem),
  subtotal_minor: Money,
  tax_minor: Money,
  total_minor: Money,
  tax_breakdown: z.array(TaxBreakdownRow),
  currency: Currency,
  reason: z.string().nullable(),
  issued_at: IsoOrNull,
  created_at: Iso,
  updated_at: Iso,
});
export const CreditNoteListQuery = ListQuery.extend({
  status: z.enum(["draft", "issued", "applied", "refunded"]).optional(),
  invoice_id: Id.optional(),
  contact_id: Id.optional(),
});

/* ─── Calendar ─────────────────────────────────────────────────────────── */

export const Booking = z.object({
  id: Id,
  calendar_id: Id,
  booking_type_id: Id.nullable(),
  contact_id: Id.nullable(),
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  starts_at: Iso,
  ends_at: Iso,
  status: z.enum(["confirmed", "cancelled", "completed", "no_show"]),
  notes: z.string().nullable(),
  source: z.enum(["manual", "public", "agent", "portal"]),
  created_at: Iso,
  updated_at: Iso,
});
export const BookingListQuery = ListQuery.extend({
  from: MaybeIso.optional().describe("Only bookings starting at or after this instant"),
  to: MaybeIso.optional().describe("Only bookings starting before this instant"),
  status: z.enum(["confirmed", "cancelled", "completed", "no_show"]).optional(),
});
export const BookingCancel = z.object({ reason: z.string().trim().max(500).nullable().optional() }).strict();
export const BookingType = z.object({
  id: Id,
  calendar_id: Id,
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  duration_minutes: z.number().int(),
  buffer_before: z.number().int(),
  buffer_after: z.number().int(),
  min_notice_minutes: z.number().int(),
  max_days_ahead: z.number().int(),
  price_minor: Money.nullable(),
  currency: Currency.nullable(),
  active: z.boolean(),
  created_at: Iso,
});
export const AvailabilityQuery = z.object({
  booking_type_id: Id,
  from: MaybeIso.optional().describe("Defaults to now"),
  to: MaybeIso.optional().describe("Defaults to from + 14 days (max 60)"),
});
export const Availability = z.object({ timezone: z.string(), slots: z.array(Iso).describe("Bookable start instants") });

/* ─── Helpdesk ─────────────────────────────────────────────────────────── */

export const Ticket = z.object({
  id: Id,
  number: z.number().int(),
  subject: z.string(),
  status: z.enum(TICKET_STATUSES),
  priority: z.enum(TICKET_PRIORITIES),
  source: z.enum(TICKET_SOURCES),
  contact_id: Id.nullable(),
  requester_email: z.string().nullable(),
  requester_name: z.string().nullable(),
  assigned_to: z.string().nullable(),
  first_response_due_at: IsoOrNull,
  resolution_due_at: IsoOrNull,
  first_responded_at: IsoOrNull,
  resolved_at: IsoOrNull,
  breached_first_response: z.boolean(),
  breached_resolution: z.boolean(),
  tags: z.array(z.string()),
  created_at: Iso,
  updated_at: Iso,
});
export const TicketMessage = z.object({
  id: Id,
  ticket_id: Id,
  author_kind: z.enum(["agent", "customer", "ai", "system"]),
  author_id: z.string().nullable(),
  body: z.string(),
  is_internal: z.boolean(),
  created_at: Iso,
});
export const TicketDetail = Ticket.extend({ messages: z.array(TicketMessage) });
export const TicketCreate = z
  .object({
    subject: z.string().trim().min(1).max(300),
    body: z.string().max(20_000).nullable().optional().describe("First message"),
    priority: z.enum(TICKET_PRIORITIES).optional(),
    source: z.enum(TICKET_SOURCES).optional().describe("Defaults to `manual`"),
    contact_id: Id.nullable().optional(),
    requester_email: z.string().trim().email().max(200).nullable().optional(),
    requester_name: z.string().trim().max(200).nullable().optional(),
    assigned_to: z.string().max(100).nullable().optional(),
    tags: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
  })
  .strict();
export const TicketReply = z
  .object({
    body: z.string().trim().min(1).max(20_000),
    is_internal: z.boolean().optional().describe("Internal note (not visible to the customer)"),
    author_kind: z.enum(["agent", "customer", "ai"]).optional().describe("Defaults to `agent`"),
  })
  .strict();
export const TicketReplyResult = z.object({ message: TicketMessage, ticket: Ticket });
export const TicketListQuery = SearchListQuery.extend({
  status: z.enum(["active", "all", ...TICKET_STATUSES]).optional(),
  priority: z.enum(TICKET_PRIORITIES).optional(),
  contact_id: Id.optional(),
});

/* ─── Records ──────────────────────────────────────────────────────────── */

export const RecordTypeParams = z.object({ type: z.string().min(1).max(100).describe("Record type id or slug") });
export const RecordParams = RecordTypeParams.extend({ id: Id });
export const RecordType = z.object({
  id: Id,
  slug: z.string(),
  name: z.string(),
  icon: z.string().nullable(),
  description: z.string().nullable(),
  fields: z.array(z.object({ key: z.string(), label: z.string(), type: z.string(), required: z.boolean().optional(), options: z.array(z.string()).optional() })),
  stages: z.array(z.object({ key: z.string(), label: z.string(), color: z.string().optional() })),
  pack_slug: z.string().nullable(),
  created_at: Iso,
  updated_at: Iso,
});
export const RecordItem = z.object({
  id: Id,
  type_id: Id,
  title: z.string(),
  stage: z.string(),
  data: z.record(z.unknown()).describe("Field values keyed by field key"),
  summary: z.string().nullable(),
  contact_id: Id.nullable(),
  amount_minor: Money.nullable(),
  currency: Currency.nullable(),
  due_at: IsoOrNull,
  assigned_to: z.string().nullable(),
  created_at: Iso,
  updated_at: Iso,
});
export const RecordCreate = z
  .object({
    title: z.string().trim().min(1).max(300),
    stage: z.string().max(100).nullable().optional(),
    data: z.record(z.unknown()).optional(),
    summary: z.string().max(4000).nullable().optional(),
    currency: z.string().length(3).nullable().optional(),
    assigned_to: z.string().max(100).nullable().optional(),
  })
  .strict();
export const RecordPatch = RecordCreate.omit({ stage: true }).partial().strict();
export const RecordMove = z.object({ stage: z.string().min(1).max(100) }).strict();
export const RecordListQuery = SearchListQuery.extend({ stage: z.string().max(100).optional() });

/* ─── Inventory ────────────────────────────────────────────────────────── */

export const Product = z.object({
  id: Id,
  sku: z.string().nullable(),
  name: z.string(),
  description: z.string().nullable(),
  kind: z.enum(PRODUCT_KINDS),
  unit: z.string(),
  unit_price_minor: Money,
  cost_minor: Money,
  currency: Currency,
  tax_rate_bp: z.number().int().describe("Basis points (1000 = 10%)"),
  track_stock: z.boolean(),
  stock_on_hand: z.number().int(),
  stock_reserved: z.number().int(),
  stock_available: z.number().int(),
  reorder_point: z.number().int(),
  low_stock: z.boolean(),
  active: z.boolean(),
  created_at: Iso,
  updated_at: Iso,
});
export const ProductCreate = ProductInputSchema;
export const ProductPatch = ProductPatchSchema;
export const StockAdjust = z
  .object({
    kind: z.enum(["receive", "adjust", "consume"]).describe("receive/consume: positive qty; adjust: signed delta"),
    qty: z.number().int().min(-100_000_000).max(100_000_000),
    note: z.string().max(500).nullable().optional(),
  })
  .strict();
export const ProductListQuery = SearchListQuery.extend({
  kind: z.enum(PRODUCT_KINDS).optional(),
  low: z.enum(["true", "false"]).optional().describe("Only products at/below their reorder point"),
  include_inactive: z.enum(["true", "false"]).optional(),
});

/* ─── Locations, stock levels, transfers ───────────────────────────────── */

export const Location = z.object({
  id: Id,
  name: z.string(),
  code: z.string().nullable(),
  kind: z.enum(LOCATION_KINDS),
  address: z.record(z.unknown()).nullable(),
  active: z.boolean(),
  is_default: z.boolean(),
  created_at: Iso,
  updated_at: Iso,
});
export const LocationListQuery = z.object({ include_inactive: z.enum(["true", "false"]).optional() });
export const StockLevel = z.object({
  product_id: Id,
  product_name: z.string(),
  product_sku: z.string().nullable(),
  location_id: Id,
  location_name: z.string(),
  on_hand: z.number().int(),
  reserved: z.number().int(),
  available: z.number().int(),
  reorder_point: z.number().int().nullable(),
  low: z.boolean(),
});
export const StockLevelQuery = z.object({ product: Id.optional(), location: Id.optional() });
export const Transfer = z.object({
  id: Id,
  number: z.string(),
  from_location_id: Id,
  to_location_id: Id,
  from_name: z.string().nullable(),
  to_name: z.string().nullable(),
  status: z.enum(["draft", "in_transit", "received", "cancelled"]),
  note: z.string().nullable(),
  shipped_at: IsoOrNull,
  received_at: IsoOrNull,
  created_at: Iso,
  lines: z.array(z.object({ id: Id, product_id: Id, product_name: z.string().nullable(), qty: z.number().int(), received_qty: z.number().int(), remaining: z.number().int() })),
});
export const TransferCreate = TransferCreateSchema;
export const TransferListQuery = ListQuery.extend({ status: z.enum(["draft", "in_transit", "received", "cancelled"]).optional() });

/* ─── Events / webhooks / me ───────────────────────────────────────────── */

export const EventTypeEnum = z.enum(EVENT_TYPES);
export const Event = z.object({
  id: Id,
  type: z.string().describe("e.g. crm.contact.created"),
  entity: z.string(),
  entity_id: z.string(),
  data: z.record(z.unknown()),
  created_at: Iso,
});
export const EventListQuery = ListQuery.extend({
  type: z.string().max(80).optional().describe("Exact event type"),
  since: MaybeIso.optional().describe("Only events created after this instant"),
});

export const WebhookSubscription = z.object({
  id: Id,
  url: z.string().url(),
  event_types: z.array(z.string()).describe('Event types, or ["*"] for all'),
  active: z.boolean(),
  description: z.string().nullable(),
  created_at: Iso,
  last_success_at: IsoOrNull,
  last_failure_at: IsoOrNull,
  failure_count: z.number().int(),
});
export const WebhookCreated = WebhookSubscription.extend({ secret: z.string().describe("Signing secret — shown once") });
export const WebhookCreate = z
  .object({
    url: z.string().url().max(2048).describe("HTTPS endpoint"),
    event_types: z.array(z.string().min(1).max(80)).min(1).max(100).optional().describe('Defaults to ["*"]'),
    description: z.string().trim().max(200).nullable().optional(),
  })
  .strict();
export const WebhookPatch = z
  .object({
    url: z.string().url().max(2048).optional(),
    event_types: z.array(z.string().min(1).max(80)).min(1).max(100).optional(),
    description: z.string().trim().max(200).nullable().optional(),
    active: z.boolean().optional(),
  })
  .strict();
export const WebhookEventParams = z.object({ event: z.string().min(1).max(80) });
export const WebhookSample = z.object({
  id: Id,
  type: z.string(),
  created_at: Iso,
  entity: z.string(),
  entity_id: z.string(),
  data: z.record(z.unknown()),
});

export const WebhookEventType = z.object({
  type: z.string().describe("Event type, e.g. invoice.paid"),
  entity: z.string().describe("Entity kind carried in `entity`"),
  sample: WebhookSample,
});
export const WebhookEventTypeList = z.array(WebhookEventType);

export const Me = z.object({
  key: z.object({ id: Id, name: z.string(), prefix: z.string(), scopes: z.array(z.string()), created_at: Iso, last_used_at: IsoOrNull }),
  user: z.object({ id: Id }),
  org: z.object({ id: Id, name: z.string(), slug: z.string() }).nullable(),
  rate_limit: z.object({ limit: z.number().int(), remaining: z.number().int(), reset: z.number().int().describe("Unix seconds") }),
  areas: z.array(z.enum(AREAS)),
});

export const Deleted = z.object({ id: Id, deleted: z.literal(true) });
export const OpenApiDoc = z.record(z.unknown()).describe("OpenAPI 3.1 document");

/* ═══════════════════════════════════════════════════════════════════════════
 * Phase 6 — API breadth. Response schemas mirror the lib DTOs; request
 * schemas reuse the lib zod schemas wherever one exists.
 * ═══════════════════════════════════════════════════════════════════════════ */

import { ExpenseInputSchema, ExpensePatchSchema, EXPENSE_CATEGORIES } from "@/lib/finance/expenses";
import { TimeEntryInputSchema } from "@/lib/finance/time";
import { ChangeOrderInputSchema, CO_STATUSES } from "@/lib/finance/change-orders";
import { ArticleBodySchema, ArticlePatchSchema } from "@/lib/kb/http";
import { RecordTypeInputSchema, RecordTypePatchSchema } from "@/lib/records/schema";
import { LISTING_KINDS, CATEGORIES as MARKETPLACE_CATEGORIES, SORTS as MARKETPLACE_SORTS, VISIBILITIES } from "@/lib/marketplace/types";
import { CONSENT_PURPOSES, CONSENT_SOURCES, CONSENT_SUBJECT_KINDS, DSR_KINDS, DSR_STATUSES, DSR_SUBJECT_KINDS } from "@/lib/privacy/constants";
import { CAMPAIGN_STATUSES } from "@/lib/voice/window";
import { VOICES } from "@/lib/voice/twiml";
import { ACCOUNTING_ENTITY_KINDS } from "@/lib/accounting/types";

const Minor = z.number().int().describe("Integer minor units (cents)");
const RefKind = z.string().trim().min(1).max(40).regex(/^[a-z_]+$/).describe("Linked entity kind, e.g. `quote`, `invoice`, `record`");

/* ─── Expenses ─────────────────────────────────────────────────────────── */
export const Expense = z.object({
  id: Id,
  category: z.string(),
  vendor: z.string().nullable(),
  description: z.string().nullable(),
  amount_minor: Minor,
  currency: z.string(),
  tax_minor: Minor,
  total_minor: Minor,
  spent_at: MaybeIso,
  receipt_url: z.string().nullable(),
  ref_kind: z.string().nullable(),
  ref_id: z.string().nullable(),
  billable: z.boolean(),
  invoice_id: z.string().nullable(),
  created_by: z.string().nullable(),
  created_at: MaybeIso,
});
export const ExpenseCreate = ExpenseInputSchema;
export const ExpensePatch = ExpensePatchSchema;
export const ExpenseListQuery = ListQuery.extend({
  from: z.string().max(40).optional().describe("ISO lower bound on spent_at"),
  to: z.string().max(40).optional().describe("ISO upper bound on spent_at"),
  ref: z.string().max(140).optional().describe("`kind:id` filter, e.g. `quote:abc`"),
  unbilled: z.enum(["true", "false"]).optional().describe("Only billable expenses not yet invoiced"),
  category: z.enum(EXPENSE_CATEGORIES).optional(),
});

/* ─── Time entries ─────────────────────────────────────────────────────── */
export const TimeEntry = z.object({
  id: Id,
  member_id: z.string().nullable(),
  ref_kind: z.string().nullable(),
  ref_id: z.string().nullable(),
  description: z.string().nullable(),
  started_at: MaybeIso,
  ended_at: MaybeIso.nullable(),
  minutes: z.number().int().nullable(),
  running: z.boolean(),
  rate_minor: Minor.describe("Hourly rate, minor units"),
  currency: z.string(),
  value_minor: Minor,
  billable: z.boolean(),
  invoice_id: z.string().nullable(),
  created_at: MaybeIso,
});
export const TimeEntryCreate = TimeEntryInputSchema;
export const TimerStart = z
  .object({
    ref_kind: RefKind.nullable().optional(),
    ref_id: z.string().trim().max(100).nullable().optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    member_id: z.string().trim().max(100).nullable().optional(),
    rate_minor: z.number().int().min(0).max(1_000_000_000).optional(),
    currency: z.string().length(3).optional(),
    billable: z.boolean().optional(),
  })
  .strict();
export const TimerStop = z.object({ ended_at: z.string().datetime({ offset: true }).optional().describe("Defaults to now") }).strict();
export const TimeEntryListQuery = ListQuery.extend({
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  ref_kind: z.string().max(40).optional(),
  ref_id: z.string().max(100).optional(),
  member_id: z.string().max(100).optional(),
  running: z.enum(["true", "false"]).optional().describe("Only running timers"),
  unbilled: z.enum(["true", "false"]).optional(),
});

/* ─── Equipment checkouts ──────────────────────────────────────────────── */
export const EquipmentCheckout = z.object({
  id: Id,
  product_id: Id,
  product_name: z.string(),
  product_sku: z.string().nullable(),
  qty: z.number().int(),
  checked_out_to: z.string().nullable(),
  ref_kind: z.string().nullable(),
  ref_id: z.string().nullable(),
  due_back_at: MaybeIso.nullable(),
  returned_at: MaybeIso.nullable(),
  overdue: z.boolean(),
  created_at: MaybeIso,
});
export const EquipmentCheckoutCreate = z
  .object({
    product_id: Id,
    qty: z.number().int().min(1).max(100_000).default(1),
    checked_out_to: z.string().trim().max(200).nullable().optional(),
    ref_kind: RefKind.nullable().optional(),
    ref_id: z.string().trim().max(100).nullable().optional(),
    due_back_at: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict();
export const EquipmentListQuery = ListQuery.extend({ open: z.enum(["true", "false"]).optional().describe("Only items still out") });

/* ─── Change orders ────────────────────────────────────────────────────── */
export const ChangeOrder = z.object({
  id: Id,
  quote_id: z.string().nullable(),
  invoice_id: z.string().nullable(),
  number: z.number().int(),
  label: z.string().describe("Display number, e.g. CO-0004"),
  title: z.string(),
  description: z.string().nullable(),
  items: z.array(LineItem),
  delta_minor: Minor,
  currency: z.string(),
  status: z.enum(CO_STATUSES),
  accepted_at: MaybeIso.nullable(),
  created_at: MaybeIso,
  updated_at: MaybeIso,
});
export const ChangeOrderCreate = ChangeOrderInputSchema;
export const ChangeOrderStatus = z.object({ status: z.enum(CO_STATUSES) }).strict();
export const ChangeOrderStatusResult = z.object({ change_order: ChangeOrder, invoice: Invoice.nullable().describe("Draft invoice created/updated when accepted") });
export const ChangeOrderListQuery = ListQuery.extend({
  quote_id: z.string().max(100).optional(),
  invoice_id: z.string().max(100).optional(),
  status: z.enum(CO_STATUSES).optional(),
});

/* ─── SLA policies ─────────────────────────────────────────────────────── */
export const SlaPolicy = z.object({
  id: Id,
  name: z.string(),
  first_response_minutes: z.number().int(),
  resolution_minutes: z.number().int(),
  business_hours_only: z.boolean(),
  priority_overrides: z.record(z.unknown()).nullable(),
  is_default: z.boolean(),
  created_at: MaybeIso,
});
export const SlaPolicyCreate = z
  .object({
    name: z.string().trim().min(1).max(120),
    first_response_minutes: z.number().int().min(1).max(60 * 24 * 30).optional(),
    resolution_minutes: z.number().int().min(1).max(60 * 24 * 90).optional(),
    business_hours_only: z.boolean().optional(),
    priority_overrides: z.record(z.unknown()).nullable().optional(),
    is_default: z.boolean().optional(),
  })
  .strict();
export const SlaPolicyPatch = SlaPolicyCreate.partial().strict();

/* ─── Knowledge base ───────────────────────────────────────────────────── */
export const KbArticle = z.object({
  id: Id,
  slug: z.string(),
  title: z.string(),
  body_md: z.string(),
  excerpt: z.string().nullable(),
  category: z.string().nullable(),
  tags: z.array(z.string()),
  status: z.enum(["draft", "published"]),
  is_public: z.boolean(),
  views: z.number().int(),
  source_ticket_ids: z.array(z.string()),
  created_at: MaybeIso,
  updated_at: MaybeIso,
  published_at: MaybeIso.nullable(),
});
export const KbArticleCreate = ArticleBodySchema;
export const KbArticlePatch = ArticlePatchSchema.strict();
export const KbArticleListQuery = SearchListQuery.extend({
  status: z.enum(["draft", "published"]).optional(),
  category: z.string().max(100).optional(),
  public: z.enum(["true", "false"]).optional(),
});
export const KbSearchQuery = z.object({
  q: z.string().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  drafts: z.enum(["true", "false"]).optional().describe("Include draft articles"),
});
export const KbHit = z.object({
  id: Id,
  slug: z.string(),
  title: z.string(),
  excerpt: z.string().nullable(),
  category: z.string().nullable(),
  status: z.enum(["draft", "published"]),
  is_public: z.boolean(),
  score: z.number(),
  snippet: z.string().nullable(),
});

/* ─── Record types (write) ─────────────────────────────────────────────── */
export const RecordTypeCreate = RecordTypeInputSchema.strict();
export const RecordTypePatch = RecordTypePatchSchema.strict();

/* ─── Marketplace ──────────────────────────────────────────────────────── */
export const Listing = z.object({
  id: z.string(),
  kind: z.enum(LISTING_KINDS),
  slug: z.string(),
  title: z.string(),
  summary: z.string().nullable(),
  description_md: z.string().nullable(),
  category: z.string().nullable(),
  tags: z.array(z.string()),
  version: z.number().int(),
  visibility: z.enum(VISIBILITIES),
  install_count: z.number().int(),
  rating_avg: z.number().nullable(),
  rating_count: z.number().int(),
  builtin: z.boolean(),
  publisher: z.string(),
  owner: z.boolean(),
  installed: z.boolean(),
  created_at: MaybeIso,
  updated_at: MaybeIso,
  published_at: MaybeIso.nullable(),
});
export const ListingDetail = Listing.extend({ definition: z.unknown().describe("Portable definition (agent, playbook, automation or record pack)") });
export const ListingListQuery = SearchListQuery.extend({
  kind: z.enum(LISTING_KINDS).optional(),
  category: z.enum(MARKETPLACE_CATEGORIES).optional(),
  sort: z.enum(MARKETPLACE_SORTS).optional(),
});
export const ListingParams = z.object({ id: z.string().min(1).max(160).describe("Listing id (`builtin:…` ids allowed)") });
export const InstallResult = z.object({
  listing: Listing,
  entity_kind: z.enum(LISTING_KINDS),
  entity_id: z.string(),
  created: z.boolean(),
  note: z.string().nullable(),
});

/* ─── Plan & usage ─────────────────────────────────────────────────────── */
export const PlanUsage = z.object({
  plan: z.enum(["free", "starter", "growth", "scale", "enterprise"]),
  status: z.enum(["trialing", "active", "past_due", "cancelled", "paused"]),
  enforced: z.boolean().describe("True when plan limits are enforced for this deployment"),
  trial_ends_at: z.string().nullable(),
  limits: z.record(z.string(), z.number().nullable()).describe("Entitlement limits; null = unlimited"),
  features: z.record(z.string(), z.boolean()),
  usage: z.record(z.string(), z.number()),
});

/* ─── Credits ──────────────────────────────────────────────────────────── */
export const CreditBalance = z.object({ balance: z.number().int().describe("Credits available") });
export const LedgerEntry = z.object({
  id: Id,
  kind: z.enum(["purchase", "grant", "usage", "outcome", "refund", "adjustment"]),
  credits: z.number().int().describe("Signed delta"),
  balance_after: z.number().int(),
  ref_kind: z.string().nullable(),
  ref_id: z.string().nullable(),
  note: z.string().nullable(),
  created_at: MaybeIso,
});

/* ─── Privacy ──────────────────────────────────────────────────────────── */
export const ConsentRecord = z.object({
  id: Id,
  subject_kind: z.enum(CONSENT_SUBJECT_KINDS),
  subject_id: z.string(),
  purpose: z.enum(CONSENT_PURPOSES),
  status: z.enum(["granted", "withdrawn"]),
  source: z.enum(CONSENT_SOURCES),
  occurred_at: MaybeIso,
  created_at: MaybeIso,
});
export const ConsentListQuery = z.object({
  subject_kind: z.enum(["contact", "lead", "member"]).default("contact"),
  subject_id: z.string().min(1).max(100),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export const ConsentState = z.object({
  subject_kind: z.enum(["contact", "lead", "member"]),
  subject_id: z.string(),
  current: z.record(z.object({ status: z.enum(["granted", "withdrawn"]), at: MaybeIso, source: z.string() })).describe("Latest state per purpose"),
  history: z.array(ConsentRecord),
});
export const ConsentWrite = z
  .object({
    subject_kind: z.enum(["contact", "lead", "member"]).default("contact"),
    subject_id: z.string().min(1).max(100),
    purpose: z.enum(CONSENT_PURPOSES),
    text_version: z.string().max(80).nullable().optional(),
    text: z.string().max(2000).nullable().optional().describe("The consent wording shown to the subject"),
  })
  .strict();
export const DsrRequest = z.object({
  id: Id,
  subject_kind: z.enum(DSR_SUBJECT_KINDS),
  subject_id: z.string(),
  subject_email: z.string().nullable(),
  kind: z.enum(DSR_KINDS),
  status: z.enum(DSR_STATUSES),
  source: z.string(),
  requested_at: MaybeIso,
  due_at: MaybeIso,
  verified_at: MaybeIso.nullable(),
  completed_at: MaybeIso.nullable(),
  handled_by: z.string().nullable(),
  notes: z.string().nullable(),
  result: z.string().nullable(),
  created_at: MaybeIso,
});
export const DsrListQuery = ListQuery.extend({ status: z.enum([...DSR_STATUSES, "open"]).optional() });
export const DsrOpen = z
  .object({
    subject_kind: z.enum(DSR_SUBJECT_KINDS).default("contact"),
    subject_id: z.string().min(1).max(100),
    kind: z.enum(DSR_KINDS),
    email: z.string().email().max(320).nullable().optional(),
    notes: z.string().max(4000).nullable().optional(),
  })
  .strict();

/* ─── Marketing ────────────────────────────────────────────────────────── */
export const MarketingCampaignStats = z.object({
  total: z.number().int(), queued: z.number().int(), skipped_no_consent: z.number().int(), sent: z.number().int(), delivered: z.number().int(), opened: z.number().int(), clicked: z.number().int(),
  bounced: z.number().int(), failed: z.number().int(), unsubscribed: z.number().int(), open_rate: z.number(), click_rate: z.number(), bounce_rate: z.number(), unsubscribe_rate: z.number(),
});
export const MarketingCampaign = z.object({
  id: Id, name: z.string(), channel: z.enum(["email", "sms"]), status: z.enum(["draft", "scheduled", "sending", "sent", "paused", "cancelled"]),
  audience_id: Id.nullable(), template_id: Id.nullable(), subject: z.string().nullable(), schedule_at: z.string().nullable(),
  sent_count: z.number().int(), delivered_count: z.number().int(), opened_count: z.number().int(), clicked_count: z.number().int(), bounced_count: z.number().int(), unsubscribed_count: z.number().int(), skipped_count: z.number().int(),
  created_at: z.string(), started_at: z.string().nullable(), finished_at: z.string().nullable(),
});
export const MarketingCampaignWithStats = MarketingCampaign.extend({ stats: MarketingCampaignStats });
export const MarketingCampaignListQuery = ListQuery.extend({ status: z.enum(["draft", "scheduled", "sending", "sent", "paused", "cancelled"]).optional() });
export const MarketingLaunchBody = z.object({ force: z.boolean().optional().describe("Launch even when every contact lacks consent (everything is skipped)") }).strict();
export const MarketingLaunchResult = MarketingCampaign.extend({ queued: z.number().int(), skipped_no_consent: z.number().int(), skipped_no_address: z.number().int() });
export const MarketingAudience = z.object({ id: Id, name: z.string(), definition: z.record(z.unknown()), is_dynamic: z.boolean(), size_cache: z.number().int().nullable(), created_at: z.string(), updated_at: z.string() });
export const MarketingTemplate = z.object({ id: Id, name: z.string(), subject: z.string(), preheader: z.string().nullable(), body_md: z.string(), category: z.string(), created_at: z.string(), updated_at: z.string() });

/* ─── Voice campaigns ──────────────────────────────────────────────────── */
export const CampaignStats = z.object({
  total: z.number().int(),
  queued: z.number().int(),
  calling: z.number().int(),
  answered: z.number().int(),
  voicemail: z.number().int(),
  no_answer: z.number().int(),
  failed: z.number().int(),
  opted_out: z.number().int(),
  done: z.number().int(),
  interested: z.number().int(),
});
export const VoiceCampaign = z.object({
  id: Id,
  name: z.string(),
  script: z.string(),
  voice: z.string(),
  status: z.enum(CAMPAIGN_STATUSES),
  schedule_at: MaybeIso.nullable(),
  window_start: z.string(),
  window_end: z.string(),
  timezone: z.string(),
  max_attempts: z.number().int(),
  require_consent: z.boolean().nullable(),
  created_at: MaybeIso,
  updated_at: MaybeIso,
});
export const VoiceCampaignWithStats = VoiceCampaign.extend({ stats: CampaignStats });
const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM");
export const VoiceCampaignCreate = z
  .object({
    name: z.string().trim().min(1).max(120),
    script: z.string().trim().min(1).max(4000).describe("Supports {{first_name}}, {{full_name}}, {{company}}"),
    voice: z.enum(VOICES).optional(),
    schedule_at: z.string().datetime({ offset: true }).nullable().optional(),
    window_start: HHMM.optional(),
    window_end: HHMM.optional(),
    timezone: z.string().max(64).optional(),
    max_attempts: z.number().int().min(1).max(5).optional(),
    require_consent: z.boolean().optional(),
  })
  .strict();
export const VoiceTarget = z.object({
  id: Id,
  contact_id: z.string().nullable(),
  phone: z.string(),
  first_name: z.string().nullable(),
  status: z.string(),
  attempts: z.number().int(),
  last_attempt_at: MaybeIso.nullable(),
  outcome: z.string().nullable(),
  created_at: MaybeIso,
});
export const VoiceTargetsAdd = z
  .object({
    contact_ids: z.array(z.string().max(100)).max(1000).optional(),
    lifecycle: z.string().max(40).optional(),
    tag: z.string().max(60).optional(),
    q: z.string().max(200).optional(),
    phones: z.array(z.object({ phone: z.string().min(5).max(32), first_name: z.string().max(80).nullable().optional() })).max(1000).optional(),
  })
  .strict();
export const VoiceTargetsAddResult = z.object({
  added: z.number().int(),
  skipped_dnc: z.number().int(),
  skipped_no_consent: z.number().int(),
  skipped_duplicate: z.number().int(),
  skipped_invalid: z.number().int(),
});

/* ─── Mail ─────────────────────────────────────────────────────────────── */
export const MailAccount = z.object({
  id: Id,
  provider: z.string(),
  email: z.string(),
  display_name: z.string().nullable(),
  status: z.enum(["connected", "error", "disabled"]),
  last_sync_at: MaybeIso.nullable(),
  last_error: z.string().nullable(),
  message_count: z.number().int(),
  created_at: MaybeIso,
});

/* ─── Accounting ───────────────────────────────────────────────────────── */
export const AccountingConnection = z.object({
  id: Id,
  provider: z.string(),
  realm_id: z.string().nullable(),
  tenant_id: z.string().nullable(),
  company_name: z.string().nullable(),
  status: z.enum(["connected", "error", "disabled"]),
  last_sync_at: MaybeIso.nullable(),
  last_error: z.string().nullable(),
  settings: z.record(z.unknown()),
  created_at: MaybeIso,
});
export const AccountingPush = z
  .object({
    kind: z.enum(ACCOUNTING_ENTITY_KINDS),
    id: Id,
    connection_id: z.string().max(100).optional().describe("Default: every connected system"),
    force: z.boolean().optional().describe("Push drafts / unchanged entities too"),
  })
  .strict();
export const AccountingPushOutcome = z.object({
  connection_id: z.string(),
  provider: z.string(),
  kind: z.enum(ACCOUNTING_ENTITY_KINDS),
  id: z.string(),
  status: z.enum(["ok", "skipped", "error"]),
  remote_id: z.string().nullable(),
  message: z.string().nullable(),
});
export const AccountingLink = z.object({
  entity_id: z.string(),
  connection_id: z.string(),
  provider: z.string(),
  remote_id: z.string().nullable(),
  last_pushed_at: MaybeIso.nullable(),
  error: z.string().nullable(),
  state: z.enum(["synced", "pending", "error"]),
});
export const AccountingLinkQuery = ListQuery.extend({
  kind: z.enum(ACCOUNTING_ENTITY_KINDS).default("invoice"),
  connection_id: z.string().max(100).optional(),
});

/* ─── Optimize ─────────────────────────────────────────────────────────── */
export const CashflowQuery = z.object({ weeks: z.coerce.number().int().min(1).max(26).optional().describe("Horizon in weeks (default 8)") });
export const CapacityQuery = z.object({
  weeks: z.coerce.number().int().min(1).max(26).optional(),
  lookback_weeks: z.coerce.number().int().min(1).max(26).optional(),
  target: z.coerce.number().min(0.1).max(1).optional().describe("Utilisation threshold (default 0.85)"),
});
export const PricingBody = z
  .object({
    items: z
      .array(
        z.object({
          description: z.string().trim().min(1).max(200),
          qty: z.number().min(0).max(1_000_000).default(1),
          unit_minor: z.number().int().min(0).describe("Proposed unit price"),
        })
      )
      .min(1)
      .max(100),
  })
  .strict();
export const OptimizeResult = z.record(z.unknown()).describe("Model output; see the Optimize page for field semantics");

/* ─── Agents & approvals ───────────────────────────────────────────────── */
export const Agent = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  status: z.string(),
  autonomy_level: z.string().nullable(),
  tools: z.array(z.string()).nullable().describe("Allowlist; null = every tool"),
  model: z.string().nullable(),
  tasks_completed: z.number().int().nullable(),
  created_at: MaybeIso,
});
export const AgentRun = z.object({
  id: Id,
  agent_id: z.string(),
  agent_name: z.string().nullable(),
  status: z.enum(["queued", "running", "awaiting_approval", "done", "failed", "cancelled"]),
  trigger_kind: z.string().nullable(),
  prompt: z.string().nullable(),
  output: z.string().nullable(),
  error: z.string().nullable(),
  tokens_in: z.number().int().nullable(),
  tokens_out: z.number().int().nullable(),
  started_at: MaybeIso.nullable(),
  finished_at: MaybeIso.nullable(),
  created_at: MaybeIso,
});
export const AgentRunListQuery = ListQuery.extend({
  agent_id: z.string().max(100).optional(),
  status: z.enum(["queued", "running", "awaiting_approval", "done", "failed", "cancelled"]).optional(),
});
export const AgentRunCreate = z.object({ prompt: z.string().trim().min(1).max(8000).optional() }).strict();
export const AgentRunQueued = z.object({ run_id: Id, agent_id: z.string(), status: z.literal("queued") });
export const Approval = z.object({
  id: Id,
  run_id: z.string().nullable(),
  agent_id: z.string().nullable(),
  agent_name: z.string().nullable(),
  tool_name: z.string(),
  input: z.record(z.unknown()),
  preview: z.string().nullable(),
  status: z.enum(["pending", "approved", "rejected", "expired"]),
  decided_by: z.string().nullable(),
  decided_at: MaybeIso.nullable(),
  expires_at: MaybeIso.nullable(),
  created_at: MaybeIso,
});
export const ApprovalListQuery = ListQuery.extend({ status: z.enum(["pending", "approved", "rejected", "expired"]).optional() });
export const ApprovalDecide = z
  .object({
    decision: z.enum(["approved", "rejected"]),
    edited_input: z.record(z.unknown()).optional().describe("Replace the proposed payload before approving (validated against the tool schema)"),
  })
  .strict();
export const ApprovalDecided = Approval.extend({ outcome: z.string().nullable().describe("Result of executing a copilot/MCP approval inline") });

/* ═══════════════════════════════════════════════════════════════════════════
 * Phase 7 — Procurement (suppliers, purchase orders, supplier bills).
 * ═══════════════════════════════════════════════════════════════════════════ */

import { SupplierInputSchema, SupplierPatchSchema } from "@/lib/procurement/suppliers";
import { PurchaseOrderInputSchema, PoLineSchema } from "@/lib/procurement/purchase-orders";
import { ReceiveLinesSchema } from "@/lib/procurement/receiving";
import { BillPaymentInputSchema, SupplierBillInputSchema } from "@/lib/procurement/bills";
import { BILL_STATUSES, PO_STATUSES } from "@/lib/procurement/pure";

export const Supplier = z.object({
  id: Id,
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  tax_number: z.string().nullable(),
  address: z.string().nullable().describe("JSON address object or plain text"),
  payment_terms_days: z.number().int(),
  currency: z.string(),
  notes: z.string().nullable(),
  active: z.boolean(),
  created_at: MaybeIso,
  updated_at: MaybeIso,
});
export const SupplierCreate = SupplierInputSchema;
export const SupplierPatch = SupplierPatchSchema;
export const SupplierListQuery = SearchListQuery.extend({ inactive: z.enum(["true", "false"]).optional().describe("Include inactive suppliers") });

export const PoLine = PoLineSchema;
export const PurchaseOrder = z.object({
  id: Id,
  supplier_id: Id,
  supplier_name: z.string().nullable(),
  supplier_email: z.string().nullable(),
  number: z.string(),
  status: z.enum(PO_STATUSES),
  items: z.array(PoLine),
  subtotal_minor: Minor,
  tax_minor: Minor,
  total_minor: Minor,
  currency: z.string(),
  expected_at: MaybeIso.nullable(),
  notes: z.string().nullable(),
  sent_at: MaybeIso.nullable(),
  received_at: MaybeIso.nullable(),
  created_by: z.string().nullable(),
  created_at: MaybeIso,
  updated_at: MaybeIso,
});
export const PurchaseOrderCreate = PurchaseOrderInputSchema;
export const PurchaseOrderListQuery = ListQuery.extend({ status: z.enum(PO_STATUSES).optional(), supplier_id: Id.optional() });
export const PurchaseOrderReceive = ReceiveLinesSchema;
export const PurchaseOrderReceiveResult = z.object({
  purchase_order: PurchaseOrder,
  receipt: z.object({ id: Id, purchase_order_id: Id, received_at: MaybeIso, lines: z.array(z.object({ product_id: Id, qty: z.number().int() })), note: z.string().nullable() }),
  recosted: z.record(Minor).describe("product id → new weighted-average unit cost"),
});

export const SupplierBill = z.object({
  id: Id,
  supplier_id: Id,
  supplier_name: z.string().nullable(),
  purchase_order_id: Id.nullable(),
  po_number: z.string().nullable(),
  number: z.string(),
  supplier_ref: z.string().nullable(),
  status: z.enum(BILL_STATUSES),
  items: z.array(PoLine),
  subtotal_minor: Minor,
  tax_minor: Minor,
  total_minor: Minor,
  paid_minor: Minor,
  outstanding_minor: Minor,
  currency: z.string(),
  issued_at: MaybeIso.nullable(),
  due_at: MaybeIso.nullable(),
  paid_at: MaybeIso.nullable(),
  overdue: z.boolean(),
  notes: z.string().nullable(),
  created_at: MaybeIso,
  updated_at: MaybeIso,
});
export const SupplierBillCreate = SupplierBillInputSchema;
export const SupplierBillListQuery = ListQuery.extend({ status: z.enum(BILL_STATUSES).optional(), supplier_id: Id.optional(), overdue: z.enum(["true", "false"]).optional() });
export const SupplierBillPay = BillPaymentInputSchema;
export const SupplierBillPayment = z.object({
  id: Id,
  bill_id: Id,
  amount_minor: Minor,
  currency: z.string(),
  paid_at: MaybeIso,
  method: z.string().nullable(),
  ref: z.string().nullable(),
  note: z.string().nullable(),
  expense_id: Id.nullable(),
  created_at: MaybeIso,
});
export const SupplierBillPayResult = z.object({ bill: SupplierBill, payment: SupplierBillPayment });

/* ─── Workforce ────────────────────────────────────────────────────────── */
export const Staff = z.object({
  id: Id,
  membership_id: z.string().nullable(),
  display_name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  role_title: z.string().nullable(),
  employment_type: z.enum(EMPLOYMENT_TYPES),
  hourly_rate_minor: z.number().int(),
  currency: z.string(),
  weekly_hours: z.number().int(),
  skills: z.array(z.string()),
  location: z.string().nullable(),
  start_date: z.string().nullable(),
  end_date: z.string().nullable(),
  active: z.boolean(),
  created_at: MaybeIso,
  updated_at: MaybeIso,
});
export const StaffCreate = StaffInputSchema;
export const StaffListQuery = ListQuery.extend({ all: z.enum(["true", "false"]).optional().describe("Include inactive staff") });

export const Shift = z.object({
  id: Id,
  staff_id: z.string().nullable(),
  staff_name: z.string().nullable(),
  role_title: z.string().nullable(),
  starts_at: MaybeIso,
  ends_at: MaybeIso,
  break_minutes: z.number().int(),
  minutes: z.number().int().describe("Paid minutes (span minus break)"),
  location: z.string().nullable(),
  notes: z.string().nullable(),
  status: z.enum(SHIFT_STATUSES),
  published_at: MaybeIso.nullable(),
  created_at: MaybeIso,
  updated_at: MaybeIso,
});
export const ShiftCreate = ShiftInputSchema;
export const ShiftListQuery = ListQuery.extend({
  from: z.string().max(40).optional().describe("ISO start of window"),
  to: z.string().max(40).optional().describe("ISO end of window"),
  staff_id: z.string().max(100).optional(),
  status: z.enum(SHIFT_STATUSES).optional(),
});

export const Leave = z.object({
  id: Id,
  staff_id: z.string(),
  staff_name: z.string().nullable(),
  kind: z.enum(LEAVE_KINDS),
  starts_on: z.string(),
  ends_on: z.string(),
  hours: z.number().int(),
  status: z.enum(LEAVE_STATUSES),
  note: z.string().nullable(),
  decided_by: z.string().nullable(),
  decided_at: MaybeIso.nullable(),
  created_at: MaybeIso,
});
export const LeaveCreate = LeaveRequestSchema;
export const LeaveListQuery = ListQuery.extend({
  status: z.enum(LEAVE_STATUSES).optional(),
  staff_id: z.string().max(100).optional(),
  from: z.string().max(10).optional().describe("YYYY-MM-DD"),
  to: z.string().max(10).optional().describe("YYYY-MM-DD"),
});

/* ─── Reports & dashboards ─────────────────────────────────────────────── */

export const SavedReport = z.object({
  id: Id,
  name: z.string(),
  description: z.string().nullable(),
  spec: ReportSpecSchema,
  chart: ChartConfigSchema,
  visibility: z.enum(["private", "org"]),
  created_by: z.string().nullable(),
  created_at: MaybeIso,
  updated_at: MaybeIso,
});
export const ReportColumn = z.object({
  key: z.string(),
  label: z.string(),
  kind: z.enum(["dimension", "measure", "date"]),
  format: z.enum(["money", "number", "minutes", "percent"]).nullable(),
  field: z.string().nullable(),
  agg: z.string().nullable(),
  bucket: z.string().nullable(),
});
const ReportCell = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export const ReportResult = z.object({
  dataset: z.string(),
  columns: z.array(ReportColumn),
  rows: z.array(z.record(ReportCell)),
  totals: z.record(ReportCell).nullable(),
  row_count: z.number().int(),
  truncated: z.boolean(),
  mode: z.enum(["aggregate", "raw"]),
  currency: z.string(),
  timezone: z.string(),
  generated_at: MaybeIso,
});
export const SavedReportRun = z.object({ report: SavedReport, result: ReportResult });
export const Dashboard = z.object({
  id: Id,
  name: z.string(),
  role: z.string().nullable(),
  layout: z.array(LayoutItemSchema),
  is_default: z.boolean(),
  created_by: z.string().nullable(),
  created_at: MaybeIso,
  updated_at: MaybeIso,
});

/* ─── Documents (Phase 7 / Lane E) ─────────────────────────────────────── */
export const DocumentSigner = z.object({
  id: Id,
  name: z.string(),
  email: z.string(),
  role: z.string().nullable(),
  order_index: z.number().int(),
  status: z.enum(["pending", "viewed", "signed", "declined"]),
  signed_at: IsoOrNull,
  signature_text: z.string().nullable(),
  decline_reason: z.string().nullable(),
});
export const Document = z.object({
  id: Id,
  template_id: Id.nullable(),
  title: z.string(),
  kind: z.enum(["contract", "proposal", "nda", "letter", "form", "other"]),
  body_md: z.string().describe("Rendered markdown (merge fields applied)"),
  merge_data: z.record(z.string()),
  status: z.enum(["draft", "sent", "viewed", "signed", "declined", "expired", "void"]),
  signing_order: z.enum(["parallel", "sequential"]),
  contact_id: Id.nullable(),
  contact_name: z.string().nullable(),
  record_id: Id.nullable(),
  quote_id: Id.nullable(),
  pdf_hash: z.string().nullable().describe("SHA-256 of the unsigned PDF, fixed at send time"),
  signed_pdf_hash: z.string().nullable(),
  sent_at: IsoOrNull,
  viewed_at: IsoOrNull,
  completed_at: IsoOrNull,
  expires_at: IsoOrNull,
  created_by: z.string().nullable(),
  created_at: Iso,
  updated_at: Iso,
  signers: z.array(DocumentSigner),
});
export const DocumentListQuery = ListQuery.extend({
  status: z.enum(["draft", "sent", "viewed", "signed", "declined", "expired", "void"]).optional(),
  contact_id: Id.optional(),
  q: z.string().max(200).optional(),
});
const DocumentSignerInput = z.object({ name: z.string().trim().min(1).max(200), email: z.string().trim().email().max(320), role: z.string().trim().max(60).nullable().optional() }).strict();
export const DocumentCreate = z
  .object({
    template_id: Id.nullable().optional().describe("Render this template; omit to supply body_md"),
    title: z.string().trim().min(1).max(200).nullable().optional(),
    kind: z.enum(["contract", "proposal", "nda", "letter", "form", "other"]).nullable().optional(),
    body_md: z.string().max(200_000).nullable().optional(),
    merge_data: z.record(z.string().max(60), z.string().max(20_000)).nullable().optional(),
    contact_id: Id.nullable().optional(),
    record_id: Id.nullable().optional(),
    quote_id: Id.nullable().optional(),
    signing_order: z.enum(["parallel", "sequential"]).nullable().optional(),
    expires_in_days: z.number().int().min(1).max(365).nullable().optional(),
    signers: z.array(DocumentSignerInput).max(10).nullable().optional(),
  })
  .strict();
export const DocumentSendBody = z.object({ message: z.string().max(2000).nullable().optional(), expires_in_days: z.number().int().min(1).max(365).nullable().optional() }).strict();
export const DocumentSendResult = Document.extend({ notified: z.array(z.object({ signer_id: Id, email: z.string(), url: z.string().url() })) });
export const DocumentTemplate = z.object({
  id: Id,
  name: z.string(),
  kind: z.enum(["contract", "proposal", "nda", "letter", "form", "other"]),
  body_md: z.string(),
  fields: z.array(z.object({ key: z.string(), label: z.string(), source: z.enum(["contact", "org", "custom"]), required: z.boolean().optional() })),
  requires_signature: z.boolean(),
  signer_roles: z.array(z.string()),
  version: z.number().int(),
  starter_slug: z.string().nullable(),
  created_at: Iso,
  updated_at: Iso,
});

/* ─── Automations (v2) ─────────────────────────────────────────────────── */

export const Automation = z.object({
  id: Id,
  name: z.string(),
  description: z.string().nullable().optional(),
  trigger_type: z.enum(["event", "schedule", "webhook", "manual"]),
  trigger_config: z.record(z.unknown()),
  conditions: z.unknown().nullable(),
  steps: z.array(z.record(z.unknown())),
  autonomy: z.enum(["auto", "approve"]),
  enabled: z.boolean(),
  version: z.number().int(),
  legacy: z.boolean().describe("Stored in the pre-v2 shape and converted on read"),
  template_key: z.string().nullable(),
  run_count: z.number().int(),
  error_count: z.number().int(),
  last_run_at: MaybeIso.nullable(),
  last_error: z.string().nullable(),
  created_at: MaybeIso,
  updated_at: MaybeIso.nullable(),
});
export const AutomationListQuery = ListQuery.extend({
  trigger_type: z.enum(["event", "schedule", "webhook", "manual"]).optional(),
  enabled: z.enum(["true", "false"]).optional(),
});
export const AutomationRun = z.object({
  id: Id,
  automation_id: Id,
  trigger_event_id: z.string().nullable(),
  status: z.enum(["queued", "running", "waiting", "done", "failed", "skipped"]),
  step_results: z.array(z.record(z.unknown())),
  step_index: z.number().int(),
  approval_id: z.string().nullable(),
  error: z.string().nullable(),
  attempt: z.number().int(),
  started_at: MaybeIso.nullable(),
  finished_at: MaybeIso.nullable(),
  resume_at: MaybeIso.nullable(),
  created_at: MaybeIso,
});
export const AutomationRunListQuery = ListQuery.extend({ status: z.enum(["queued", "running", "waiting", "done", "failed", "skipped"]).optional() });

/* ─── Projects ──────────────────────────────────────────────────────────── */


const Ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Calendar date YYYY-MM-DD");
export const Project = z.object({
  id: Id,
  name: z.string(),
  code: z.string().nullable(),
  description_md: z.string().nullable(),
  contact_id: z.string().nullable(),
  contact_name: z.string().nullable(),
  quote_id: z.string().nullable(),
  status: z.enum(PROJECT_STATUSES),
  starts_on: Ymd.nullable(),
  due_on: Ymd.nullable(),
  budget_minor: z.number().int(),
  currency: z.string(),
  billing_mode: z.enum(["fixed", "hourly", "none"]),
  hourly_rate_minor: z.number().int(),
  owner_member_id: z.string().nullable(),
  color: z.string().nullable(),
  archived_at: MaybeIso.nullable(),
  created_at: MaybeIso,
  updated_at: MaybeIso,
});
export const ProjectCreate = ProjectInputSchema;
export const ProjectPatch = ProjectPatchSchema;
export const ProjectListQuery = ListQuery.extend({ status: z.enum(PROJECT_STATUSES).optional(), archived: z.enum(["true", "false"]).optional() });
export const ProjectMilestone = z.object({
  id: Id,
  project_id: Id,
  name: z.string(),
  due_on: Ymd.nullable(),
  status: z.enum(["open", "done"]),
  sort: z.number().int(),
  completed_at: MaybeIso.nullable(),
  created_at: MaybeIso,
});
export const ProjectMilestoneCreate = MilestoneInputSchema;
export const ProjectTask = z.object({
  id: Id,
  title: z.string(),
  done: z.boolean(),
  project_id: z.string().nullable(),
  milestone_id: z.string().nullable(),
  assignee_id: z.string().nullable(),
  due_at: MaybeIso.nullable(),
  priority: z.enum(["low", "medium", "high", "urgent"]).nullable(),
  estimate_minutes: z.number().int().nullable(),
  sort: z.number().int().nullable(),
  depends_on: z.array(z.string()),
  created_at: MaybeIso,
});
export const ProjectTaskCreate = ProjectTaskInputSchema;
export const ProjectTaskListQuery = z.object({ done: z.enum(["true", "false"]).optional(), milestone: z.string().max(100).optional(), assignee: z.string().max(100).optional() });

/* ─── Phase 8 lane B: storefront + orders ──────────────────────────────── */
import { ORDER_STATUSES, ShippingAddressSchema } from "@/lib/storefront/pure";
import { StorefrontProductPatchSchema } from "@/lib/storefront/catalog";

export const Order = z.object({
  id: Id,
  number: z.string(),
  status: z.enum(ORDER_STATUSES),
  status_label: z.string(),
  customer_name: z.string(),
  customer_email: z.string(),
  customer_phone: z.string().nullable(),
  shipping_address: ShippingAddressSchema.nullable(),
  items: z.array(LineItemSchema),
  subtotal_minor: Money,
  tax_minor: Money,
  shipping_minor: Money,
  total_minor: Money,
  currency: Currency,
  contact_id: z.string().nullable(),
  invoice_id: z.string().nullable(),
  payment_ref: z.string().nullable(),
  consent_marketing: z.boolean(),
  notes: z.string().nullable(),
  paid_at: MaybeIso.nullable(),
  fulfilled_at: MaybeIso.nullable(),
  cancelled_at: MaybeIso.nullable(),
  created_at: MaybeIso,
  updated_at: MaybeIso,
});
export const OrderListQuery = SearchListQuery.extend({ status: z.enum(ORDER_STATUSES).optional() });
export const OrderCancel = z.object({ reason: z.string().trim().max(500).nullable().optional(), restock: z.boolean().optional() }).strict();
export const OrderCancelResult = z.object({ order: Order, released: z.number().int(), refunded_minor: Money });
export const StorefrontProduct = z.object({
  id: Id,
  sku: z.string().nullable(),
  name: z.string(),
  unit_price_minor: Money,
  currency: Currency,
  track_stock: z.boolean(),
  stock_available: z.number().int(),
  active: z.boolean(),
  visible: z.boolean(),
  sort: z.number().int(),
  description_md: z.string().nullable(),
  image_url: z.string().nullable(),
});
export const StorefrontProductPut = StorefrontProductPatchSchema;

/* ─── Snapshots ────────────────────────────────────────────────────────── */
export const SnapshotMetaView = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  sections: z.array(z.string()),
  sha256: z.string(),
  size_bytes: z.number().int(),
  visibility: z.enum(["private", "agency"]),
  origin: z.enum(["own", "agency"]).optional(),
  created_at: z.string(),
});
export const SnapshotParams = z.object({ id: z.string().min(1).max(80) });

/* ─── Portal messages (Phase 9) ────────────────────────────────────────── */

export const PortalMessage = z.object({
  id: Id,
  contact_id: Id,
  direction: z.enum(["in", "out"]).describe("`in` = from the customer's portal, `out` = staff reply"),
  body: z.string(),
  author_member_id: z.string().nullable(),
  read_at: IsoOrNull,
  created_at: Iso,
});
export const PortalMessageListQuery = ListQuery.extend({ contact_id: Id.optional() });
export const PortalMessageCreate = z
  .object({ contact_id: Id, body: z.string().trim().min(1).max(2000).describe("Plain text, up to 2000 characters") })
  .strict();

/* ─── Phase 11 lane C: shipping and returns ───────────────────────────── */
import { AddressSchema as ShipAddress, SHIPMENT_STATUSES, RETURN_STATUSES, RETURN_RESOLUTIONS } from "@/lib/shipping/types";
import { CreateShipmentSchema } from "@/lib/shipping/shipments";
import { ReturnRequestSchema } from "@/lib/shipping/returns";

export const Shipment = z.object({
  id: Id,
  order_id: z.string().nullable(),
  return_id: z.string().nullable(),
  status: z.enum(SHIPMENT_STATUSES),
  status_label: z.string(),
  carrier: z.string().nullable(),
  service: z.string().nullable(),
  rate_minor: Money,
  currency: Currency,
  tracking_number: z.string().nullable(),
  tracking_url: z.string().nullable(),
  label_url: z.string().nullable(),
  label_attachment_id: z.string().nullable(),
  weight_grams: z.number().int().nullable(),
  to_address: ShipAddress.nullable(),
  from_address: ShipAddress.nullable(),
  items: z.array(z.object({ product_id: z.string().nullable(), description: z.string(), qty: z.number().int() })),
  insured_minor: Money,
  provider: z.string().nullable(),
  purchased_at: IsoOrNull,
  delivered_at: IsoOrNull,
  created_at: MaybeIso,
  updated_at: MaybeIso,
});
export const ShipmentListQuery = ListQuery.extend({ status: z.enum(SHIPMENT_STATUSES).optional(), order_id: Id.optional() });
export const ShipmentCreate = CreateShipmentSchema.extend({ order_id: Id });
export const ShipmentCreateResult = z.object({ shipments: z.array(Shipment) });

export const ReturnRequestObj = z.object({
  id: Id,
  order_id: z.string(),
  order_number: z.string().nullable(),
  contact_id: z.string().nullable(),
  status: z.enum(RETURN_STATUSES),
  reason: z.string().nullable(),
  items: z.array(z.object({ product_id: z.string().nullable().optional(), description: z.string(), qty: z.number().int() })),
  resolution: z.enum(RETURN_RESOLUTIONS),
  notes: z.string().nullable(),
  refund_minor: Money,
  created_at: MaybeIso,
  updated_at: MaybeIso,
});
export const ReturnListQuery = ListQuery.extend({ status: z.enum(RETURN_STATUSES).optional(), order_id: Id.optional() });
export const ReturnCreate = ReturnRequestSchema.extend({ order_id: Id });

/* ─── Phase 11 lane B: memberships ─────────────────────────────────────── */
import { PLAN_INTERVALS, SUB_STATUSES } from "@/lib/memberships/pure";

export const MembershipPlan = z.object({
  id: Id,
  slug: z.string(),
  name: z.string(),
  description_md: z.string().nullable(),
  amount_minor: Money,
  currency: Currency,
  interval: z.enum(PLAN_INTERVALS),
  interval_count: z.number().int(),
  trial_days: z.number().int(),
  setup_fee_minor: Money,
  tax_rate_id: z.string().nullable(),
  product_id: z.string().nullable(),
  max_members: z.number().int().nullable(),
  allow_pause: z.boolean(),
  allow_quantity: z.boolean(),
  benefits: z.array(z.object({ label: z.string() })),
  visibility: z.enum(["public", "private"]),
  active: z.boolean(),
  sort: z.number().int(),
  created_at: MaybeIso,
  updated_at: MaybeIso,
});
export const MembershipPlanListQuery = ListQuery.extend({ include_archived: z.enum(["true", "false"]).optional() });
export const Subscription = z.object({
  id: Id,
  plan_id: Id,
  plan_name: z.string(),
  plan_slug: z.string(),
  contact_id: Id,
  contact_name: z.string().nullable(),
  contact_email: z.string().nullable(),
  status: z.enum(SUB_STATUSES),
  quantity: z.number().int(),
  amount_minor: Money,
  currency: Currency,
  interval: z.enum(PLAN_INTERVALS),
  interval_count: z.number().int(),
  start_at: MaybeIso,
  trial_ends_at: MaybeIso.nullable(),
  current_period_start: MaybeIso.nullable(),
  current_period_end: MaybeIso.nullable(),
  next_charge_at: MaybeIso.nullable(),
  cancel_at_period_end: z.boolean(),
  cancelled_at: MaybeIso.nullable(),
  pause_until: MaybeIso.nullable(),
  has_payment_method: z.boolean(),
  failed_attempts: z.number().int(),
  last_failure_at: MaybeIso.nullable(),
  last_invoice_id: z.string().nullable(),
  created_at: MaybeIso,
  updated_at: MaybeIso,
});
export const SubscriptionListQuery = SearchListQuery.extend({ status: z.enum(SUB_STATUSES).optional(), plan_id: Id.optional(), contact_id: Id.optional() });
export const SubscriptionCancel = z.object({ at_period_end: z.boolean().optional(), reason: z.string().trim().max(300).nullable().optional() }).strict();

/* ═══ Phase 11 lane E: customer engagement ════════════════════════════════ */
export const EngagementSurvey = z.object({
  id: Id, name: z.string(), kind: z.enum(["nps", "csat", "custom"]), trigger_event: z.string().nullable(), delay_hours: z.number().int(),
  channel: z.enum(["email", "sms", "link"]), active: z.boolean(), public_review_prompt: z.boolean(), created_at: MaybeIso,
});
export const EngagementSurveyResults = z.object({
  survey: EngagementSurvey, responses: z.number().int(), sent: z.number().int(), response_rate: z.number().nullable(), average: z.number().nullable(),
  nps: z.object({ total: z.number().int(), promoters: z.number().int(), passives: z.number().int(), detractors: z.number().int(), nps: z.number().nullable() }).nullable(),
  csat: z.object({ total: z.number().int(), satisfied: z.number().int(), csat: z.number().nullable(), average: z.number().nullable() }).nullable(),
  trend: z.array(z.object({ week: z.string(), responses: z.number().int(), value: z.number().nullable() })),
}).passthrough();
export const EngagementVoucher = z.object({
  id: Id, code_upper: z.string(), name: z.string(), kind: z.enum(["percent", "fixed", "free_shipping"]), value: z.number().int().describe("percent: basis points; fixed: minor units"),
  currency: z.string().nullable(), min_subtotal_minor: z.number().int(), max_uses: z.number().int().nullable(), per_contact_limit: z.number().int().nullable(), used_count: z.number().int(),
  starts_at: z.string().nullable(), ends_at: z.string().nullable(), applies_to: z.enum(["all", "products", "categories"]), stackable: z.boolean(), active: z.boolean(), created_at: MaybeIso,
});
export const EngagementVoucherCreate = VoucherInputSchema;
export const EngagementGiftCard = z.object({
  id: Id, code_last4: z.string(), initial_minor: z.number().int(), balance_minor: z.number().int(), currency: z.string(), status: z.enum(["active", "redeemed", "void", "expired"]),
  recipient_email: z.string().nullable(), expires_at: z.string().nullable(), issued_via: z.enum(["manual", "storefront"]), created_at: MaybeIso,
});
export const EngagementGiftCardIssue = z.object({
  amount_minor: z.number().int().min(1).max(100_000_000), currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
  recipient_email: z.string().trim().email().max(200).nullable().optional(), message: z.string().trim().max(500).nullable().optional(), expires_at: z.string().datetime({ offset: true }).nullable().optional(),
}).strict();
export const EngagementGiftCardIssued = z.object({ gift_card: EngagementGiftCard, code: z.string().describe("The full code. Returned once and never retrievable again.") });
export const EngagementLoyaltyAccount = z.object({ id: Id, contact_id: Id, balance: z.number().int(), lifetime_points: z.number().int(), tier: z.string().nullable(), full_name: z.string().nullable(), email: z.string().nullable(), updated_at: MaybeIso });
export const EngagementListQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).optional() });
