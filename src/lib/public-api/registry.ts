import type { ZodTypeAny } from "zod";
import type { ApiScope } from "./scopes";
import * as S from "./schemas";

/**
 * Typed route registry for /api/v1.
 *
 * Every route handler is built with `op(ROUTES.<id>, impl)` (see ./handler),
 * so the schema used to validate a request is the same object the OpenAPI
 * document is generated from. Add a route here first; docs follow.
 */

export type Method = "GET" | "POST" | "PATCH" | "DELETE";

export interface RouteDef<Q extends ZodTypeAny = ZodTypeAny, P extends ZodTypeAny = ZodTypeAny, B extends ZodTypeAny = ZodTypeAny> {
  id: string;
  method: Method;
  /** OpenAPI-style path relative to /api/v1, e.g. "/contacts/{id}". */
  path: string;
  summary: string;
  description?: string;
  tag: string;
  /** Required scope; `null` = no authentication. */
  scope: ApiScope | null;
  query?: Q;
  params?: P;
  body?: B;
  /** Shape of `data` in the success envelope. */
  response: ZodTypeAny;
  /** Paginated list: `data` is an array and `meta.next_cursor` is set. */
  list?: boolean;
  status?: 200 | 201;
  /** Emitted event types (documented on the operation). */
  emits?: readonly string[];
}

function def<Q extends ZodTypeAny, P extends ZodTypeAny, B extends ZodTypeAny>(d: RouteDef<Q, P, B>): RouteDef<Q, P, B> {
  return d;
}

