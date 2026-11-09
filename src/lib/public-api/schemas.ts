import { z } from "zod";
import { AREAS } from "@/lib/auth/roles";
import { EVENT_TYPES } from "@/lib/events/bus";
import { LineItemSchema } from "@/lib/money/items";
import { ProductInputSchema, ProductPatchSchema, PRODUCT_KINDS } from "@/lib/inventory/products";
import { TICKET_PRIORITIES, TICKET_SOURCES, TICKET_STATUSES } from "@/lib/helpdesk/sla";

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

export const Task = z.object({ id: Id, title: z.string(), done: z.boolean(), chat_id: z.string().nullable(), created_at: Iso });
export const TaskCreate = z.object({ title: z.string().trim().min(1).max(200) }).strict();
export const TaskPatch = z.object({ title: z.string().trim().min(1).max(200).optional(), done: z.boolean().optional() }).strict();
export const TaskListQuery = ListQuery.extend({ done: z.enum(["true", "false"]).optional() });

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
  items: z.array(LineItem),
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
