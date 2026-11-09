import { effectiveRate, resolveLineRates, type TaxRateLike, type TaxableLine } from "@/lib/money/tax";
import {
  EU_STANDARD_RATES, LEGENDS, addressFromRaw, normalizeCountry,
  type Address, type ContactTaxInfo, type TaxProfile,
} from "./regimes";
import { indiaPlaceOfSupply, type IndiaSupplyKind } from "./place-of-supply";
import { EU_MEMBER_STATES, US_STATES, countryForVatPrefix, validateEuVat, validateGstin, vatPrefixForCountry } from "./validators";

/**
 * Regime resolver (pure, no DB). Takes a document's lines + parties and returns
 * lines re-pointed at synthetic component rates (CGST/SGST/IGST, destination VAT,
 * jurisdiction sales tax) plus compliance metadata. The existing totals engine
 * (src/lib/money/tax.ts) then computes the amounts - this module never rounds money.
 */

export type VatCategory = "S" | "Z" | "E" | "AE" | "K" | "G" | "O";

export interface ComplianceMeta {
  regime: TaxProfile["regime"];
  place_of_supply: string | null;
  reverse_charge: boolean;
  /** India: intra|inter|export|sez. */
  supply_kind: IndiaSupplyKind | "domestic" | "b2b_eu" | "b2c_eu" | "export" | "us" | null;
  /** UBL/EN16931 VAT category code for the document. */
  vat_category: VatCategory | null;
  exempt_reason_code: string | null;
  legends: string[];
  warnings: string[];
  /** True when any rate is a simulated estimate. */
  estimate: boolean;
}

export interface ResolveInput<L extends TaxableLine> {
  profile: TaxProfile;
  items: readonly L[];
  /** Org catalogue (to learn each line's base rate). */
  rates: readonly TaxRateLike[];
  contact?: ContactTaxInfo | null;
  shipTo?: Address | null;
  docDate?: Date;
  reverseCharge?: boolean;
  /** US only */
  exemptions?: ReadonlyArray<{ jurisdiction: string; certificate_ref: string | null; expires_at: string | null }>;
  jurisdictionRates?: ReadonlyArray<TaxRateLike & { jurisdiction: string | null }>;
  providers?: readonly TaxRateProvider[];
}

export interface ResolvedTax<L extends TaxableLine> {
  items: L[];
  /** Catalogue rates + synthetic component rates; pass to computeTotals. */
  rates: TaxRateLike[];
  meta: ComplianceMeta;
}

/* ---- US provider hook ---- */

export interface UsAddress { state: string; postal_code: string | null }
export interface UsRateQuote { rate_bp: number; name: string; jurisdiction: string; source: "manual" | "estimate" | "provider"; estimate: boolean }
/**
 * Pluggable US rate source. A live provider (TaxJar, Avalara, ...) would implement
 * this interface and be passed in `providers`; none is implemented here.
 */
export interface TaxRateProvider {
  id: string;
  lookup(addr: UsAddress): UsRateQuote | null | Promise<UsRateQuote | null>;
}

export function manualRateProvider(rows: ReadonlyArray<TaxRateLike & { jurisdiction: string | null }>): TaxRateProvider {
  return {
    id: "manual",
    lookup(addr) {
      const st = addr.state.toUpperCase();
      const name = (US_STATES[st] ?? "").toLowerCase();
      const hit = rows.find((r) => {
        const j = (r.jurisdiction ?? "").trim().toLowerCase().replace(/^us-/, "");
        return j === st.toLowerCase() || (name && j === name);
      });
      return hit ? { rate_bp: hit.rate_bp, name: hit.name, jurisdiction: st, source: "manual", estimate: false } : null;
    },
  };
}

const NO_SALES_TAX = new Set(["OR", "MT", "NH", "DE", "AK"]);
/** Deterministic, plausible combined rate (4.5% - 9%) from the ZIP3 prefix. FLAGGED ESTIMATE - not a real rate. */
export const simulatedZipProvider: TaxRateProvider = {
  id: "simulated_zip",
  lookup(addr) {
    const st = addr.state.toUpperCase();
    if (NO_SALES_TAX.has(st)) return { rate_bp: 0, name: `${st} sales tax (estimate)`, jurisdiction: st, source: "estimate", estimate: true };
    const zip3 = Number((addr.postal_code ?? "").replace(/\D/g, "").slice(0, 3));
    if (!Number.isFinite(zip3) || (addr.postal_code ?? "").replace(/\D/g, "").length < 3) return null;
    return { rate_bp: 450 + (zip3 % 10) * 50, name: `${st} combined sales tax (estimate)`, jurisdiction: st, source: "estimate", estimate: true };
  },
};

