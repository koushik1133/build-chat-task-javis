/**
 * Tax regimes as DATA (pure, client-safe).
 *
 * Tax rules change. Everything here carries an `effective_from` date and a
 * source note, rates in org-editable `tax_rates` rows stay the source of truth
 * for ordinary rates, and nothing in this module is legal advice. See
 * docs/TAX-COMPLIANCE.md for the "needs verification" list.
 */

export const REGIMES = ["india_gst", "eu_vat", "uk_vat", "us_sales", "generic"] as const;
export type Regime = (typeof REGIMES)[number];
export const REGISTRATION_TYPES = ["regular", "composition", "unregistered", "oss"] as const;
export type RegistrationType = (typeof REGISTRATION_TYPES)[number];
export const FILING_FREQUENCIES = ["monthly", "quarterly", "annual"] as const;
export type FilingFrequency = (typeof FILING_FREQUENCIES)[number];
export const CONTACT_TAX_TYPES = ["b2b", "b2c", "exempt"] as const;
export type ContactTaxType = (typeof CONTACT_TAX_TYPES)[number];

export interface RegimeInfo {
  key: Regime;
  label: string;
  /** ISO date the encoded rules were last reviewed against the source. */
  effective_from: string;
  source: string;
  tax_id_label: string;
  e_invoice_formats: readonly string[];
  /** Notice shown in the UI. */
  notice: string;
}

export const VERIFY_NOTICE = "Tax rules change and depend on your circumstances. KernelHub helps you prepare documents and reports but does not give tax or legal advice - verify with your accountant before filing.";

export const REGIME_INFO: Readonly<Record<Regime, RegimeInfo>> = {
  india_gst: {
    key: "india_gst", label: "India GST", effective_from: "2025-04-01",
    source: "CGST Act 2017 / IGST Act 2017 (place of supply s.10-13 IGST), GST e-invoice schema v1.1 (NIC/IRP)",
    tax_id_label: "GSTIN", e_invoice_formats: ["in_irp_json"], notice: VERIFY_NOTICE,
  },
  eu_vat: {
    key: "eu_vat", label: "EU VAT", effective_from: "2025-01-01",
    source: "Council Directive 2006/112/EC (art. 44, 138, 146, 196), OSS scheme (Directive (EU) 2017/2455), EN 16931",
    tax_id_label: "VAT ID", e_invoice_formats: ["ubl_peppol"], notice: VERIFY_NOTICE,
  },
  uk_vat: {
    key: "uk_vat", label: "UK VAT", effective_from: "2025-01-01",
    source: "VAT Act 1994, HMRC Notice 700, Making Tax Digital 9-box return",
    tax_id_label: "VAT number", e_invoice_formats: ["ubl_peppol"], notice: VERIFY_NOTICE,
  },
  us_sales: {
    key: "us_sales", label: "US sales tax", effective_from: "2025-01-01",
    source: "State statutes; economic nexus per South Dakota v. Wayfair (2018). Rates are NOT hard-coded: manual jurisdiction rows or a provider.",
    tax_id_label: "Seller permit", e_invoice_formats: [], notice: VERIFY_NOTICE,
  },
  generic: {
    key: "generic", label: "Generic", effective_from: "2025-01-01",
    source: "No regime rules applied; catalogue rates only.", tax_id_label: "Tax ID", e_invoice_formats: [], notice: VERIFY_NOTICE,
  },
};

export function isRegime(v: unknown): v is Regime {
  return typeof v === "string" && (REGIMES as readonly string[]).includes(v);
}

/**
 * EU standard VAT rates in basis points by VAT prefix (EL = Greece).
 * Used only for B2C OSS destination-country pricing. Reduced rates are NOT
 * encoded: add them as org tax_rates rows. Source: European Commission "VAT rates"
 * publication, reviewed for effective_from; verify before relying on them.
 */
export const EU_STANDARD_RATES: Readonly<{ effective_from: string; source: string; rates: Readonly<Record<string, number>> }> = {
  effective_from: "2025-01-01",
  source: "European Commission, VAT rates applied in the Member States (standard rates)",
  rates: {
    AT: 2000, BE: 2100, BG: 2000, CY: 1900, CZ: 2100, DE: 1900, DK: 2500, EE: 2400, EL: 2400, ES: 2100,
    FI: 2550, FR: 2000, HR: 2500, HU: 2700, IE: 2300, IT: 2200, LT: 2100, LU: 1700, LV: 2100, MT: 1800,
    NL: 2100, PL: 2300, PT: 2300, RO: 2100, SE: 2500, SI: 2200, SK: 2300,
  },
};

