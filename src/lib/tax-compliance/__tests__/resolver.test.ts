import { describe, expect, it } from "vitest";
import { computeTotals, type TaxRateLike } from "@/lib/money/tax";
import { resolveTax, splitGstTotal, manualRateProvider, simulatedZipProvider, type ResolveInput } from "../resolver";
import { indiaPlaceOfSupply } from "../place-of-supply";
import { EU_STANDARD_RATES, type TaxProfile } from "../regimes";

const GST18: TaxRateLike = { id: "g18", name: "GST", rate_bp: 1800, kind: "gst" };
const GST5: TaxRateLike = { id: "g5", name: "GST", rate_bp: 500, kind: "gst" };
const VAT20: TaxRateLike = { id: "v20", name: "VAT", rate_bp: 2000, kind: "vat" };
const SALES: TaxRateLike & { jurisdiction: string | null } = { id: "ca", name: "CA sales tax", rate_bp: 725, kind: "sales", jurisdiction: "CA" };

const profile = (over: Partial<TaxProfile>): TaxProfile => ({
  user_id: "u", regime: "india_gst", country: "IN", state_province: null, registration_number: "27AAPFU0939F1ZV", registration_type: "regular",
  filing_frequency: "monthly", e_invoicing_enabled: false, settings: {}, updated_at: "", ...over,
});

const line = (unit: number, id = "g18", qty = 1) => ({ qty, unit_minor: unit, tax_rate_id: id });
const run = async <L extends { qty: number; unit_minor: number }>(i: ResolveInput<L & { tax_rate_id: string }>, inclusive = false) => {
  const r = await resolveTax(i);
  return { r, totals: computeTotals(r.items, r.rates, { inclusive }) };
};

describe("India GST", () => {
  const base = { profile: profile({}), rates: [GST18, GST5], items: [line(100_000)] };

  it("intra-state splits CGST/SGST half each (supplier MH=27, buyer MH)", async () => {
    const { r, totals } = await run({ ...base, contact: { tax_number: "27AAPFU0939F1ZV", tax_registration_type: "b2b" } });
    expect(r.meta.supply_kind).toBe("intra");
    expect(r.meta.place_of_supply).toBe("27");
    expect(totals.breakdown.map((b) => [b.name, b.rate_bp, b.tax_minor])).toEqual([["CGST", 900, 9000], ["SGST", 900, 9000]]);
    expect(totals.tax_minor).toBe(18_000);
  });

  it("inter-state charges IGST (buyer KA=29)", async () => {
    const { r, totals } = await run({ ...base, contact: { tax_number: "29AABCT1332L1ZA", tax_registration_type: "b2b" } });
    expect(r.meta.supply_kind).toBe("inter");
    expect(totals.breakdown.map((b) => [b.name, b.tax_minor])).toEqual([["IGST", 18_000]]);
  });

  it("CGST + SGST equals the rounded total GST within one minor unit on odd amounts", async () => {
    for (const unit of [101, 999, 1_234_567, 3333]) {
      const { totals } = await run({ ...base, items: [line(unit, "g5")], contact: { tax_number: "27AAPFU0939F1ZV" } });
      const sum = totals.breakdown.reduce((s, b) => s + b.tax_minor, 0);
      expect(sum).toBe(totals.tax_minor);
      const [c, s] = totals.breakdown;
      expect(Math.abs((c?.tax_minor ?? 0) - (s?.tax_minor ?? 0))).toBeLessThanOrEqual(0);
      expect(Math.abs(totals.tax_minor - Math.round(unit * 0.05))).toBeLessThanOrEqual(1);
    }
  });

  it("splitGstTotal always sums back exactly", () => {
    for (const n of [0, 1, 2, 3, 9999, 10001]) {
      const { cgst, sgst } = splitGstTotal(n);
      expect(cgst + sgst).toBe(n);
      expect(cgst - sgst).toBeLessThanOrEqual(1);
    }
  });

  it("inclusive prices back the net out with the combined rate", async () => {
    const { totals } = await run({ ...base, items: [line(118_000)], contact: { tax_number: "27AAPFU0939F1ZV" } }, true);
    expect(totals.subtotal_minor).toBe(100_000);
    expect(totals.tax_minor).toBe(18_000);
  });

  it("export: IGST unless LUT; zero-rated with LUT", async () => {
    const c = { tax_country: "US", tax_registration_type: "b2b" };
    const a = await run({ ...base, contact: c });
    expect(a.r.meta.supply_kind).toBe("export");
    expect(a.r.meta.place_of_supply).toBe("96");
    expect(a.totals.breakdown[0]?.name).toBe("IGST");
    const b = await run({ ...base, profile: profile({ settings: { lut_zero_rated: true } }), contact: c });
    expect(b.totals.tax_minor).toBe(0);
    expect(b.r.meta.legends[0]).toMatch(/LUT/);
  });

  it("composition and unregistered suppliers charge no tax and print the statutory legend", async () => {
    const comp = await run({ ...base, profile: profile({ registration_type: "composition" }) });
    expect(comp.totals.tax_minor).toBe(0);
    expect(comp.r.meta.legends[0]).toMatch(/Composition/);
    const unreg = await run({ ...base, profile: profile({ registration_type: "unregistered" }) });
    expect(unreg.r.meta.legends[0]).toMatch(/Bill of supply/);
  });

  it("reverse charge flag zero-rates the invoice and sets the legend", async () => {
    const { r, totals } = await run({ ...base, reverseCharge: true, contact: { tax_number: "27AAPFU0939F1ZV" } });
    expect(r.meta.reverse_charge).toBe(true);
    expect(totals.tax_minor).toBe(0);
  });

  it("unknown place of supply falls back to intra-state with a warning; nil-rated lines stay untaxed", async () => {
    const { r, totals } = await run({ ...base, items: [line(1000, "g18"), { qty: 1, unit_minor: 500, tax_rate_id: "none" }] });
    expect(r.meta.warnings.join(" ")).toMatch(/Place of supply/);
    expect(totals.breakdown.map((b) => b.name)).toEqual(["CGST", "SGST"]);
    expect(totals.tax_minor).toBe(180);
  });

  it("place of supply: goods follow ship-to, services follow recipient", () => {
    expect(indiaPlaceOfSupply({ supplierState: "27", buyerState: "Karnataka", shipToState: "Gujarat", supply: "goods" }).code).toBe("24");
    expect(indiaPlaceOfSupply({ supplierState: "27", buyerState: "Karnataka", shipToState: "Gujarat", supply: "services" }).code).toBe("29");
    expect(indiaPlaceOfSupply({ supplierState: "27", buyerGstin: "29AABCT1332L1ZA", supply: "services", buyerIsSez: true }).kind).toBe("sez");
  });
});