/* ---- helpers ---- */

const round2 = (n: number) => Math.round(n * 100) / 100;

function baseRateBp(line: TaxableLine, rates: readonly TaxRateLike[]): number {
  return round2(effectiveRate(resolveLineRates(line, rates)) * 10_000);
}

function withRates<L extends TaxableLine>(line: L, ids: string[]): L {
  return { ...line, tax_rate_bp: 0, tax_rate_id: null, tax_rate_ids: ids };
}

function emptyMeta(profile: TaxProfile): ComplianceMeta {
  return { regime: profile.regime, place_of_supply: null, reverse_charge: false, supply_kind: null, vat_category: null, exempt_reason_code: null, legends: [], warnings: [], estimate: false };
}

/** Strip all tax from every line (zero-rated / exempt / reverse-charged). */
function zeroAll<L extends TaxableLine>(items: readonly L[], rates: readonly TaxRateLike[], meta: ComplianceMeta): ResolvedTax<L> {
  return { items: items.map((l) => withRates(l, [])), rates: [...rates], meta };
}

function componentRate(id: string, name: string, rate_bp: number): TaxRateLike {
  return { id, name, rate_bp, compound: false, kind: id.startsWith("us:") ? "sales" : id.includes("vat") ? "vat" : "gst" };
}

/* ---- India ---- */

function resolveIndia<L extends TaxableLine>(i: ResolveInput<L>): ResolvedTax<L> {
  const { profile, items, rates } = i;
  const meta = emptyMeta(profile);
  const supplierState = (profile.registration_number && validateGstin(profile.registration_number).valid ? profile.registration_number.slice(0, 2) : null) ?? (profile.state_province && /^\d{2}$/.test(profile.state_province) ? profile.state_province : null);
  if (!supplierState) meta.warnings.push("Supplier state could not be derived: set a valid GSTIN or state code in the tax profile.");

  if (profile.registration_type === "composition") {
    meta.legends.push(LEGENDS.in_composition);
    meta.vat_category = "E";
    return zeroAll(items, rates, meta);
  }
  if (profile.registration_type === "unregistered") {
    meta.legends.push(LEGENDS.in_unregistered);
    meta.vat_category = "E";
    return zeroAll(items, rates, meta);
  }

  const c = i.contact ?? {};
  const addr = addressFromRaw(c.billing_address);
  const buyerCountry = normalizeCountry(c.tax_country) ?? normalizeCountry(addr.country);
  const pos = indiaPlaceOfSupply({
    supplierState,
    buyerGstin: c.tax_number,
    buyerState: c.tax_state ?? addr.state,
    shipToState: i.shipTo?.state ?? null,
    buyerCountry,
    buyerIsSez: c.tax_registration_type === "sez",
    supply: profile.settings.supply_kind ?? "goods",
  });
  meta.place_of_supply = pos.code;
  meta.supply_kind = pos.kind;
  if (pos.warning) meta.warnings.push(pos.warning);
  if (c.tax_registration_type === "b2b" && !(c.tax_number && validateGstin(c.tax_number).valid)) meta.warnings.push("B2B buyer is missing a valid GSTIN.");

  const rc = i.reverseCharge ?? profile.settings.reverse_charge_default ?? false;
  if (rc) {
    meta.reverse_charge = true;
    meta.legends.push(LEGENDS.in_reverse_charge);
    return zeroAll(items, rates, meta);
  }
  const lut = profile.settings.lut_zero_rated === true;
  if ((pos.kind === "export" || pos.kind === "sez") && lut) {
    meta.legends.push(pos.kind === "export" ? LEGENDS.in_export_lut : LEGENDS.in_sez_lut);
    meta.vat_category = "Z";
    return zeroAll(items, rates, meta);
  }

  const synth = new Map<string, TaxRateLike>();
  const out = items.map((line) => {
    const bp = baseRateBp(line, rates);
    if (bp <= 0) return withRates(line, []);
    if (pos.kind === "intra") {
      const half = round2(bp / 2);
      const cg = componentRate(`gst:cgst:${half}`, "CGST", half);
      const sg = componentRate(`gst:sgst:${half}`, "SGST", half);
      synth.set(cg.id, cg);
      synth.set(sg.id, sg);
      return withRates(line, [cg.id, sg.id]);
    }
    const ig = componentRate(`gst:igst:${bp}`, "IGST", bp);
    synth.set(ig.id, ig);
    return withRates(line, [ig.id]);
  });
  meta.vat_category = "S";
  return { items: out, rates: [...rates, ...synth.values()], meta };
}

