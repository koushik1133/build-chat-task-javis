import { query } from "@/lib/dsql";
import { tableExists } from "@/lib/table-exists";
import { listFxRates } from "@/lib/money/fx";
import { getBillingSettings } from "@/lib/money/settings";
import { parseItems } from "@/lib/money/items";
import { parseBreakdown } from "@/lib/money/tax";
import { addressFromRaw, normalizeCountry, type Regime, type TaxProfile } from "./regimes";
import { buildRegimeReport, type RDoc, type RInput, type Report } from "./reports";
import { getTaxProfile } from "./store";

/** Loads documents for a period and runs the pure aggregation. */

export const REGIME_CURRENCY: Readonly<Record<string, string>> = { india_gst: "INR", uk_vat: "GBP", eu_vat: "EUR", us_sales: "USD", generic: "USD" };

interface DocRow {
  id: string; number: string; created_at: string | Date; sent_at?: string | Date | null; issued_at?: string | Date | null; currency: string;
  subtotal_minor: string | number; tax_minor: string | number; total_minor: string | number; tax_breakdown: string | null; items: string | null;
  place_of_supply: string | null; reverse_charge: boolean | null;
  c_id: string | null; c_name: string | null; c_tax: string | null; c_type: string | null; c_country: string | null; c_state: string | null; c_addr: string | null;
}

const iso = (v: string | Date | null | undefined): string => (v instanceof Date ? v.toISOString() : v ? String(v) : "");

export async function loadReport(dataId: string, regime: Regime, from: string, to: string, profileIn?: TaxProfile | null): Promise<Report> {
  const profile = profileIn ?? (await getTaxProfile(dataId));
  const settings = await getBillingSettings(dataId);
  const currency = (settings.reporting_currency ?? REGIME_CURRENCY[regime] ?? "USD").toUpperCase();
  const fx = await listFxRates(dataId).catch(() => []);
  const start = `${from}T00:00:00.000Z`;
  const end = `${to}T23:59:59.999Z`;

  const productHsn = new Map<string, string>();
  if (await tableExists("products")) {
    const rows = await query<{ id: string; hsn_sac_code: string | null }>(`SELECT id, hsn_sac_code FROM products WHERE user_id = $1 AND hsn_sac_code IS NOT NULL`, [dataId]).catch(() => []);
    for (const r of rows) if (r.hsn_sac_code) productHsn.set(r.id, r.hsn_sac_code);
  }
  const contactCols = `c.id AS c_id, c.full_name AS c_name, c.tax_number AS c_tax, c.tax_registration_type AS c_type, c.tax_country AS c_country, c.tax_state AS c_state, c.billing_address AS c_addr`;
  const toDoc = (r: DocRow, kind: RDoc["kind"], dateCol: string | Date | null | undefined): RDoc => {
    const addr = addressFromRaw(r.c_addr);
    return {
      id: r.id, number: r.number, kind, date: iso(dateCol) || iso(r.created_at), currency: r.currency,
      subtotal_minor: Number(r.subtotal_minor), tax_minor: Number(r.tax_minor), total_minor: Number(r.total_minor), breakdown: parseBreakdown(r.tax_breakdown),
      items: parseItems(r.items).map((i) => ({ description: i.description, qty: i.qty, net_minor: Math.round(i.qty * i.unit_minor), hsn_sac: i.hsn_sac ?? (i.product_id ? productHsn.get(i.product_id) ?? null : null) })),
      contact: { id: r.c_id, name: r.c_name, tax_number: r.c_tax, type: r.c_type, country: normalizeCountry(r.c_country) ?? normalizeCountry(addr.country), state: r.c_state ?? addr.state ?? null },
      place_of_supply: r.place_of_supply, reverse_charge: Boolean(r.reverse_charge),
    };
  };

  const invRows = await query<DocRow>(
    `SELECT i.id, i.number, i.created_at, i.sent_at, i.currency, i.subtotal_minor, i.tax_minor, i.total_minor, i.tax_breakdown, i.items, i.place_of_supply, i.reverse_charge, ${contactCols}
       FROM invoices i LEFT JOIN crm_contacts c ON c.id = i.contact_id AND c.user_id = i.user_id
      WHERE i.user_id = $1 AND i.status NOT IN ('draft','void') AND COALESCE(i.sent_at, i.created_at) BETWEEN $2 AND $3 ORDER BY COALESCE(i.sent_at, i.created_at) ASC LIMIT 5000`,
    [dataId, start, end]
  );
  const invoices = invRows.map((r) => toDoc(r, "invoice", r.sent_at ?? r.created_at));

  let credits: RDoc[] = [];
  if (await tableExists("credit_notes")) {
    const cnRows = await query<DocRow>(
      `SELECT n.id, n.number, n.created_at, n.issued_at, n.currency, n.subtotal_minor, n.tax_minor, n.total_minor, n.tax_breakdown, n.items,
              inv.place_of_supply AS place_of_supply, inv.reverse_charge AS reverse_charge, ${contactCols}
         FROM credit_notes n LEFT JOIN invoices inv ON inv.id = n.invoice_id LEFT JOIN crm_contacts c ON c.id = n.contact_id AND c.user_id = n.user_id
        WHERE n.user_id = $1 AND n.status IN ('issued','applied','refunded') AND COALESCE(n.issued_at, n.created_at) BETWEEN $2 AND $3 ORDER BY COALESCE(n.issued_at, n.created_at) ASC LIMIT 5000`,
      [dataId, start, end]
    );
    credits = cnRows.map((r) => toDoc(r, "credit_note", r.issued_at ?? r.created_at));
  }

  const inputs: RInput[] = [];
  if (await tableExists("supplier_bills")) {
    const rows = await query<{ id: string; number: string; issued_at: string | Date | null; created_at: string | Date; currency: string; subtotal_minor: string | number; tax_minor: string | number; supplier_name: string | null }>(
      `SELECT b.id, b.number, b.issued_at, b.created_at, b.currency, b.subtotal_minor, b.tax_minor, b.supplier_ref AS supplier_name
         FROM supplier_bills b WHERE b.user_id = $1 AND b.status NOT IN ('draft','void') AND COALESCE(b.issued_at, b.created_at) BETWEEN $2 AND $3 LIMIT 5000`,
      [dataId, start, end]
    );
    for (const r of rows) inputs.push({ id: r.id, number: r.number, source: "bill", date: iso(r.issued_at ?? r.created_at), currency: r.currency, net_minor: Number(r.subtotal_minor), tax_minor: Number(r.tax_minor), supplier: r.supplier_name });
  }
  if (await tableExists("expenses")) {
    const rows = await query<{ id: string; vendor: string | null; description: string | null; spent_at: string | Date; currency: string; amount_minor: string | number; tax_minor: string | number }>(
      `SELECT id, vendor, description, spent_at, currency, amount_minor, tax_minor FROM expenses WHERE user_id = $1 AND tax_minor > 0 AND spent_at BETWEEN $2 AND $3 LIMIT 5000`,
      [dataId, start, end]
    );
    for (const r of rows) inputs.push({ id: r.id, number: (r.description ?? "expense").slice(0, 30), source: "expense", date: iso(r.spent_at), currency: r.currency, net_minor: Number(r.amount_minor) - Number(r.tax_minor), tax_minor: Number(r.tax_minor), supplier: r.vendor });
  }

  return buildRegimeReport(invoices, credits, inputs, {
    regime, from, to, currency, fx, sellerCountry: normalizeCountry(profile?.country) ?? (regime === "uk_vat" ? "GB" : null),
    nexusStates: profile?.settings.nexus_states?.map((s) => s.toUpperCase()),
  });
}
