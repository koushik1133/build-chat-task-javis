import { describe, expect, it, vi } from "vitest";
import { buildGstr1, buildGstr3b, buildRegimeReport, buildUsSales, buildVatReturn, reportToCsv, type RDoc, type RInput, type ReportParams } from "../reports";
import { lastClosedPeriod, reminderDue } from "../reminders";
import { computeTotals } from "@/lib/money/tax";

const P: ReportParams = { regime: "india_gst", from: "2026-04-01", to: "2026-04-30", currency: "INR", fx: [] };

function doc(over: Partial<RDoc> & { number: string }): RDoc {
  return {
    id: over.number, kind: "invoice", date: "2026-04-10T10:00:00Z", currency: "INR", subtotal_minor: 100_000, tax_minor: 18_000, total_minor: 118_000,
    breakdown: [{ rate_id: null, name: "IGST", rate_bp: 1800, compound: false, taxable_minor: 100_000, tax_minor: 18_000 }],
    items: [{ description: "Bolts", hsn_sac: "7318", qty: 1, net_minor: 100_000 }],
    contact: { id: "c1", name: "Bharat Retail", tax_number: "29AABCT1332L1ZA", type: "b2b", country: "IN", state: "29" },
    place_of_supply: "29", reverse_charge: false, ...over,
  };
}
const intra = (n: string, over: Partial<RDoc> = {}) => doc({
  number: n, place_of_supply: "27",
  breakdown: [
    { rate_id: null, name: "CGST", rate_bp: 900, compound: false, taxable_minor: 100_000, tax_minor: 9000 },
    { rate_id: null, name: "SGST", rate_bp: 900, compound: false, taxable_minor: 100_000, tax_minor: 9000 },
  ], ...over,
});

describe("GSTR-1 style", () => {
  it("splits B2B vs B2C, nets credit notes negative, summarises HSN", () => {
    const invoices = [
      doc({ number: "I1" }),
      intra("I2", { contact: { id: "c2", name: "Walk-in", tax_number: null, type: "b2c", country: "IN", state: "27" } }),
      doc({ number: "I3", total_minor: 40_000_000, subtotal_minor: 33_898_305, tax_minor: 6_101_695, contact: { id: "c3", name: "Big B2C", tax_number: null, type: "b2c", country: "IN", state: "29" },
        breakdown: [{ rate_id: null, name: "IGST", rate_bp: 1800, compound: false, taxable_minor: 33_898_305, tax_minor: 6_101_695 }] }),
      doc({ number: "I4", place_of_supply: "96", contact: { id: "c4", name: "US Co", tax_number: null, type: "b2b", country: "US", state: null }, tax_minor: 0, total_minor: 100_000, breakdown: [] }),
    ];
    const credits = [doc({ number: "CN1", kind: "credit_note", subtotal_minor: 50_000, tax_minor: 9000, total_minor: 59_000,
      breakdown: [{ rate_id: null, name: "IGST", rate_bp: 1800, compound: false, taxable_minor: 50_000, tax_minor: 9000 }], items: [{ description: "Bolts", hsn_sac: "7318", qty: 1, net_minor: 50_000 }] })];
    const r = buildGstr1(invoices, credits, P);
    const sec = (k: string) => r.sections.find((s) => s.key === k)!;
    expect(sec("b2b").rows).toHaveLength(1);
    expect(sec("b2b").rows[0].slice(0, 3)).toEqual(["29AABCT1332L1ZA", "Bharat Retail", "I1"]);
    expect(sec("b2cl").rows).toHaveLength(1); // inter-state B2C above the threshold
    expect(sec("b2cs").rows).toHaveLength(1); // small intra-state B2C
    expect(sec("exp").rows).toHaveLength(1);
    expect(sec("cdn").rows[0][5]).toBe(-59_000);
    // IGST: I1 18000 + I3 6101695 - CN 9000
    expect(r.totals.igst).toBe(18_000 + 6_101_695 - 9000);
    expect(r.totals.cgst).toBe(9000);
    expect(r.totals.sgst).toBe(9000);
    const hsn = sec("hsn").rows.find((x) => x[0] === "7318" && x[1] === 18);
    expect(hsn).toBeTruthy();
  });

  it("warns on B2B without GSTIN and lines without HSN", () => {
    const r = buildGstr1([doc({ number: "I9", contact: { id: "c", name: "NoId", tax_number: null, type: "b2b", country: "IN", state: "29" }, items: [{ description: "Thing", hsn_sac: null, qty: 1, net_minor: 100_000 }] })], [], P);
    expect(r.warnings.join("|")).toMatch(/I9: B2B customer NoId has no valid GSTIN/);
    expect(r.warnings.join("|")).toMatch(/I9: line "Thing" has no HSN\/SAC/);
  });

  it("ignores documents outside the period", () => {
    const r = buildGstr1([doc({ number: "OLD", date: "2026-03-31T10:00:00Z" })], [], P);
    expect(r.totals.invoices).toBe(0);
  });
});

