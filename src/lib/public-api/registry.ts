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
  /** Agent/MCP tool names that perform the same operation (`x-kernelhub-tools`). */
  tools?: readonly string[];
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

  /* billing depth */
  listTaxRates: def({ id: "listTaxRates", method: "GET", path: "/tax-rates", summary: "List tax rates", tag: "Invoices", scope: "read:billing", query: S.TaxRateListQuery, response: S.TaxRate, list: true }),
  getTaxRate: def({ id: "getTaxRate", method: "GET", path: "/tax-rates/{id}", summary: "Get a tax rate", tag: "Invoices", scope: "read:billing", params: S.IdParams, response: S.TaxRate }),
  listInvoiceSchedules: def({ id: "listInvoiceSchedules", method: "GET", path: "/invoice-schedules", summary: "List recurring invoice schedules", tag: "Invoices", scope: "read:billing", query: S.InvoiceScheduleListQuery, response: S.InvoiceSchedule, list: true, emits: ["invoice.scheduled_created"] }),
  getInvoiceSchedule: def({ id: "getInvoiceSchedule", method: "GET", path: "/invoice-schedules/{id}", summary: "Get a recurring invoice schedule", tag: "Invoices", scope: "read:billing", params: S.IdParams, response: S.InvoiceSchedule }),
  listCreditNotes: def({ id: "listCreditNotes", method: "GET", path: "/credit-notes", summary: "List credit notes", tag: "Invoices", scope: "read:billing", query: S.CreditNoteListQuery, response: S.CreditNote, list: true }),
  getCreditNote: def({ id: "getCreditNote", method: "GET", path: "/credit-notes/{id}", summary: "Get a credit note", tag: "Invoices", scope: "read:billing", params: S.IdParams, response: S.CreditNote }),

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
  listWebhookEventTypes: def({ id: "listWebhookEventTypes", method: "GET", path: "/webhooks/event-types", summary: "Event type catalogue", description: "Every event type a subscription can receive, with a sample payload. No authentication required.", tag: "Webhooks", scope: null, response: S.WebhookEventTypeList }),
  sampleWebhook: def({ id: "getWebhookSample", method: "GET", path: "/webhooks/sample/{event}", summary: "Sample payload for an event type", description: "Use for Zapier 'perform list' so users can map fields before any real event fires.", tag: "Webhooks", scope: "read:settings", params: S.WebhookEventParams, response: S.WebhookSample }),

  /* ── Phase 6 breadth ─────────────────────────────────────────────────── */

  /* events (single) */
  getEvent: def({ id: "getEvent", method: "GET", path: "/events/{id}", summary: "Get one event", tag: "Events", scope: "read:settings", params: S.IdParams, response: S.Event }),

  /* expenses */
  listExpenses: def({ id: "listExpenses", method: "GET", path: "/expenses", summary: "List expenses", tag: "Expenses", scope: "read:billing", query: S.ExpenseListQuery, response: S.Expense, list: true }),
  createExpense: def({ id: "createExpense", method: "POST", path: "/expenses", summary: "Log an expense", tag: "Expenses", scope: "write:billing", body: S.ExpenseCreate, response: S.Expense, status: 201, emits: ["expense.created"], tools: ["expenses.log"] }),
  getExpense: def({ id: "getExpense", method: "GET", path: "/expenses/{id}", summary: "Get an expense", tag: "Expenses", scope: "read:billing", params: S.IdParams, response: S.Expense }),
  updateExpense: def({ id: "updateExpense", method: "PATCH", path: "/expenses/{id}", summary: "Update an expense", tag: "Expenses", scope: "write:billing", params: S.IdParams, body: S.ExpensePatch, response: S.Expense }),
  deleteExpense: def({ id: "deleteExpense", method: "DELETE", path: "/expenses/{id}", summary: "Delete an expense", tag: "Expenses", scope: "write:billing", params: S.IdParams, response: S.Deleted }),

  /* time entries */
  /* workforce */
  listStaff: def({ id: "listStaff", method: "GET", path: "/staff", summary: "List staff profiles", tag: "Workforce", scope: "read:team", query: S.StaffListQuery, response: S.Staff, list: true }),
  createStaff: def({ id: "createStaff", method: "POST", path: "/staff", summary: "Create a staff profile", tag: "Workforce", scope: "write:team", body: S.StaffCreate, response: S.Staff, status: 201 }),
  getStaff: def({ id: "getStaff", method: "GET", path: "/staff/{id}", summary: "Get a staff profile", tag: "Workforce", scope: "read:team", params: S.IdParams, response: S.Staff }),
  listShifts: def({ id: "listShifts", method: "GET", path: "/shifts", summary: "List shifts", tag: "Workforce", scope: "read:team", query: S.ShiftListQuery, response: S.Shift, list: true }),
  createShift: def({ id: "createShift", method: "POST", path: "/shifts", summary: "Create a shift", description: "Drafts by default; pass `publish: true` to publish immediately. Returns 409 with `details.conflicts` when the person is double-booked or on approved leave.", tag: "Workforce", scope: "write:team", body: S.ShiftCreate, response: S.Shift, status: 201, emits: ["shift.published"], tools: ["workforce.create_shift"] }),
  getShift: def({ id: "getShift", method: "GET", path: "/shifts/{id}", summary: "Get a shift", tag: "Workforce", scope: "read:team", params: S.IdParams, response: S.Shift }),
  listLeave: def({ id: "listLeave", method: "GET", path: "/leave", summary: "List leave requests", tag: "Workforce", scope: "read:team", query: S.LeaveListQuery, response: S.Leave, list: true, tools: ["workforce.leave_requests"] }),
  createLeave: def({ id: "createLeave", method: "POST", path: "/leave", summary: "Request leave", description: "Balance-checked for paid kinds (vacation, sick): 409 when the remaining hours are insufficient.", tag: "Workforce", scope: "write:team", body: S.LeaveCreate, response: S.Leave, status: 201, emits: ["leave.requested"] }),
  getLeave: def({ id: "getLeave", method: "GET", path: "/leave/{id}", summary: "Get a leave request", tag: "Workforce", scope: "read:team", params: S.IdParams, response: S.Leave }),

  listTimeEntries: def({ id: "listTimeEntries", method: "GET", path: "/time-entries", summary: "List time entries", tag: "Time", scope: "read:billing", query: S.TimeEntryListQuery, response: S.TimeEntry, list: true }),
  createTimeEntry: def({ id: "createTimeEntry", method: "POST", path: "/time-entries", summary: "Log time", description: "Omit `ended_at`/`minutes` to start a running timer.", tag: "Time", scope: "write:billing", body: S.TimeEntryCreate, response: S.TimeEntry, status: 201, tools: ["time.log"] }),
  getTimeEntry: def({ id: "getTimeEntry", method: "GET", path: "/time-entries/{id}", summary: "Get a time entry", tag: "Time", scope: "read:billing", params: S.IdParams, response: S.TimeEntry }),
  startTimer: def({ id: "startTimer", method: "POST", path: "/time-entries/start", summary: "Start a timer", tag: "Time", scope: "write:billing", body: S.TimerStart, response: S.TimeEntry, status: 201, tools: ["time.log"] }),
  stopTimer: def({ id: "stopTimer", method: "POST", path: "/time-entries/{id}/stop", summary: "Stop a running timer", tag: "Time", scope: "write:billing", params: S.IdParams, body: S.TimerStop, response: S.TimeEntry }),

  /* equipment */
  listEquipment: def({ id: "listEquipmentCheckouts", method: "GET", path: "/equipment", summary: "List equipment checkouts", tag: "Equipment", scope: "read:billing", query: S.EquipmentListQuery, response: S.EquipmentCheckout, list: true }),
  checkoutEquipment: def({ id: "checkoutEquipment", method: "POST", path: "/equipment/checkout", summary: "Check equipment out", description: "Reserves stock for tracked products so it cannot be double-booked.", tag: "Equipment", scope: "write:billing", body: S.EquipmentCheckoutCreate, response: S.EquipmentCheckout, status: 201, tools: ["inventory.checkout"] }),
  checkinEquipment: def({ id: "checkinEquipment", method: "POST", path: "/equipment/{id}/checkin", summary: "Check equipment back in", tag: "Equipment", scope: "write:billing", params: S.IdParams, response: S.EquipmentCheckout, tools: ["inventory.checkin"] }),

  /* change orders */
  listChangeOrders: def({ id: "listChangeOrders", method: "GET", path: "/change-orders", summary: "List change orders", tag: "Change orders", scope: "read:billing", query: S.ChangeOrderListQuery, response: S.ChangeOrder, list: true }),
  createChangeOrder: def({ id: "createChangeOrder", method: "POST", path: "/change-orders", summary: "Create a change order", tag: "Change orders", scope: "write:billing", body: S.ChangeOrderCreate, response: S.ChangeOrder, status: 201, tools: ["finance.create_change_order"] }),
  getChangeOrder: def({ id: "getChangeOrder", method: "GET", path: "/change-orders/{id}", summary: "Get a change order", tag: "Change orders", scope: "read:billing", params: S.IdParams, response: S.ChangeOrder }),
  setChangeOrderStatus: def({ id: "setChangeOrderStatus", method: "POST", path: "/change-orders/{id}/status", summary: "Move a change order (sent, accepted, rejected)", description: "Accepting bills the items onto the linked draft invoice or creates one.", tag: "Change orders", scope: "write:billing", params: S.IdParams, body: S.ChangeOrderStatus, response: S.ChangeOrderStatusResult }),

  /* sla policies */
  listSlaPolicies: def({ id: "listSlaPolicies", method: "GET", path: "/sla-policies", summary: "List SLA policies", tag: "Tickets", scope: "read:helpdesk", response: S.SlaPolicy, list: true }),
  createSlaPolicy: def({ id: "createSlaPolicy", method: "POST", path: "/sla-policies", summary: "Create an SLA policy", tag: "Tickets", scope: "write:helpdesk", body: S.SlaPolicyCreate, response: S.SlaPolicy, status: 201 }),
  getSlaPolicy: def({ id: "getSlaPolicy", method: "GET", path: "/sla-policies/{id}", summary: "Get an SLA policy", tag: "Tickets", scope: "read:helpdesk", params: S.IdParams, response: S.SlaPolicy }),
  updateSlaPolicy: def({ id: "updateSlaPolicy", method: "PATCH", path: "/sla-policies/{id}", summary: "Update an SLA policy", tag: "Tickets", scope: "write:helpdesk", params: S.IdParams, body: S.SlaPolicyPatch, response: S.SlaPolicy }),

  /* knowledge base */
  listKbArticles: def({ id: "listKbArticles", method: "GET", path: "/kb/articles", summary: "List knowledge-base articles", tag: "Knowledge", scope: "read:knowledge", query: S.KbArticleListQuery, response: S.KbArticle, list: true }),
  createKbArticle: def({ id: "createKbArticle", method: "POST", path: "/kb/articles", summary: "Create an article", tag: "Knowledge", scope: "write:knowledge", body: S.KbArticleCreate, response: S.KbArticle, status: 201, tools: ["kb.create_article"] }),
  getKbArticle: def({ id: "getKbArticle", method: "GET", path: "/kb/articles/{id}", summary: "Get an article", tag: "Knowledge", scope: "read:knowledge", params: S.IdParams, response: S.KbArticle }),
  updateKbArticle: def({ id: "updateKbArticle", method: "PATCH", path: "/kb/articles/{id}", summary: "Update an article", tag: "Knowledge", scope: "write:knowledge", params: S.IdParams, body: S.KbArticlePatch, response: S.KbArticle }),
  publishKbArticle: def({ id: "publishKbArticle", method: "POST", path: "/kb/articles/{id}/publish", summary: "Publish an article", description: "Sets status=published and indexes it for search.", tag: "Knowledge", scope: "write:knowledge", params: S.IdParams, response: S.KbArticle, tools: ["kb.publish_article"] }),
  searchKb: def({ id: "searchKb", method: "GET", path: "/kb/search", summary: "Search articles", description: "Semantic when a vector index is configured; keyword otherwise.", tag: "Knowledge", scope: "read:knowledge", query: S.KbSearchQuery, response: S.KbHit, list: true, tools: ["kb.search"] }),

  /* record types (write) */
  createRecordType: def({ id: "createRecordType", method: "POST", path: "/record-types", summary: "Create a record type", tag: "Records", scope: "write:crm", body: S.RecordTypeCreate, response: S.RecordType, status: 201 }),
  updateRecordType: def({ id: "updateRecordType", method: "PATCH", path: "/record-types/{type}", summary: "Update a record type", tag: "Records", scope: "write:crm", params: S.RecordTypeParams, body: S.RecordTypePatch, response: S.RecordType }),

  /* snapshots */
  listSnapshots: def({ id: "listSnapshots", method: "GET", path: "/snapshots", summary: "List workspace configuration snapshots", tag: "Snapshots", scope: "read:settings", query: S.ListQuery, response: S.SnapshotMetaView, list: true, tools: ["snapshots.list"] }),
  getSnapshot: def({ id: "getSnapshot", method: "GET", path: "/snapshots/{id}", summary: "Get snapshot metadata", tag: "Snapshots", scope: "read:settings", params: S.SnapshotParams, response: S.SnapshotMetaView }),
  /* marketplace */
  listListings: def({ id: "listMarketplaceListings", method: "GET", path: "/marketplace", summary: "Browse the marketplace", tag: "Marketplace", scope: "read:agents", query: S.ListingListQuery, response: S.Listing, list: true, tools: ["marketplace.search"] }),
  getListing: def({ id: "getMarketplaceListing", method: "GET", path: "/marketplace/{id}", summary: "Get a listing with its definition", tag: "Marketplace", scope: "read:agents", params: S.ListingParams, response: S.ListingDetail }),
  installListing: def({ id: "installMarketplaceListing", method: "POST", path: "/marketplace/{id}/install", summary: "Install a listing", description: "Idempotent per listing version.", tag: "Marketplace", scope: "write:agents", params: S.ListingParams, response: S.InstallResult, status: 201, tools: ["marketplace.install"] }),

  /* credits */
  creditBalance: def({ id: "getCreditBalance", method: "GET", path: "/credits/balance", summary: "Credit balance", tag: "Credits", scope: "read:billing", response: S.CreditBalance, tools: ["credits.balance"] }),
  creditLedger: def({ id: "listCreditLedger", method: "GET", path: "/credits/ledger", summary: "Credit ledger", tag: "Credits", scope: "read:billing", query: S.ListQuery, response: S.LedgerEntry, list: true }),

  /* privacy */
  listConsents: def({ id: "getConsents", method: "GET", path: "/privacy/consents", summary: "Consent state for a subject", tag: "Privacy", scope: "read:crm", query: S.ConsentListQuery, response: S.ConsentState, tools: ["privacy.consent_status"] }),
  recordConsent: def({ id: "recordConsent", method: "POST", path: "/privacy/consents", summary: "Record a consent grant", tag: "Privacy", scope: "write:crm", body: S.ConsentWrite, response: S.ConsentRecord, status: 201 }),
  withdrawConsent: def({ id: "withdrawConsent", method: "POST", path: "/privacy/consents/withdraw", summary: "Withdraw consent", tag: "Privacy", scope: "write:crm", body: S.ConsentWrite, response: S.ConsentRecord, status: 201 }),
  listDsr: def({ id: "listDataSubjectRequests", method: "GET", path: "/privacy/dsr", summary: "List data-subject requests", tag: "Privacy", scope: "read:settings", query: S.DsrListQuery, response: S.DsrRequest, list: true }),
  openDsr: def({ id: "openDataSubjectRequest", method: "POST", path: "/privacy/dsr", summary: "Open a data-subject request", description: "Opens in `received`; verification is emailed to the subject.", tag: "Privacy", scope: "write:settings", body: S.DsrOpen, response: S.DsrRequest, status: 201, tools: ["privacy.open_request"] }),

  /* voice */
  /* marketing */
  listMarketingCampaigns: def({ id: "listMarketingCampaigns", method: "GET", path: "/marketing/campaigns", summary: "List email/SMS campaigns", tag: "Marketing", scope: "read:crm", query: S.MarketingCampaignListQuery, response: S.MarketingCampaignWithStats, list: true, tools: ["marketing.campaign_stats"] }),
  getMarketingCampaign: def({ id: "getMarketingCampaign", method: "GET", path: "/marketing/campaigns/{id}", summary: "Get a campaign with funnel stats", tag: "Marketing", scope: "read:crm", params: S.IdParams, response: S.MarketingCampaignWithStats, tools: ["marketing.campaign_stats"] }),
  launchMarketingCampaign: def({ id: "launchMarketingCampaign", method: "POST", path: "/marketing/campaigns/{id}/launch", summary: "Launch a campaign", description: "Materialises recipients from the audience; contacts without current marketing consent for the channel are skipped, never sent. Refuses (400) when nobody is eligible.", tag: "Marketing", scope: "write:crm", params: S.IdParams, body: S.MarketingLaunchBody, response: S.MarketingLaunchResult, emits: ["campaign.sent"] }),
  listMarketingAudiences: def({ id: "listMarketingAudiences", method: "GET", path: "/marketing/audiences", summary: "List audiences", tag: "Marketing", scope: "read:crm", query: S.ListQuery, response: S.MarketingAudience, list: true, tools: ["marketing.audience_count"] }),
  listMarketingTemplates: def({ id: "listMarketingTemplates", method: "GET", path: "/marketing/templates", summary: "List email templates", tag: "Marketing", scope: "read:crm", query: S.ListQuery, response: S.MarketingTemplate, list: true }),

  listVoiceCampaigns: def({ id: "listVoiceCampaigns", method: "GET", path: "/voice/campaigns", summary: "List voice campaigns", tag: "Voice", scope: "read:messaging", response: S.VoiceCampaignWithStats, list: true, tools: ["voice.list_campaigns"] }),
  createVoiceCampaign: def({ id: "createVoiceCampaign", method: "POST", path: "/voice/campaigns", summary: "Create a voice campaign (draft)", tag: "Voice", scope: "write:messaging", body: S.VoiceCampaignCreate, response: S.VoiceCampaign, status: 201 }),
  getVoiceCampaign: def({ id: "getVoiceCampaign", method: "GET", path: "/voice/campaigns/{id}", summary: "Get a voice campaign", tag: "Voice", scope: "read:messaging", params: S.IdParams, response: S.VoiceCampaignWithStats, tools: ["voice.campaign_status"] }),
  startVoiceCampaign: def({ id: "startVoiceCampaign", method: "POST", path: "/voice/campaigns/{id}/start", summary: "Start (or resume) dialling", tag: "Voice", scope: "write:messaging", params: S.IdParams, response: S.VoiceCampaign, tools: ["voice.start_campaign"] }),
  pauseVoiceCampaign: def({ id: "pauseVoiceCampaign", method: "POST", path: "/voice/campaigns/{id}/pause", summary: "Pause dialling", tag: "Voice", scope: "write:messaging", params: S.IdParams, response: S.VoiceCampaign, tools: ["voice.pause_campaign"] }),
  listVoiceTargets: def({ id: "listVoiceTargets", method: "GET", path: "/voice/campaigns/{id}/targets", summary: "List campaign targets", tag: "Voice", scope: "read:messaging", params: S.IdParams, response: S.VoiceTarget, list: true }),
  addVoiceTargets: def({ id: "addVoiceTargets", method: "POST", path: "/voice/campaigns/{id}/targets", summary: "Add targets from the CRM or ad-hoc numbers", description: "Do-not-call entries and (by default) contacts without voice consent are skipped.", tag: "Voice", scope: "write:messaging", params: S.IdParams, body: S.VoiceTargetsAdd, response: S.VoiceTargetsAddResult, status: 201 }),

  /* mail */
  listMailAccounts: def({ id: "listMailAccounts", method: "GET", path: "/mail/accounts", summary: "List connected mailboxes", tag: "Mail", scope: "read:messaging", response: S.MailAccount, list: true }),

  /* accounting */
  listAccountingConnections: def({ id: "listAccountingConnections", method: "GET", path: "/accounting/connections", summary: "List accounting connections", tag: "Accounting", scope: "read:billing", response: S.AccountingConnection, list: true, tools: ["accounting.sync_status"] }),
  pushAccounting: def({ id: "pushToAccounting", method: "POST", path: "/accounting/push", summary: "Push an entity to accounting", tag: "Accounting", scope: "write:billing", body: S.AccountingPush, response: S.AccountingPushOutcome, list: true, tools: ["accounting.push_invoice", "accounting.push"] }),
  listAccountingLinks: def({ id: "listAccountingLinks", method: "GET", path: "/accounting/links", summary: "Entity ↔ remote id links", tag: "Accounting", scope: "read:billing", query: S.AccountingLinkQuery, response: S.AccountingLink, list: true }),

  /* optimize */
  optimizeCashflow: def({ id: "optimizeCashflow", method: "GET", path: "/optimize/cashflow", summary: "Cashflow forecast", tag: "Optimize", scope: "read:reports", query: S.CashflowQuery, response: S.OptimizeResult, tools: ["optimize.cashflow"] }),
  optimizeCapacity: def({ id: "optimizeCapacity", method: "GET", path: "/optimize/capacity", summary: "Capacity plan", tag: "Optimize", scope: "read:reports", query: S.CapacityQuery, response: S.OptimizeResult, tools: ["optimize.capacity"] }),
  optimizePricing: def({ id: "optimizePricing", method: "POST", path: "/optimize/pricing", summary: "Pricing suggestion for a set of line items", tag: "Optimize", scope: "write:reports", body: S.PricingBody, response: S.OptimizeResult, tools: ["optimize.pricing"] }),

  /* agents */
  listAgents: def({ id: "listAgents", method: "GET", path: "/agents", summary: "List agents", tag: "Agents", scope: "read:agents", response: S.Agent, list: true, tools: ["agents.list"] }),
  getAgent: def({ id: "getAgent", method: "GET", path: "/agents/{id}", summary: "Get an agent", tag: "Agents", scope: "read:agents", params: S.IdParams, response: S.Agent }),
  triggerAgentRun: def({ id: "triggerAgentRun", method: "POST", path: "/agents/{id}/runs", summary: "Queue a run", tag: "Agents", scope: "write:agents", params: S.IdParams, body: S.AgentRunCreate, response: S.AgentRunQueued, status: 201, tools: ["agents.run_agent"] }),
  listAgentRuns: def({ id: "listAgentRuns", method: "GET", path: "/agents/runs", summary: "List runs", tag: "Agents", scope: "read:agents", query: S.AgentRunListQuery, response: S.AgentRun, list: true }),
  getAgentRun: def({ id: "getAgentRun", method: "GET", path: "/agents/runs/{id}", summary: "Get a run", tag: "Agents", scope: "read:agents", params: S.IdParams, response: S.AgentRun }),

  /* approvals */
  listApprovals: def({ id: "listApprovals", method: "GET", path: "/approvals", summary: "List approvals", tag: "Agents", scope: "read:agents", query: S.ApprovalListQuery, response: S.Approval, list: true }),
  /* ── Phase 7 lane A: procurement ─────────────────────────────────────── */
  listSuppliers: def({ id: "listSuppliers", method: "GET", path: "/suppliers", summary: "List suppliers", tag: "Procurement", scope: "read:billing", query: S.SupplierListQuery, response: S.Supplier, list: true }),
  createSupplier: def({ id: "createSupplier", method: "POST", path: "/suppliers", summary: "Create a supplier", tag: "Procurement", scope: "write:billing", body: S.SupplierCreate, response: S.Supplier, status: 201 }),
  getSupplier: def({ id: "getSupplier", method: "GET", path: "/suppliers/{id}", summary: "Get a supplier", tag: "Procurement", scope: "read:billing", params: S.IdParams, response: S.Supplier }),
  updateSupplier: def({ id: "updateSupplier", method: "PATCH", path: "/suppliers/{id}", summary: "Update a supplier", tag: "Procurement", scope: "write:billing", params: S.IdParams, body: S.SupplierPatch, response: S.Supplier }),
  listPurchaseOrders: def({ id: "listPurchaseOrders", method: "GET", path: "/purchase-orders", summary: "List purchase orders", tag: "Procurement", scope: "read:billing", query: S.PurchaseOrderListQuery, response: S.PurchaseOrder, list: true }),
  createPurchaseOrder: def({ id: "createPurchaseOrder", method: "POST", path: "/purchase-orders", summary: "Create a draft purchase order", description: "`items[].unit_minor` is the unit cost. Totals use the org tax engine.", tag: "Procurement", scope: "write:billing", body: S.PurchaseOrderCreate, response: S.PurchaseOrder, status: 201, tools: ["procurement.create_po"] }),
  getPurchaseOrder: def({ id: "getPurchaseOrder", method: "GET", path: "/purchase-orders/{id}", summary: "Get a purchase order", tag: "Procurement", scope: "read:billing", params: S.IdParams, response: S.PurchaseOrder }),
  sendPurchaseOrder: def({ id: "sendPurchaseOrder", method: "POST", path: "/purchase-orders/{id}/send", summary: "Send a purchase order to the supplier", description: "Marks the order sent and queues an email with the line items.", tag: "Procurement", scope: "write:billing", params: S.IdParams, body: S.SendBody, response: S.PurchaseOrder, emits: ["purchase_order.sent"] }),
  receivePurchaseOrder: def({ id: "receivePurchaseOrder", method: "POST", path: "/purchase-orders/{id}/receive", summary: "Receive goods against a purchase order", description: "Writes `receive` stock movements, re-costs products (weighted average) and moves the order to partially_received or received.", tag: "Procurement", scope: "write:billing", params: S.IdParams, body: S.PurchaseOrderReceive, response: S.PurchaseOrderReceiveResult, emits: ["purchase_order.received"] }),
  listSupplierBills: def({ id: "listSupplierBills", method: "GET", path: "/supplier-bills", summary: "List supplier bills", tag: "Procurement", scope: "read:billing", query: S.SupplierBillListQuery, response: S.SupplierBill, list: true }),
  createSupplierBill: def({ id: "createSupplierBill", method: "POST", path: "/supplier-bills", summary: "Create a supplier bill", tag: "Procurement", scope: "write:billing", body: S.SupplierBillCreate, response: S.SupplierBill, status: 201, emits: ["supplier_bill.created"] }),
  getSupplierBill: def({ id: "getSupplierBill", method: "GET", path: "/supplier-bills/{id}", summary: "Get a supplier bill", tag: "Procurement", scope: "read:billing", params: S.IdParams, response: S.SupplierBill }),
  paySupplierBill: def({ id: "paySupplierBill", method: "POST", path: "/supplier-bills/{id}/pay", summary: "Record a payment on a supplier bill", description: "Bumps paid_minor atomically, moves the status and logs an expense (category `purchases`). Emits `supplier_bill.paid` when settled.", tag: "Procurement", scope: "write:billing", params: S.IdParams, body: S.SupplierBillPay, response: S.SupplierBillPayResult, status: 201, emits: ["supplier_bill.paid"] }),

  decideApproval: def({ id: "decideApproval", method: "POST", path: "/approvals/{id}/decide", summary: "Approve or reject", description: "Resumes the agent run, or executes a copilot/MCP action inline.", tag: "Agents", scope: "write:agents", params: S.IdParams, body: S.ApprovalDecide, response: S.ApprovalDecided }),
  /* reports & dashboards */
  listSavedReports: def({ id: "listSavedReports", method: "GET", path: "/reports/saved", summary: "List saved reports", tag: "Reports", scope: "read:reports", response: S.SavedReport, list: true, tools: ["reports.list_saved"] }),
  getSavedReport: def({ id: "getSavedReport", method: "GET", path: "/reports/saved/{id}", summary: "Get a saved report", tag: "Reports", scope: "read:reports", params: S.IdParams, response: S.SavedReport }),
  runSavedReport: def({ id: "runSavedReport", method: "GET", path: "/reports/saved/{id}/run", summary: "Run a saved report", description: "Executes the saved spec against live data and returns aggregated rows (max 5000) plus totals.", tag: "Reports", scope: "read:reports", params: S.IdParams, response: S.SavedReportRun, tools: ["reports.run"] }),
  listDashboards: def({ id: "listDashboards", method: "GET", path: "/dashboards", summary: "List dashboards", description: "Role defaults and personal dashboards (layout of saved-report cards and built-in widgets).", tag: "Reports", scope: "read:reports", response: S.Dashboard, list: true }),

  /* documents (e-sign) */
  listDocumentTemplates: def({ id: "listDocumentTemplates", method: "GET", path: "/document-templates", summary: "List document templates", tag: "Documents", scope: "read:crm", response: S.DocumentTemplate, list: true }),
  listDocuments: def({ id: "listDocuments", method: "GET", path: "/documents", summary: "List documents", tag: "Documents", scope: "read:crm", query: S.DocumentListQuery, response: S.Document, list: true, tools: ["documents.status"] }),
  createDocument: def({ id: "createDocument", method: "POST", path: "/documents", summary: "Create a draft document", description: "From a template (merge fields rendered from the contact and org, plus `merge_data`) or a free `body_md`.", tag: "Documents", scope: "write:crm", body: S.DocumentCreate, response: S.Document, status: 201, tools: ["documents.create_from_template"] }),
  getDocument: def({ id: "getDocument", method: "GET", path: "/documents/{id}", summary: "Get a document with signers", tag: "Documents", scope: "read:crm", params: S.IdParams, response: S.Document, tools: ["documents.status"] }),
  sendDocument: def({ id: "sendDocument", method: "POST", path: "/documents/{id}/send", summary: "Send for e-signature", description: "Freezes the body (SHA-256 fingerprint), issues one recipient-bound signing link per signer and emails those whose turn it is.", tag: "Documents", scope: "write:crm", params: S.IdParams, body: S.DocumentSendBody, response: S.DocumentSendResult, emits: ["document.sent"], tools: ["documents.send"] }),

  /* automations (v2) */
  listAutomations: def({ id: "listAutomations", method: "GET", path: "/automations", summary: "List automations", description: "Event-driven workflows (trigger → conditions → steps). Legacy automations are converted on read.", tag: "Automations", scope: "read:agents", query: S.AutomationListQuery, response: S.Automation, list: true, tools: ["automations.list"] }),
  getAutomation: def({ id: "getAutomation", method: "GET", path: "/automations/{id}", summary: "Get an automation", tag: "Automations", scope: "read:agents", params: S.IdParams, response: S.Automation }),
  enableAutomation: def({ id: "enableAutomation", method: "POST", path: "/automations/{id}/enable", summary: "Enable an automation", tag: "Automations", scope: "write:agents", params: S.IdParams, response: S.Automation, tools: ["automations.toggle"] }),
  disableAutomation: def({ id: "disableAutomation", method: "POST", path: "/automations/{id}/disable", summary: "Disable an automation", tag: "Automations", scope: "write:agents", params: S.IdParams, response: S.Automation, tools: ["automations.toggle"] }),
  listAutomationRuns: def({ id: "listAutomationRuns", method: "GET", path: "/automations/{id}/runs", summary: "List runs of an automation", tag: "Automations", scope: "read:agents", params: S.IdParams, query: S.AutomationRunListQuery, response: S.AutomationRun, list: true, emits: ["automation.run_finished", "automation.run_failed"] }),
  getAutomationRun: def({ id: "getAutomationRun", method: "GET", path: "/automations/runs/{id}", summary: "Get an automation run", tag: "Automations", scope: "read:agents", params: S.IdParams, response: S.AutomationRun }),

  /* projects */
  listProjects: def({ id: "listProjects", method: "GET", path: "/projects", summary: "List projects", tag: "Projects", scope: "read:tasks", query: S.ProjectListQuery, response: S.Project, list: true, tools: ["projects.list"] }),
  createProject: def({ id: "createProject", method: "POST", path: "/projects", summary: "Create a project", tag: "Projects", scope: "write:tasks", body: S.ProjectCreate, response: S.Project, status: 201, emits: ["project.created"] }),
  getProject: def({ id: "getProject", method: "GET", path: "/projects/{id}", summary: "Get a project", tag: "Projects", scope: "read:tasks", params: S.IdParams, response: S.Project, tools: ["projects.status"] }),
  updateProject: def({ id: "updateProject", method: "PATCH", path: "/projects/{id}", summary: "Update a project", description: "Changing `status` emits `project.status_changed`.", tag: "Projects", scope: "write:tasks", params: S.IdParams, body: S.ProjectPatch, response: S.Project, emits: ["project.status_changed"] }),
  listProjectMilestones: def({ id: "listProjectMilestones", method: "GET", path: "/projects/{id}/milestones", summary: "List milestones of a project", tag: "Projects", scope: "read:tasks", params: S.IdParams, response: S.ProjectMilestone, list: true }),
  createProjectMilestone: def({ id: "createProjectMilestone", method: "POST", path: "/projects/{id}/milestones", summary: "Add a milestone", tag: "Projects", scope: "write:tasks", params: S.IdParams, body: S.ProjectMilestoneCreate, response: S.ProjectMilestone, status: 201 }),
  listProjectTasks: def({ id: "listProjectTasks", method: "GET", path: "/projects/{id}/tasks", summary: "List tasks of a project", tag: "Projects", scope: "read:tasks", params: S.IdParams, query: S.ProjectTaskListQuery, response: S.ProjectTask, list: true }),
  createProjectTask: def({ id: "createProjectTask", method: "POST", path: "/projects/{id}/tasks", summary: "Add a task to a project", description: "Creates a row in the shared tasks table with `project_id` set; assignee, due date, priority and estimate are optional.", tag: "Projects", scope: "write:tasks", params: S.IdParams, body: S.ProjectTaskCreate, response: S.ProjectTask, status: 201, emits: ["task.created"], tools: ["projects.create_task"] }),
  /* ── Phase 9 lane B: customer portal ────────────────────────────────── */
  listPortalMessages: def({ id: "listPortalMessages", method: "GET", path: "/portal-messages", summary: "List portal messages", description: "Customer portal conversations, newest first; filter by `contact_id`.", tag: "Portal", scope: "read:crm", query: S.PortalMessageListQuery, response: S.PortalMessage, list: true }),
  createPortalMessage: def({ id: "createPortalMessage", method: "POST", path: "/portal-messages", summary: "Reply to a customer in their portal", description: "Adds a staff reply and emails the contact a notice with their portal link.", tag: "Portal", scope: "write:crm", body: S.PortalMessageCreate, response: S.PortalMessage, status: 201 }),
  /* ── Phase 8 lane B: storefront + orders ────────────────────────────── */
  listOrders: def({ id: "listOrders", method: "GET", path: "/orders", summary: "List storefront orders", tag: "Orders", scope: "read:billing", query: S.OrderListQuery, response: S.Order, list: true, tools: ["orders.list"] }),
  getOrder: def({ id: "getOrder", method: "GET", path: "/orders/{id}", summary: "Get an order", tag: "Orders", scope: "read:billing", params: S.IdParams, response: S.Order }),
  fulfilOrder: def({ id: "fulfilOrder", method: "POST", path: "/orders/{id}/fulfil", summary: "Mark a paid order fulfilled", description: "Only `paid` orders can be fulfilled. Emails the customer a dispatch / ready-for-collection notice.", tag: "Orders", scope: "write:billing", params: S.IdParams, response: S.Order, emits: ["order.fulfilled"], tools: ["orders.fulfil"] }),
  cancelOrder: def({ id: "cancelOrder", method: "POST", path: "/orders/{id}/cancel", summary: "Cancel an order", description: "Pending orders release their stock reservation and void the invoice; paid orders are refunded through the payment provider (`restock` receives the goods back).", tag: "Orders", scope: "write:billing", params: S.IdParams, body: S.OrderCancel, response: S.OrderCancelResult, emits: ["order.cancelled"] }),
  listStorefrontProducts: def({ id: "listStorefrontProducts", method: "GET", path: "/storefront/products", summary: "List products with storefront visibility", tag: "Orders", scope: "read:billing", response: S.StorefrontProduct, list: true, tools: ["storefront.catalog"] }),
  putStorefrontProduct: def({ id: "putStorefrontProduct", method: "PATCH", path: "/storefront/products", summary: "Set a product's storefront visibility, order, description or image", tag: "Orders", scope: "write:billing", body: S.StorefrontProductPut, response: S.StorefrontProduct }),
} as const;