describe("EU / UK VAT", () => {
  const eu = profile({ regime: "eu_vat", country: "DE", registration_number: "DE123456789", registration_type: "regular" });
  const items = [{ qty: 1, unit_minor: 100_000, tax_rate_id: "v20" }];

  it("domestic sale keeps catalogue rates", async () => {
    const { totals } = await run({ profile: eu, rates: [VAT20], items, contact: { tax_country: "DE", tax_registration_type: "b2c" } });
    expect(totals.tax_minor).toBe(20_000);
  });

  it("B2B intra-EU services with a valid VAT ID: reverse charge, 0% and legend", async () => {
    const { r, totals } = await run({ profile: eu, rates: [VAT20], items, contact: { tax_number: "FR12345678901", tax_registration_type: "b2b" } });
    expect(totals.tax_minor).toBe(0);
    expect(r.meta).toMatchObject({ reverse_charge: true, vat_category: "AE", exempt_reason_code: "VATEX-EU-AE", place_of_supply: "FR" });
    expect(r.meta.legends[0]).toMatch(/Reverse charge/);
  });

  it("B2B goods are an intra-Community supply (category K), not reverse charge", async () => {
    const { r } = await run({ profile: { ...eu, settings: { supply_kind: "goods" } }, rates: [VAT20], items, contact: { tax_number: "FR12345678901", tax_registration_type: "b2b" } });
    expect(r.meta).toMatchObject({ reverse_charge: false, vat_category: "K" });
  });

  it("B2B with an INVALID VAT ID is NOT reverse charged", async () => {
    const { r, totals } = await run({ profile: eu, rates: [VAT20], items, contact: { tax_number: "FR1", tax_country: "FR", tax_registration_type: "b2b" } });
    expect(totals.tax_minor).toBe(20_000);
    expect(r.meta.warnings.join(" ")).toMatch(/valid EU VAT ID/);
  });

  it("B2C OSS uses the destination standard rate", async () => {
    const oss = profile({ regime: "eu_vat", country: "DE", registration_number: "DE123456789", registration_type: "oss" });
    const { totals } = await run({ profile: oss, rates: [VAT20], items, contact: { tax_country: "FR", tax_registration_type: "b2c" } });
    expect(totals.breakdown[0]).toMatchObject({ rate_bp: EU_STANDARD_RATES.rates.FR, tax_minor: 20_000 });
    const hu = await run({ profile: oss, rates: [VAT20], items, contact: { tax_country: "HU" } });
    expect(hu.totals.tax_minor).toBe(27_000);
    const gr = await run({ profile: oss, rates: [VAT20], items, contact: { tax_country: "GR" } });
    expect(gr.totals.tax_minor).toBe(24_000);
  });

  it("export outside the EU is zero-rated / outside scope", async () => {
    const { r, totals } = await run({ profile: { ...eu, settings: { supply_kind: "goods" } }, rates: [VAT20], items, contact: { tax_country: "US" } });
    expect(totals.tax_minor).toBe(0);
    expect(r.meta.vat_category).toBe("G");
  });

  it("UK: domestic charged, export zero-rated", async () => {
    const uk = profile({ regime: "uk_vat", country: "GB", registration_number: "GB980780684" });
    expect((await run({ profile: uk, rates: [VAT20], items, contact: { tax_country: "GB" } })).totals.tax_minor).toBe(20_000);
    const ex = await run({ profile: { ...uk, settings: { supply_kind: "goods" } }, rates: [VAT20], items, contact: { tax_country: "FR", tax_number: "FR12345678901" } });
    expect(ex.totals.tax_minor).toBe(0);
    expect(ex.r.meta.legends[0]).toMatch(/Zero-rated/);
  });
});