describe("GSTR-3B style", () => {
  it("outward liability less ITC from bills and expenses", () => {
    const inputs: RInput[] = [
      { id: "b1", number: "BILL-1", source: "bill", date: "2026-04-12T00:00:00Z", currency: "INR", net_minor: 50_000, tax_minor: 9000, supplier: "S" },
      { id: "e1", number: "taxi", source: "expense", date: "2026-04-15T00:00:00Z", currency: "INR", net_minor: 1000, tax_minor: 50, supplier: null },
      { id: "b2", number: "BILL-OLD", source: "bill", date: "2026-03-12T00:00:00Z", currency: "INR", net_minor: 99, tax_minor: 99, supplier: null },
    ];
    const r = buildGstr3b([doc({ number: "I1" })], [], inputs, P);
    expect(r.totals.outward_tax).toBe(18_000);
    expect(r.totals.itc).toBe(9050);
    expect(r.totals.net_payable).toBe(8950);
    expect(r.warnings.join(" ")).toMatch(/ITC is not split/);
  });

  it("credit notes reduce liability; reverse-charge invoices are excluded", () => {
    const r = buildGstr3b([doc({ number: "I1" }), doc({ number: "RC", reverse_charge: true })], [doc({ number: "CN", kind: "credit_note", subtotal_minor: 100_000, tax_minor: 18_000, total_minor: 118_000 })], [], P);
    expect(r.totals.outward_tax).toBe(0);
  });
});

