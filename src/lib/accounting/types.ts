/**
 * Accounting export abstraction. The app never talks to QuickBooks/Xero
 * directly; it asks the active provider to export a date range of invoices,
 * expenses or payments. The CSV provider is the always-available baseline.
 */

export type AccountingEntity = "invoices" | "expenses" | "payments";
export const ACCOUNTING_ENTITIES: readonly AccountingEntity[] = ["invoices", "expenses", "payments"];

export interface DateRange {
  from?: string | null;
  to?: string | null;
}

export interface ExportFile {
  filename: string;
  contentType: string;
  body: string;
  /** Rows exported (excluding the header). */
  rows: number;
}

export interface AccountingProvider {
  readonly name: string;
  /** True when the provider has the credentials it needs. CSV is always configured. */
  configured(): boolean;
  exportInvoices(dataId: string, range: DateRange): Promise<ExportFile>;
  exportExpenses(dataId: string, range: DateRange): Promise<ExportFile>;
  exportPayments(dataId: string, range: DateRange): Promise<ExportFile>;
}

export class AccountingNotConfiguredError extends Error {
  constructor(provider: string) {
    super(`Accounting provider "${provider}" is not configured`);
    this.name = "AccountingNotConfiguredError";
  }
}

// ── Live sync (Phase 5) ──────────────────────────────────────────────────────

export const LIVE_ACCOUNTING_PROVIDERS = ["quickbooks", "xero", "simulated"] as const;
export type LiveAccountingProviderId = (typeof LIVE_ACCOUNTING_PROVIDERS)[number];
export function isLiveAccountingProviderId(v: unknown): v is LiveAccountingProviderId {
  return typeof v === "string" && (LIVE_ACCOUNTING_PROVIDERS as readonly string[]).includes(v);
}

export const ACCOUNTING_ENTITY_KINDS = ["contact", "invoice", "payment", "expense", "product", "supplier", "bill", "bill_payment"] as const;
export type AccountingEntityKind = (typeof ACCOUNTING_ENTITY_KINDS)[number];
export function isAccountingEntityKind(v: unknown): v is AccountingEntityKind {
  return typeof v === "string" && (ACCOUNTING_ENTITY_KINDS as readonly string[]).includes(v);
}

export type AccountingConnectionStatus = "connected" | "error" | "disabled";

/** OAuth tokens (stored encrypted). */
export interface AccountingAuth {
  access_token?: string;
  refresh_token?: string;
  /** epoch ms */
  expires_at?: number;
  /** epoch ms when the refresh token itself expires (QBO: 100 days) */
  refresh_expires_at?: number;
}

/** Account mappings chosen in the settings UI. Ids are provider account ids / codes. */
export interface AccountingSettings {
  sales_account_id?: string | null;
  expense_account_id?: string | null;
  /** Bank / undeposited funds account payments land in. */
  deposit_account_id?: string | null;
  /** Default tax code (QBO TaxCodeRef / Xero TaxType). */
  tax_code_id?: string | null;
  /** Tax code for zero-rated lines. */
  zero_tax_code_id?: string | null;
  push_payments?: boolean;
  push_expenses?: boolean;
}

export interface AccountingConnectionRow {
  id: string;
  user_id: string;
  provider: LiveAccountingProviderId;
  auth: string | null;
  realm_id: string | null;
  tenant_id: string | null;
  company_name: string | null;
  status: AccountingConnectionStatus;
  sync_cursor: string | null;
  last_sync_at: string | null;
  last_error: string | null;
  settings: string | null;
  created_at: string;
}

/** What the UI sees: never includes credentials. */
export interface AccountingConnectionView {
  id: string;
  provider: LiveAccountingProviderId;
  realm_id: string | null;
  tenant_id: string | null;
  company_name: string | null;
  status: AccountingConnectionStatus;
  last_sync_at: string | null;
  last_error: string | null;
  settings: AccountingSettings;
  created_at: string;
  counts: { linked: number; errors: number };
}

export interface AccountingLinkRow {
  id: string;
  user_id: string;
  connection_id: string;
  entity_kind: AccountingEntityKind;
  entity_id: string;
  remote_id: string | null;
  remote_updated_at: string | null;
  remote_meta: string | null;
  last_pushed_at: string | null;
  last_pulled_at: string | null;
  hash: string | null;
  error: string | null;
  created_at: string;
}

export interface AccountingSyncLogRow {
  id: string;
  connection_id: string;
  direction: "push" | "pull";
  entity_kind: string | null;
  entity_id: string | null;
  remote_id: string | null;
  status: "ok" | "error" | "skipped";
  message: string | null;
  created_at: string;
}

/** Provider + connection details a provider call needs (no secrets). */
export interface ConnectionContext {
  id: string;
  realmId: string | null;
  tenantId: string | null;
  settings: AccountingSettings;
}

/** Previously stored remote reference for an entity, if any. */
export interface RemoteRef {
  remoteId: string;
  /** QBO SyncToken or other optimistic-locking token. */
  meta: Record<string, string> | null;
}

export interface PushResult {
  remoteId: string;
  remoteUpdatedAt: string | null;
  meta?: Record<string, string> | null;
  /** The exact payload sent (persisted hash + shown by the simulated provider). */
  payload: unknown;
}