export type RouteId = keyof typeof ROUTES;

export const ROUTE_LIST: readonly RouteDef[] = Object.values(ROUTES);

export const TAGS: ReadonlyArray<{ name: string; description: string }> = [
  { name: "Meta", description: "Discovery and key information." },
  { name: "Contacts", description: "CRM contacts." },
  { name: "Tasks", description: "Simple to-dos." },
  { name: "Quotes", description: "Quotes with versioned line items." },
  { name: "Invoices", description: "Invoices, payments, tax rates, recurring schedules and credit notes." },
  { name: "Calendar", description: "Bookings, booking types and availability." },
  { name: "Tickets", description: "Helpdesk tickets and replies." },
  { name: "Records", description: "Configurable record types (pipelines, cases, jobs…)." },
  { name: "Products", description: "Pricebook and inventory." },
  { name: "Events", description: "Event log for polling integrations." },
  { name: "Webhooks", description: "Outbound webhook subscriptions (REST hooks)." },
  { name: "Expenses", description: "Cash out, optionally tied to a job." },
  { name: "Time", description: "Time entries and running timers." },
  { name: "Equipment", description: "Equipment checkouts against the pricebook." },
  { name: "Change orders", description: "Priced scope changes against quotes and invoices." },
  { name: "Knowledge", description: "Knowledge-base articles and search." },
  { name: "Marketplace", description: "Installable agents, playbooks, automations and record packs." },
  { name: "Snapshots", description: "Portable workspace configuration snapshots (never data)." },
  { name: "Credits", description: "AI credit balance and ledger." },
  { name: "Privacy", description: "Consent ledger and data-subject requests." },
  { name: "Marketing", description: "Consent-first email / SMS campaigns, audiences and templates." },
  { name: "Voice", description: "Outbound voice campaigns." },
  { name: "Mail", description: "Connected mailboxes." },
  { name: "Accounting", description: "Accounting connections and sync." },
  { name: "Optimize", description: "Cashflow, capacity and pricing models." },
  { name: "Agents", description: "Agents, runs and approvals." },
  { name: "Workforce", description: "Staff profiles, shifts (rota) and leave." },
  { name: "Automations", description: "Event-driven workflows: triggers, conditions, steps, templates and run history." },
  { name: "Documents", description: "Templates, generated documents and e-signatures." },
  { name: "Reports", description: "Saved reports, report runs and dashboards." },
  { name: "Procurement", description: "Suppliers, purchase orders, receiving and supplier bills (accounts payable)." },
  { name: "Orders", description: "Public storefront orders and catalog visibility." },
  { name: "Portal", description: "Customer portal conversations." },
  { name: "Projects", description: "Projects, milestones and project tasks (assignees, due dates, budgets)." },
];