describe("determinism and currency", () => {
  it("report_hash is deterministic and sensitive to content", () => {
    const a = buildRegimeReport([doc({ number: "I1" })], [], [], P);
    const b = buildRegimeReport([doc({ number: "I1" })], [], [], P);
    const c = buildRegimeReport([doc({ number: "I1", total_minor: 1 })], [], [], P);
    expect(a.report_hash).toBe(b.report_hash);
    expect(a.report_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(c.report_hash).not.toBe(a.report_hash);
    const d = buildRegimeReport([doc({ number: "I1", subtotal_minor: 50_000, breakdown: [{ rate_id: null, name: "IGST", rate_bp: 1800, compound: false, taxable_minor: 50_000, tax_minor: 9000 }] })], [], [], P);
    expect(d.report_hash).not.toBe(a.report_hash);
  });

  it("converts other currencies with the stored rate and notes it; missing rate warns", () => {
    const usd = doc({ number: "U1", currency: "USD", subtotal_minor: 1000, tax_minor: 180, total_minor: 1180, breakdown: [{ rate_id: null, name: "IGST", rate_bp: 1800, compound: false, taxable_minor: 1000, tax_minor: 180 }] });
    const withFx = buildGstr1([usd], [], { ...P, fx: [{ base: "USD", quote: "INR", rate: "80", as_of: "2026-04-01" }] });
    expect(withFx.totals.taxable).toBe(80_000);
    expect(withFx.fx_notes[0]).toMatch(/USD -> INR at 80/);
    expect(withFx.warnings.join(" ")).toMatch(/more than one currency/);
    const noFx = buildGstr1([usd], [], P);
    expect(noFx.warnings.join(" ")).toMatch(/No FX rate for USD/);
    expect(noFx.totals.taxable).toBe(0);
  });

  it("CSV escapes quotes and neutralises formulas", () => {
    const r = buildGstr1([doc({ number: "=1+1", contact: { id: "c", name: 'A "B", C', tax_number: "29AABCT1332L1ZA", type: "b2b", country: "IN", state: "29" } })], [], P);
    const csv = reportToCsv(r);
    expect(csv).toContain('"A ""B"", C"');
    expect(csv).toContain("'=1+1");
    expect(csv).toContain("1000.00");
  });
});

describe("EU / UK / US reports", () => {
  const eu: ReportParams = { regime: "eu_vat", from: "2026-04-01", to: "2026-04-30", currency: "EUR", fx: [], sellerCountry: "DE" };
  const vdoc = (n: string, over: Partial<RDoc>): RDoc => doc({ number: n, currency: "EUR", place_of_supply: "FR", breakdown: [], tax_minor: 0, total_minor: 100_000, contact: { id: "c", name: "FR Co", tax_number: "FR12345678901", type: "b2b", country: "FR", state: null }, ...over });

  it("EC sales list groups reverse-charge supplies by customer VAT ID; OSS by country", () => {
    const r = buildVatReturn([
      vdoc("A", { reverse_charge: true }), vdoc("B", { reverse_charge: true }),
      vdoc("C", { reverse_charge: false }),
      vdoc("D", { contact: { id: "x", name: "B2C", tax_number: null, type: "b2c", country: "FR", state: null }, tax_minor: 20_000, total_minor: 120_000,
        breakdown: [{ rate_id: null, name: "VAT FR (OSS)", rate_bp: 2000, compound: false, taxable_minor: 100_000, tax_minor: 20_000 }] }),
    ], [], [{ id: "b", number: "B1", source: "bill", date: "2026-04-02T00:00:00Z", currency: "EUR", net_minor: 10_000, tax_minor: 1900, supplier: null }], eu);
    const ecl = r.sections.find((s) => s.key === "ecl")!;
    expect(ecl.rows).toEqual([["FR12345678901", "FR", 100_000, 200_000]]);
    const oss = r.sections.find((s) => s.key === "oss")!;
    expect(oss.rows).toEqual([["FR", 20, 100_000, 20_000]]);
    expect(r.totals.vat_due).toBe(20_000);
    expect(r.totals.vat_reclaimed).toBe(1900);
    expect(r.totals.net_vat).toBe(18_100);
    expect(r.totals.eu_b2b_net).toBe(300_000);
  });

  it("UK return has 9 boxes and no EC list", () => {
    const r = buildVatReturn([vdoc("A", { currency: "GBP", place_of_supply: "GB", contact: { id: "c", name: "UK", tax_number: null, type: "b2c", country: "GB", state: null }, tax_minor: 20_000, total_minor: 120_000, breakdown: [{ rate_id: null, name: "VAT", rate_bp: 2000, compound: false, taxable_minor: 100_000, tax_minor: 20_000 }] })], [], [], { ...eu, regime: "uk_vat", sellerCountry: "GB", currency: "GBP" });
    expect(r.sections).toHaveLength(1);
    expect(r.sections[0].rows).toHaveLength(9);
    expect(r.totals.vat_due).toBe(20_000);
  });

  it("US report groups by state, flags tax in non-nexus states", () => {
    const mk = (n: string, st: string, tax: number) => doc({ number: n, currency: "USD", place_of_supply: st, subtotal_minor: 10_000, tax_minor: tax, total_minor: 10_000 + tax, breakdown: [] });
    const r = buildUsSales([mk("1", "CA", 725), mk("2", "CA", 0), mk("3", "TX", 500)], [mk("4", "CA", 0)], { ...P, regime: "us_sales", currency: "USD", nexusStates: ["CA"] });
    const ca = r.sections[0].rows.find((x) => x[0] === "CA")!;
    expect(ca).toEqual(["CA", 10_000, 10_000, 0, 725]);
    expect(r.warnings.join(" ")).toMatch(/3: tax charged in TX where no nexus/);
  });

  it("the totals engine output feeds the GSTR-1 correctly (engine -> report round trip)", () => {
    const t = computeTotals([{ qty: 1, unit_minor: 100_000, tax_rate_id: "c" }, { qty: 1, unit_minor: 100_000, tax_rate_id: "c" }], [{ id: "c", name: "CGST", rate_bp: 900 }, { id: "s", name: "SGST", rate_bp: 900 }].map((r) => ({ ...r })));
    expect(t.tax_minor).toBeGreaterThan(0);
  });
});

describe("reminders", () => {
  it("computes the last closed period and the 7-day lead window", () => {
    const now = new Date("2026-05-05T00:00:00Z");
    const m = lastClosedPeriod("monthly", "india_gst", now);
    expect(m.start.toISOString().slice(0, 10)).toBe("2026-04-01");
    expect(m.end.toISOString().slice(0, 10)).toBe("2026-04-30");
    expect(m.due.toISOString().slice(0, 10)).toBe("2026-05-11");
    expect(reminderDue(m.due, now)).toBe(true);
    expect(reminderDue(m.due, new Date("2026-05-10T00:00:00Z"))).toBe(true);
    expect(reminderDue(m.due, new Date("2026-04-20T00:00:00Z"))).toBe(false);
    expect(reminderDue(m.due, new Date("2026-05-12T00:00:00Z"))).toBe(false);
    const q = lastClosedPeriod("quarterly", "eu_vat", new Date("2026-04-10T00:00:00Z"));
    expect([q.start.toISOString().slice(0, 10), q.end.toISOString().slice(0, 10)]).toEqual(["2026-01-01", "2026-03-31"]);
    const y = lastClosedPeriod("annual", "us_sales", new Date("2026-01-05T00:00:00Z"));
    expect(y.start.toISOString().slice(0, 10)).toBe("2025-01-01");
  });
});

describe("resolveDocumentTotals is a no-op without a tax profile", () => {
  it("returns exactly the historic totals and never loads the compliance module's resolver", async () => {
    vi.resetModules();
    const queryMock = vi.fn(async () => []);
    vi.doMock("@/lib/dsql", () => ({ query: queryMock, queryOne: vi.fn(async () => null) }));
    vi.doMock("@/lib/table-exists", () => ({ tableExists: vi.fn(async (t: string) => t === "tax_rates" || t === "tax_profiles") }));
    vi.doMock("@/lib/money/settings", () => ({ getBillingSettings: vi.fn(async () => ({ prices_include_tax: false, tax_rounding: "per_line" })) }));
    const { resolveDocumentTotals } = await import("@/lib/money/tax-rates");
    const items = [{ description: "x", qty: 2, unit_minor: 5000, tax_rate_bp: 1000 }];
    const t = await resolveDocumentTotals("org1", items);
    expect(t.compliance).toBeUndefined();
    expect(t).toMatchObject({ subtotal_minor: 10_000, tax_minor: 1000, total_minor: 11_000 });
    const direct = computeTotals(items, []);
    expect(t.breakdown).toEqual(direct.breakdown);
    vi.doUnmock("@/lib/dsql");
    vi.doUnmock("@/lib/table-exists");
    vi.doUnmock("@/lib/money/settings");
  });
});