/* ---- EU / UK ---- */

function resolveVat<L extends TaxableLine>(i: ResolveInput<L>): ResolvedTax<L> {
  const { profile, items, rates } = i;
  const meta = emptyMeta(profile);
  const isUk = profile.regime === "uk_vat";
  const seller = normalizeCountry(profile.country) ?? (isUk ? "GB" : null);
  const c = i.contact ?? {};
  const addr = addressFromRaw(c.billing_address);
  const vatPrefix = (c.tax_number ?? "").trim().toUpperCase().slice(0, 2);
  const fromVat = /^[A-Z]{2}$/.test(vatPrefix) ? countryForVatPrefix(vatPrefix) : null;
  const buyer = normalizeCountry(c.tax_country) ?? normalizeCountry(i.shipTo?.country) ?? normalizeCountry(addr.country) ?? fromVat;
  const supply = profile.settings.supply_kind ?? "services";
  meta.place_of_supply = buyer;
  if (!seller) meta.warnings.push("Seller country is not set in the tax profile.");
  if (!buyer) {
    meta.warnings.push("Customer country unknown: applying catalogue rates (domestic treatment).");
    meta.supply_kind = "domestic";
    meta.vat_category = "S";
    return { items: [...items], rates: [...rates], meta };
  }
  if (buyer === seller) {
    meta.supply_kind = "domestic";
    meta.vat_category = "S";
    return { items: [...items], rates: [...rates], meta };
  }
  const buyerInEu = EU_MEMBER_STATES.includes(vatPrefixForCountry(buyer));
  const vatOk = Boolean(c.tax_number && validateEuVat(c.tax_number).valid);
  const isB2b = c.tax_registration_type === "b2b" || (c.tax_registration_type !== "b2c" && vatOk);
  if (c.tax_registration_type === "exempt") {
    meta.supply_kind = "domestic";
    meta.vat_category = "E";
    meta.warnings.push("Customer is marked exempt: no VAT applied. Keep the exemption evidence.");
    return zeroAll(items, rates, meta);
  }

  if (!isUk && buyerInEu) {
    if (isB2b) {
      if (!vatOk) {
        meta.warnings.push("B2B customer without a valid EU VAT ID: reverse charge NOT applied (charging catalogue rates).");
        meta.vat_category = "S";
        return { items: [...items], rates: [...rates], meta };
      }
      meta.supply_kind = "b2b_eu";
      if (supply === "goods") {
        meta.vat_category = "K";
        meta.exempt_reason_code = "VATEX-EU-IC";
        meta.legends.push(LEGENDS.eu_intra_community);
      } else {
        meta.vat_category = "AE";
        meta.reverse_charge = true;
        meta.exempt_reason_code = "VATEX-EU-AE";
        meta.legends.push(LEGENDS.eu_reverse_charge);
      }
      return zeroAll(items, rates, meta);
    }
    // B2C
    meta.supply_kind = "b2c_eu";
    if (profile.registration_type === "oss") {
      const dest = EU_STANDARD_RATES.rates[vatPrefixForCountry(buyer)];
      if (dest === undefined) {
        meta.warnings.push(`No OSS standard rate on file for ${buyer}.`);
        meta.vat_category = "S";
        return { items: [...items], rates: [...rates], meta };
      }
      const synth = new Map<string, TaxRateLike>();
      const out = items.map((line) => {
        if (baseRateBp(line, rates) <= 0) return withRates(line, []);
        const r = componentRate(`vat:oss:${buyer}:${dest}`, `VAT ${buyer} (OSS)`, dest);
        synth.set(r.id, r);
        return withRates(line, [r.id]);
      });
      meta.vat_category = "S";
      return { items: out, rates: [...rates, ...synth.values()], meta };
    }
    meta.warnings.push("B2C sale to another EU country charged at origin rates (not OSS-registered). Distance-sales thresholds may apply - verify.");
    meta.vat_category = "S";
    return { items: [...items], rates: [...rates], meta };
  }

  // Outside the seller's VAT territory (UK exports, EU exports, UK<->EU after Brexit)
  meta.supply_kind = "export";
  if (supply === "goods") {
    meta.vat_category = "G";
    meta.exempt_reason_code = isUk ? "VATEX-GB-ZR" : "VATEX-EU-G";
    meta.legends.push(isUk ? LEGENDS.uk_export : LEGENDS.eu_export);
  } else {
    meta.vat_category = "O";
    meta.exempt_reason_code = "VATEX-EU-O";
    meta.legends.push(LEGENDS.outside_scope);
  }
  return zeroAll(items, rates, meta);
}