describe("US sales tax", () => {
  const us = profile({ regime: "us_sales", country: "US", registration_number: null, settings: { nexus_states: ["CA", "NY"] } });
  const items = [{ qty: 2, unit_minor: 10_000, tax_rate_id: "none" }];

  it("charges a manual jurisdiction rate only where there is nexus", async () => {
    const inCa = await run({ profile: us, rates: [], items, shipTo: { state: "CA" }, jurisdictionRates: [SALES] });
    expect(inCa.totals.tax_minor).toBe(1450);
    const inTx = await run({ profile: us, rates: [], items, shipTo: { state: "TX" }, jurisdictionRates: [SALES] });
    expect(inTx.totals.tax_minor).toBe(0);
    expect(inTx.r.meta.legends[0]).toMatch(/no nexus/i);
  });

  it("the seller's home state is always nexus, even with an empty nexus list", async () => {
    const home = { ...us, state_province: "CA", settings: {} };
    const inCa = await run({ profile: home, rates: [], items, shipTo: { state: "CA" }, jurisdictionRates: [SALES] });
    expect(inCa.totals.tax_minor).toBe(1450);
    const inTx = await run({ profile: home, rates: [], items, shipTo: { state: "TX" }, jurisdictionRates: [SALES] });
    expect(inTx.totals.tax_minor).toBe(0);
  });

  it("exemption certificates zero the tax until they expire", async () => {
    const ex = [{ jurisdiction: "CA", certificate_ref: "CERT-1", expires_at: "2030-01-01T00:00:00Z" }];
    const a = await run({ profile: us, rates: [], items, shipTo: { state: "CA" }, jurisdictionRates: [SALES], exemptions: ex, docDate: new Date("2026-06-01") });
    expect(a.totals.tax_minor).toBe(0);
    expect(a.r.meta.legends[0]).toContain("CERT-1");
    const b = await run({ profile: us, rates: [], items, shipTo: { state: "CA" }, jurisdictionRates: [SALES], exemptions: ex, docDate: new Date("2031-06-01") });
    expect(b.totals.tax_minor).toBe(1450);
  });

  it("estimates are opt-in and flagged", async () => {
    const off = await run({ profile: us, rates: [], items, shipTo: { state: "NY", postal_code: "10001" } });
    expect(off.totals.tax_minor).toBe(0);
    expect(off.r.meta.warnings.join(" ")).toMatch(/No sales-tax rate/);
    const on = await run({ profile: { ...us, settings: { ...us.settings, allow_estimates: true } }, rates: [], items, shipTo: { state: "NY", postal_code: "10001" } });
    expect(on.r.meta.estimate).toBe(true);
    expect(on.totals.tax_minor).toBeGreaterThan(0);
  });

  it("providers: manual matches state code or name; simulated is deterministic; custom providers plug in", async () => {
    expect(manualRateProvider([{ ...SALES, jurisdiction: "California" }]).lookup({ state: "CA", postal_code: null })).toMatchObject({ rate_bp: 725, source: "manual" });
    const a = simulatedZipProvider.lookup({ state: "TX", postal_code: "75001" });
    expect(a).toEqual(simulatedZipProvider.lookup({ state: "TX", postal_code: "75001" }));
    expect(simulatedZipProvider.lookup({ state: "OR", postal_code: "97001" })).toMatchObject({ rate_bp: 0 });
    const custom = { id: "x", lookup: () => ({ rate_bp: 1000, name: "X", jurisdiction: "CA", source: "provider" as const, estimate: false }) };
    const r = await run({ profile: us, rates: [], items, shipTo: { state: "CA" }, providers: [custom] });
    expect(r.totals.tax_minor).toBe(2000);
  });
});

describe("generic regime", () => {
  it("is a passthrough", async () => {
    const items = [{ qty: 1, unit_minor: 1000, tax_rate_id: "v20" }];
    const { r, totals } = await run({ profile: profile({ regime: "generic" }), rates: [VAT20], items });
    expect(r.items).toEqual(items);
    expect(totals.tax_minor).toBe(200);
  });
});
