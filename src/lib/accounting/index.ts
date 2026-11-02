import { csvProvider, stubProvider } from "./csv";
import type { AccountingProvider } from "./types";

export type { AccountingProvider, AccountingEntity, DateRange, ExportFile } from "./types";
export { ACCOUNTING_ENTITIES, AccountingNotConfiguredError } from "./types";
export { toCsv, parseCsv, csvField } from "./csv";

export const ACCOUNTING_PROVIDER_IDS = ["csv", "quickbooks", "xero"] as const;
export type AccountingProviderId = (typeof ACCOUNTING_PROVIDER_IDS)[number];

const PROVIDERS: Record<AccountingProviderId, AccountingProvider> = {
  csv: csvProvider,
  // Stubs until OAuth + API mapping land; they throw AccountingNotConfiguredError.
  quickbooks: stubProvider("quickbooks"),
  xero: stubProvider("xero"),
};

export function isAccountingProviderId(v: unknown): v is AccountingProviderId {
  return typeof v === "string" && (ACCOUNTING_PROVIDER_IDS as readonly string[]).includes(v);
}

/** Active provider id from ACCOUNTING_PROVIDER (default "csv"). */
export function activeAccountingProviderId(): AccountingProviderId {
  const v = process.env.ACCOUNTING_PROVIDER?.trim().toLowerCase();
  return isAccountingProviderId(v) ? v : "csv";
}

export function getAccountingProvider(id?: string | null): AccountingProvider {
  const pid = isAccountingProviderId(id) ? id : activeAccountingProviderId();
  return PROVIDERS[pid];
}

export function describeAccountingProviders(): Array<{ id: AccountingProviderId; configured: boolean; active: boolean }> {
  const active = activeAccountingProviderId();
  return ACCOUNTING_PROVIDER_IDS.map((id) => ({ id, configured: PROVIDERS[id].configured(), active: id === active }));
}