/* ---- US ---- */

async function resolveUs<L extends TaxableLine>(i: ResolveInput<L>): Promise<ResolvedTax<L>> {
  const { profile, items, rates } = i;
  const meta = emptyMeta(profile);
  meta.supply_kind = "us";
  const c = i.contact ?? {};
  const addr = addressFromRaw(c.billing_address);
  const state = (i.shipTo?.state ?? c.tax_state ?? addr.state ?? "").trim().toUpperCase().replace(/^US-/, "");
  const postal = i.shipTo?.postal_code ?? addr.postal_code ?? null;
  if (!US_STATES[state]) {
    meta.warnings.push("Ship-to state unknown: applying catalogue rates.");
    return { items: [...items], rates: [...rates], meta };
  }
  meta.place_of_supply = state;
  const nexus = (profile.settings.nexus_states ?? []).map((s) => s.toUpperCase());
  if (!nexus.includes(state)) {
    meta.legends.push(LEGENDS.us_no_nexus);
    meta.vat_category = "O";
    return zeroAll(items, rates, meta);
  }
  const when = (i.docDate ?? new Date()).getTime();
  const ex = (i.exemptions ?? []).find((e) => (e.jurisdiction.toUpperCase() === state || e.jurisdiction.toUpperCase() === "ALL" || e.jurisdiction.toUpperCase() === "US-" + state) && (!e.expires_at || new Date(e.expires_at).getTime() >= when));
  if (ex || c.tax_registration_type === "exempt") {
    meta.legends.push(LEGENDS.us_exempt + (ex?.certificate_ref ? ` (${ex.certificate_ref})` : ""));
    meta.vat_category = "E";
    if (!ex) meta.warnings.push("Contact is marked exempt but no unexpired certificate is on file.");
    return zeroAll(items, rates, meta);
  }
  const providers: TaxRateProvider[] = [manualRateProvider(i.jurisdictionRates ?? []), ...(i.providers ?? [])];
  if (profile.settings.allow_estimates) providers.push(simulatedZipProvider);
  let quote: UsRateQuote | null = null;
  for (const p of providers) {
    quote = await p.lookup({ state, postal_code: postal });
    if (quote) break;
  }
  if (!quote) {
    meta.warnings.push(`No sales-tax rate found for ${state}: add a jurisdiction rate in Billing, Tax rates. Catalogue rates applied.`);
    return { items: [...items], rates: [...rates], meta };
  }
  meta.estimate = quote.estimate;
  if (quote.estimate) meta.warnings.push(`Sales tax for ${state} is an ESTIMATE (simulated lookup). Replace with a manual jurisdiction rate or a provider.`);
  const r = componentRate(`us:${state}:${quote.rate_bp}`, quote.name, quote.rate_bp);
  const out = items.map((line) => withRates(line, quote!.rate_bp > 0 ? [r.id] : []));
  meta.vat_category = "S";
  return { items: out, rates: quote.rate_bp > 0 ? [...rates, r] : [...rates], meta };
}

/** Entry point. `generic` is a no-op passthrough. */
export async function resolveTax<L extends TaxableLine>(input: ResolveInput<L>): Promise<ResolvedTax<L>> {
  switch (input.profile.regime) {
    case "india_gst": return resolveIndia(input);
    case "eu_vat":
    case "uk_vat": return resolveVat(input);
    case "us_sales": return resolveUs(input);
    default: return { items: [...input.items], rates: [...input.rates], meta: emptyMeta(input.profile) };
  }
}

/* ---- GST helpers for reports ---- */

/** Split a total GST amount into equal CGST/SGST halves; the odd minor unit goes to CGST so CGST + SGST === total. */
export function splitGstTotal(totalMinor: number): { cgst: number; sgst: number } {
  const sgst = Math.floor(totalMinor / 2);
  return { cgst: totalMinor - sgst, sgst };
}