/** Valid GST slab rates (percent, basis points) - informational, used to warn on odd rates. */
export const INDIA_GST_SLABS_BP: readonly number[] = [0, 25, 300, 500, 1200, 1800, 2800];

export interface ProfileSettings {
  /** India: HSN digits required on invoices (4 under INR 5cr turnover, 6 above - verify). */
  hsn_digits?: 4 | 6 | 8;
  /** India: treat supplies as goods (place of supply = delivery) or services. */
  supply_kind?: "goods" | "services";
  /** India: zero-rate exports/SEZ under LUT instead of charging IGST. */
  lut_zero_rated?: boolean;
  /** India/EU: default reverse-charge flag for outward invoices. */
  reverse_charge_default?: boolean;
  /** US: states where the org has nexus / is registered. */
  nexus_states?: string[];
  /** US: allow simulated ZIP-prefix estimates when no manual rate matches. */
  allow_estimates?: boolean;
  /** Pre-fill: IRP seller legal name/address for e-invoices. */
  legal_name?: string;
  address_line1?: string;
  city?: string;
  postal_code?: string;
}

export interface TaxProfile {
  user_id: string;
  regime: Regime;
  country: string | null;
  state_province: string | null;
  registration_number: string | null;
  registration_type: RegistrationType;
  filing_frequency: FilingFrequency;
  e_invoicing_enabled: boolean;
  settings: ProfileSettings;
  updated_at: string;
}

export function parseProfileSettings(raw: string | null | undefined): ProfileSettings {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as ProfileSettings) : {};
  } catch {
    return {};
  }
}

export interface ContactTaxInfo {
  id?: string | null;
  tax_number?: string | null;
  tax_country?: string | null;
  tax_state?: string | null;
  tax_registration_type?: ContactTaxType | string | null;
  billing_address?: string | null;
}

export interface Address {
  country?: string | null;
  state?: string | null;
  postal_code?: string | null;
}

/** Pull country/state/postcode out of a stored billing/ship-to address (JSON object or free text -> nothing). */
export function addressFromRaw(raw: string | null | undefined): Address {
  if (!raw) return {};
  const t = raw.trim();
  if (!t.startsWith("{")) return {};
  try {
    const o = JSON.parse(t) as Record<string, unknown>;
    const s = (k: string) => (typeof o[k] === "string" && (o[k] as string).trim() ? (o[k] as string).trim() : null);
    return { country: s("country"), state: s("region") ?? s("state"), postal_code: s("postal_code") ?? s("postcode") ?? s("zip") };
  } catch {
    return {};
  }
}

/** Lower the ISO country: accepts "IN", "India" (a few names), "United Kingdom". */
const COUNTRY_NAMES: Readonly<Record<string, string>> = { INDIA: "IN", "UNITED KINGDOM": "GB", UK: "GB", "UNITED STATES": "US", USA: "US", GERMANY: "DE", FRANCE: "FR", SPAIN: "ES", ITALY: "IT", NETHERLANDS: "NL", IRELAND: "IE", GREECE: "GR" };
export function normalizeCountry(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim().toUpperCase();
  if (!v) return null;
  if (/^[A-Z]{2}$/.test(v)) return v === "EL" ? "GR" : v === "UK" ? "GB" : v;
  return COUNTRY_NAMES[v] ?? null;
}

/** Statutory invoice text snippets (verify wording locally). */
export const LEGENDS = {
  eu_reverse_charge: "Reverse charge: VAT to be accounted for by the recipient (Article 196, Directive 2006/112/EC).",
  eu_intra_community: "Intra-Community supply: VAT exempt under Article 138, Directive 2006/112/EC.",
  eu_export: "Export: VAT exempt under Article 146, Directive 2006/112/EC.",
  outside_scope: "Outside the scope of VAT (place of supply is outside the taxing country).",
  uk_export: "Zero-rated export of goods from the UK.",
  in_reverse_charge: "Tax payable on reverse charge: Yes",
  in_composition: "Composition taxable person, not eligible to collect tax on supplies.",
  in_unregistered: "Bill of supply - supplier is not registered under GST.",
  in_export_lut: "Supply meant for export under LUT without payment of IGST.",
  in_sez_lut: "Supply to SEZ under LUT without payment of IGST.",
  us_exempt: "Exempt sale - exemption certificate on file.",
  us_no_nexus: "No sales tax charged: seller has no nexus in the destination state.",
} as const;