export const ROUTES = {
  /* meta */
  openapi: def({ id: "getOpenApi", method: "GET", path: "/openapi.json", summary: "OpenAPI 3.1 document", tag: "Meta", scope: null, response: S.OpenApiDoc }),
  me: def({ id: "getMe", method: "GET", path: "/me", summary: "Current key, user and workspace", tag: "Meta", scope: "read:settings", response: S.Me }),

  /* contacts */
  listContacts: def({ id: "listContacts", method: "GET", path: "/contacts", summary: "List contacts", tag: "Contacts", scope: "read:crm", query: S.ContactListQuery, response: S.Contact, list: true }),
  createContact: def({ id: "createContact", method: "POST", path: "/contacts", summary: "Create a contact", tag: "Contacts", scope: "write:crm", body: S.ContactCreate, response: S.Contact, status: 201, emits: ["crm.contact.created"] }),
  getContact: def({ id: "getContact", method: "GET", path: "/contacts/{id}", summary: "Get a contact", tag: "Contacts", scope: "read:crm", params: S.IdParams, response: S.Contact }),
  updateContact: def({ id: "updateContact", method: "PATCH", path: "/contacts/{id}", summary: "Update a contact", tag: "Contacts", scope: "write:crm", params: S.IdParams, body: S.ContactPatch, response: S.Contact, emits: ["crm.contact.stage_changed"] }),
  deleteContact: def({ id: "deleteContact", method: "DELETE", path: "/contacts/{id}", summary: "Delete a contact", tag: "Contacts", scope: "write:crm", params: S.IdParams, response: S.Deleted }),

  /* tasks */
  listTasks: def({ id: "listTasks", method: "GET", path: "/tasks", summary: "List tasks", tag: "Tasks", scope: "read:tasks", query: S.TaskListQuery, response: S.Task, list: true }),
  createTask: def({ id: "createTask", method: "POST", path: "/tasks", summary: "Create a task", tag: "Tasks", scope: "write:tasks", body: S.TaskCreate, response: S.Task, status: 201, emits: ["task.created"] }),
  getTask: def({ id: "getTask", method: "GET", path: "/tasks/{id}", summary: "Get a task", tag: "Tasks", scope: "read:tasks", params: S.IdParams, response: S.Task }),
  updateTask: def({ id: "updateTask", method: "PATCH", path: "/tasks/{id}", summary: "Update a task", tag: "Tasks", scope: "write:tasks", params: S.IdParams, body: S.TaskPatch, response: S.Task }),
  deleteTask: def({ id: "deleteTask", method: "DELETE", path: "/tasks/{id}", summary: "Delete a task", tag: "Tasks", scope: "write:tasks", params: S.IdParams, response: S.Deleted }),

  /* quotes */
  listQuotes: def({ id: "listQuotes", method: "GET", path: "/quotes", summary: "List quotes", tag: "Quotes", scope: "read:billing", query: S.QuoteListQuery, response: S.Quote, list: true }),
  createQuote: def({ id: "createQuote", method: "POST", path: "/quotes", summary: "Create a draft quote", tag: "Quotes", scope: "write:billing", body: S.QuoteCreate, response: S.Quote, status: 201 }),
  getQuote: def({ id: "getQuote", method: "GET", path: "/quotes/{id}", summary: "Get a quote", tag: "Quotes", scope: "read:billing", params: S.IdParams, response: S.Quote }),
  sendQuote: def({ id: "sendQuote", method: "POST", path: "/quotes/{id}/send", summary: "Send a quote by email", description: "Issues a share link, marks the quote sent and queues the email.", tag: "Quotes", scope: "write:billing", params: S.IdParams, body: S.SendBody, response: S.Quote.extend({ share: S.SendResult }) }),

  /* invoices */
  listInvoices: def({ id: "listInvoices", method: "GET", path: "/invoices", summary: "List invoices", tag: "Invoices", scope: "read:billing", query: S.InvoiceListQuery, response: S.Invoice, list: true }),
  createInvoice: def({ id: "createInvoice", method: "POST", path: "/invoices", summary: "Create a draft invoice", tag: "Invoices", scope: "write:billing", body: S.InvoiceCreate, response: S.Invoice, status: 201 }),
  getInvoice: def({ id: "getInvoice", method: "GET", path: "/invoices/{id}", summary: "Get an invoice", tag: "Invoices", scope: "read:billing", params: S.IdParams, response: S.Invoice }),
  sendInvoice: def({ id: "sendInvoice", method: "POST", path: "/invoices/{id}/send", summary: "Send an invoice by email", tag: "Invoices", scope: "write:billing", params: S.IdParams, body: S.SendBody, response: S.Invoice.extend({ share: S.SendResult }) }),
  recordPayment: def({ id: "recordInvoicePayment", method: "POST", path: "/invoices/{id}/payments", summary: "Record a payment", description: "Records an external/manual payment and recomputes the invoice status. Emits `invoice.paid` when settled.", tag: "Invoices", scope: "write:billing", params: S.IdParams, body: S.PaymentCreate, response: S.PaymentResult, status: 201, emits: ["invoice.paid"] }),

  /* calendar */
  listBookings: def({ id: "listBookings", method: "GET", path: "/bookings", summary: "List bookings", tag: "Calendar", scope: "read:calendar", query: S.BookingListQuery, response: S.Booking, list: true }),
  getBooking: def({ id: "getBooking", method: "GET", path: "/bookings/{id}", summary: "Get a booking", tag: "Calendar", scope: "read:calendar", params: S.IdParams, response: S.Booking }),
  cancelBooking: def({ id: "cancelBooking", method: "POST", path: "/bookings/{id}/cancel", summary: "Cancel a booking", tag: "Calendar", scope: "write:calendar", params: S.IdParams, body: S.BookingCancel, response: S.Booking, emits: ["booking.cancelled"] }),
  listBookingTypes: def({ id: "listBookingTypes", method: "GET", path: "/booking-types", summary: "List booking types", tag: "Calendar", scope: "read:calendar", response: S.BookingType, list: true }),
  availability: def({ id: "getAvailability", method: "GET", path: "/availability", summary: "Available slots for a booking type", tag: "Calendar", scope: "read:calendar", query: S.AvailabilityQuery, response: S.Availability }),

  /* helpdesk */
  listTickets: def({ id: "listTickets", method: "GET", path: "/tickets", summary: "List tickets", tag: "Tickets", scope: "read:helpdesk", query: S.TicketListQuery, response: S.Ticket, list: true }),
  createTicket: def({ id: "createTicket", method: "POST", path: "/tickets", summary: "Create a ticket", tag: "Tickets", scope: "write:helpdesk", body: S.TicketCreate, response: S.Ticket, status: 201, emits: ["ticket.created"] }),
  getTicket: def({ id: "getTicket", method: "GET", path: "/tickets/{id}", summary: "Get a ticket with messages", tag: "Tickets", scope: "read:helpdesk", params: S.IdParams, response: S.TicketDetail }),
  replyTicket: def({ id: "replyTicket", method: "POST", path: "/tickets/{id}/replies", summary: "Reply to a ticket", tag: "Tickets", scope: "write:helpdesk", params: S.IdParams, body: S.TicketReply, response: S.TicketReplyResult, status: 201 }),

  /* records */
  listRecordTypes: def({ id: "listRecordTypes", method: "GET", path: "/record-types", summary: "List record types", tag: "Records", scope: "read:crm", response: S.RecordType, list: true }),
  listRecords: def({ id: "listRecords", method: "GET", path: "/records/{type}", summary: "List records of a type", tag: "Records", scope: "read:crm", params: S.RecordTypeParams, query: S.RecordListQuery, response: S.RecordItem, list: true }),
  createRecord: def({ id: "createRecord", method: "POST", path: "/records/{type}", summary: "Create a record", tag: "Records", scope: "write:crm", params: S.RecordTypeParams, body: S.RecordCreate, response: S.RecordItem, status: 201, emits: ["record.created"] }),
  getRecord: def({ id: "getRecord", method: "GET", path: "/records/{type}/{id}", summary: "Get a record", tag: "Records", scope: "read:crm", params: S.RecordParams, response: S.RecordItem }),
  updateRecord: def({ id: "updateRecord", method: "PATCH", path: "/records/{type}/{id}", summary: "Update a record", tag: "Records", scope: "write:crm", params: S.RecordParams, body: S.RecordPatch, response: S.RecordItem }),
  moveRecord: def({ id: "moveRecord", method: "POST", path: "/records/{type}/{id}/move", summary: "Move a record to a stage", tag: "Records", scope: "write:crm", params: S.RecordParams, body: S.RecordMove, response: S.RecordItem, emits: ["record.moved"] }),

  /* inventory */
  listProducts: def({ id: "listProducts", method: "GET", path: "/products", summary: "List products", tag: "Products", scope: "read:billing", query: S.ProductListQuery, response: S.Product, list: true }),
  createProduct: def({ id: "createProduct", method: "POST", path: "/products", summary: "Create a product", tag: "Products", scope: "write:billing", body: S.ProductCreate, response: S.Product, status: 201 }),
  getProduct: def({ id: "getProduct", method: "GET", path: "/products/{id}", summary: "Get a product", tag: "Products", scope: "read:billing", params: S.IdParams, response: S.Product }),
  updateProduct: def({ id: "updateProduct", method: "PATCH", path: "/products/{id}", summary: "Update a product", description: "`stock_on_hand` is not patchable; use the stock endpoint so the ledger stays truthful.", tag: "Products", scope: "write:billing", params: S.IdParams, body: S.ProductPatch, response: S.Product }),
  adjustStock: def({ id: "adjustProductStock", method: "POST", path: "/products/{id}/stock", summary: "Receive, consume or adjust stock", tag: "Products", scope: "write:billing", params: S.IdParams, body: S.StockAdjust, response: S.Product }),

  /* events */
  listEvents: def({ id: "listEvents", method: "GET", path: "/events", summary: "Recent events (polling)", description: "Append-only event log, newest first. Use `since` or the cursor to poll.", tag: "Events", scope: "read:settings", query: S.EventListQuery, response: S.Event, list: true }),

  /* webhooks (REST hooks) */
  listWebhooks: def({ id: "listWebhooks", method: "GET", path: "/webhooks", summary: "List webhook subscriptions", tag: "Webhooks", scope: "read:settings", response: S.WebhookSubscription, list: true }),
  createWebhook: def({ id: "createWebhook", method: "POST", path: "/webhooks", summary: "Subscribe (REST hook)", description: "Returns the signing secret once. Zapier/Make: call this on subscribe and DELETE on unsubscribe.", tag: "Webhooks", scope: "write:settings", body: S.WebhookCreate, response: S.WebhookCreated, status: 201 }),
  getWebhook: def({ id: "getWebhook", method: "GET", path: "/webhooks/{id}", summary: "Get a subscription", tag: "Webhooks", scope: "read:settings", params: S.IdParams, response: S.WebhookSubscription }),
  updateWebhook: def({ id: "updateWebhook", method: "PATCH", path: "/webhooks/{id}", summary: "Update a subscription", tag: "Webhooks", scope: "write:settings", params: S.IdParams, body: S.WebhookPatch, response: S.WebhookSubscription }),
  deleteWebhook: def({ id: "deleteWebhook", method: "DELETE", path: "/webhooks/{id}", summary: "Unsubscribe", tag: "Webhooks", scope: "write:settings", params: S.IdParams, response: S.Deleted }),
  sampleWebhook: def({ id: "getWebhookSample", method: "GET", path: "/webhooks/sample/{event}", summary: "Sample payload for an event type", description: "Use for Zapier 'perform list' so users can map fields before any real event fires.", tag: "Webhooks", scope: "read:settings", params: S.WebhookEventParams, response: S.WebhookSample }),
} as const;

export type RouteId = keyof typeof ROUTES;

export const ROUTE_LIST: readonly RouteDef[] = Object.values(ROUTES);

export const TAGS: ReadonlyArray<{ name: string; description: string }> = [
  { name: "Meta", description: "Discovery and key information." },
  { name: "Contacts", description: "CRM contacts." },
  { name: "Tasks", description: "Simple to-dos." },
  { name: "Quotes", description: "Quotes with versioned line items." },
  { name: "Invoices", description: "Invoices and payments." },
  { name: "Calendar", description: "Bookings, booking types and availability." },
  { name: "Tickets", description: "Helpdesk tickets and replies." },
  { name: "Records", description: "Configurable record types (pipelines, cases, jobs…)." },
  { name: "Products", description: "Pricebook and inventory." },
  { name: "Events", description: "Event log for polling integrations." },
  { name: "Webhooks", description: "Outbound webhook subscriptions (REST hooks)." },
];
