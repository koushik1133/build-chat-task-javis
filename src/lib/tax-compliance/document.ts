import { listTaxRates } from "@/lib/money/tax-rates";
import { query } from "@/lib/dsql";
import { tableExists } from "@/lib/table-exists";
import type { LineItem } from "@/lib/money/items";
import type { TaxRateLike } from "@/lib/money/tax";
import type { Address, ContactTaxInfo } from "./regimes";
import { resolveTax, type ComplianceMeta } from "./resolver";
import { getTaxProfile } from "./store";

export interface ResolveDocumentOptions {
  contact?: ContactTaxInfo | null;
  contactId?: string | null;
  shipTo?: Address | null;
  docDate?: Date;
  reverseCharge?: boolean;
}

export async function loadContactTax(dataId: string, contactId: string): Promise<ContactTaxInfo | null> {
  const rows = await query<{ id: string; tax_number: string | null; tax_country: string | null; tax_state: string | null; tax_registration_type: string | null; billing_address: string | null }>(
    `SELECT id, tax_number, tax_country, tax_state, tax_registration_type, billing_address FROM crm_contacts WHERE id = $1 AND user_id = $2`,
    [contactId, dataId]
  ).catch(async () => {
    // New columns missing (migration not applied): fall back to the legacy columns.
    return query<{ id: string; tax_number: string | null; tax_country: string | null; tax_state: string | null; tax_registration_type: string | null; billing_address: string | null }>(
      `SELECT id, tax_number, NULL AS tax_country, NULL AS tax_state, NULL AS tax_registration_type, billing_address FROM crm_contacts WHERE id = $1 AND user_id = $2`,
      [contactId, dataId]
    );
  });
  return rows[0] ?? null;
}

/**
 * Optional hook used by resolveDocumentTotals: when the org has a tax profile,
 * returns lines re-pointed at regime component rates + compliance metadata.
 * Returns null when there is no profile (behaviour unchanged).
 */
export async function resolveDocumentTax(
  dataId: string,
  items: readonly LineItem[],
  opts: ResolveDocumentOptions = {}
): Promise<{ items: LineItem[]; rates: TaxRateLike[]; meta: ComplianceMeta } | null> {
  const profile = await getTaxProfile(dataId);
  if (!profile || profile.regime === "generic") return null;
  const catalogue = await listTaxRates(dataId, { includeInactive: true }).catch(() => []);
  const contact = opts.contact ?? (opts.contactId ? await loadContactTax(dataId, opts.contactId).catch(() => null) : null);
  let exemptions: Array<{ jurisdiction: string; certificate_ref: string | null; expires_at: string | null }> = [];
  if (profile.regime === "us_sales" && contact?.id && (await tableExists("tax_exemptions"))) {
    exemptions = await query<{ jurisdiction: string; certificate_ref: string | null; expires_at: string | null }>(
      `SELECT jurisdiction, certificate_ref, expires_at FROM tax_exemptions WHERE user_id = $1 AND contact_id = $2`,
      [dataId, contact.id]
    );
  }
  const r = await resolveTax<LineItem>({
    profile, items, rates: catalogue, contact, shipTo: opts.shipTo ?? null, docDate: opts.docDate, reverseCharge: opts.reverseCharge, exemptions,
    jurisdictionRates: catalogue.filter((c) => c.jurisdiction),
  });
  return r;
}