export interface AccountOption {
  id: string;
  name: string;
  /** income | expense | bank | tax | other */
  type: string;
  code?: string | null;
}

/** A payment recorded in the accounting system against one of our invoices. */
export interface RemotePayment {
  remoteId: string;
  /** Remote invoice id it was applied to. */
  remoteInvoiceId: string;
  amountMinor: number;
  currency: string | null;
  paidAt: string | null;
}

export interface PullPaymentsResult {
  payments: RemotePayment[];
  cursor: string | null;
}

/** Domain shapes the push methods consume (kept provider-neutral). */
export interface AccountingContact {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
}

export interface AccountingInvoiceLine {
  description: string;
  qty: number;
  unit_minor: number;
  tax_rate_bp: number;
  product_id?: string | null;
  /** Remote item id when the product has been pushed. */
  item_remote_id?: string | null;
}

export interface AccountingInvoice {
  id: string;
  number: string;
  status: string;
  currency: string;
  subtotal_minor: number;
  tax_minor: number;
  total_minor: number;
  due_at: string | null;
  created_at: string;
  notes: string | null;
  items: AccountingInvoiceLine[];
  contact_remote_id: string | null;
}

export interface AccountingPayment {
  id: string;
  invoice_id: string;
  amount_minor: number;
  currency: string;
  provider: string;
  provider_ref: string | null;
  created_at: string;
  invoice_remote_id: string;
  contact_remote_id: string | null;
}

export interface AccountingExpense {
  id: string;
  category: string;
  vendor: string | null;
  description: string | null;
  amount_minor: number;
  tax_minor: number;
  currency: string;
  spent_at: string;
}

export interface AccountingProduct {
  id: string;
  sku: string | null;
  name: string;
  description: string | null;
  kind: string;
  unit_price_minor: number;
  cost_minor: number;
  currency: string;
  tax_rate_bp: number;
  track_stock: boolean;
}

/** Supplier (vendor) — Phase 7 procurement. */
export interface AccountingSupplier {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  tax_number: string | null;
}

export interface AccountingBillLine {
  description: string;
  qty: number;
  unit_minor: number;
  tax_rate_bp: number;
  product_id?: string | null;
  item_remote_id?: string | null;
}

/** Supplier bill (accounts payable) → QBO Bill / Xero ACCPAY invoice. */
export interface AccountingBill {
  id: string;
  number: string;
  supplier_ref: string | null;
  status: string;
  currency: string;
  subtotal_minor: number;
  tax_minor: number;
  total_minor: number;
  issued_at: string;
  due_at: string | null;
  notes: string | null;
  items: AccountingBillLine[];
  supplier_remote_id: string | null;
  supplier_name: string;
}

/** Payment made against a supplier bill → QBO BillPayment / Xero ACCPAY Payment. */
export interface AccountingBillPayment {
  id: string;
  bill_id: string;
  amount_minor: number;
  currency: string;
  method: string | null;
  ref: string | null;
  paid_at: string;
  bill_remote_id: string;
  supplier_remote_id: string | null;
}

export interface LiveAccountingProvider {
  readonly id: LiveAccountingProviderId;
  readonly label: string;
  configured(): boolean;
  unavailableReason(): string | null;
  oauthStartUrl(state: string, redirectUri: string): string;
  /** `realm` is QBO's realmId query param; Xero discovers the tenant via /connections. */
  exchangeCode(code: string, redirectUri: string, realm?: string | null): Promise<{ auth: AccountingAuth; realmId: string | null; tenantId: string | null; companyName: string | null }>;
  refresh(auth: AccountingAuth): Promise<AccountingAuth>;
  listAccounts(auth: AccountingAuth, conn: ConnectionContext): Promise<AccountOption[]>;
  pushCustomer(auth: AccountingAuth, conn: ConnectionContext, contact: AccountingContact, existing: RemoteRef | null): Promise<PushResult>;
  pushInvoice(auth: AccountingAuth, conn: ConnectionContext, invoice: AccountingInvoice, existing: RemoteRef | null): Promise<PushResult>;
  pushPayment(auth: AccountingAuth, conn: ConnectionContext, payment: AccountingPayment, existing: RemoteRef | null): Promise<PushResult>;
  pushExpense(auth: AccountingAuth, conn: ConnectionContext, expense: AccountingExpense, existing: RemoteRef | null): Promise<PushResult>;
  pushItem(auth: AccountingAuth, conn: ConnectionContext, product: AccountingProduct, existing: RemoteRef | null): Promise<PushResult>;
  pushVendor(auth: AccountingAuth, conn: ConnectionContext, supplier: AccountingSupplier, existing: RemoteRef | null): Promise<PushResult>;
  pushBill(auth: AccountingAuth, conn: ConnectionContext, bill: AccountingBill, existing: RemoteRef | null): Promise<PushResult>;
  pushBillPayment(auth: AccountingAuth, conn: ConnectionContext, payment: AccountingBillPayment, existing: RemoteRef | null): Promise<PushResult>;
  pullPayments(auth: AccountingAuth, conn: ConnectionContext, cursor: string | null): Promise<PullPaymentsResult>;
}
