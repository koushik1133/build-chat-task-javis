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
