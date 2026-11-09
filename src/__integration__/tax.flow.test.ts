/**
 * Tax compliance end-to-end: India profile -> intra-state invoice splits CGST/SGST ->
 * inter-state IGST -> credit note -> GSTR-1 report totals -> e-invoice generate +
 * simulated submit -> EU reverse-charge invoice -> EC list -> prepare filing ->
 * plan gate -> API v1 + 401/403.
 */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { api, call, cleanupDataIds, createTestOrg, describeDb, req, setScope, sql, sqlOne, type TestOrg } from "./setup";

vi.mock("@/lib/auth/scope", () => import("./setup").then((m) => m.scopeMockFactory()));
vi.mock("@/lib/supabase/server", () => import("./setup").then((m) => m.supabaseMockFactory()));

interface Breakdown { name: string; rate_bp: number; taxable_minor: number; tax_minor: number }
interface Invoice { id: string; number: string; tax_minor: number; total_minor: number; tax_breakdown: Breakdown[] }
interface Contact { id: string }
interface Section { key: string; rows: Array<Array<string | number | null>> }
interface Report { totals: Record<string, number>; sections: Section[]; warnings: string[]; report_hash: string }

const SELLER_GSTIN = "27AAPFU0939F1ZV"; // Maharashtra
const BUYER_KA = "29AABCT1332L1ZA"; // Karnataka

describeDb("tax compliance flow", () => {
  let org: TestOrg;
  let gstRateId: string;
  let vatRateId: string;
  let intra: Invoice;
  let inter: Invoice;
  const prevEnforced = process.env.PLANS_ENFORCED;
  const today = new Date().toISOString().slice(0, 10);
  const range = { from: `${today.slice(0, 8)}01`, to: today };

  beforeAll(async () => {
    org = await createTestOrg("tax");
    setScope(org);
    delete process.env.PLANS_ENFORCED;
  });
  afterAll(async () => {
    if (prevEnforced === undefined) delete process.env.PLANS_ENFORCED;
    else process.env.PLANS_ENFORCED = prevEnforced;
    await cleanupDataIds([org.dataId]);
  });

  const contact = async (full_name: string, tax: { tax_number?: string; tax_country?: string; tax_registration_type?: string; tax_state?: string }) => {
    const c = await import("@/app/api/crm/contacts/route");
    const made = await api<{ contact: Contact }>(c.POST, "/api/crm/contacts", { json: { full_name, email: `${full_name.replace(/\W/g, "").toLowerCase()}@example.test` }, expect: [200, 201] });
    const id = made.body.contact.id;
    const t = await import("@/app/api/tax/contact/[id]/route");
    await api(t.PUT, `/api/tax/contact/${id}`, { method: "PUT", json: tax, params: { id }, expect: 200 });
    return id;
  };
  const invoice = async (contact_id: string, unit_minor = 100_000, extra: Record<string, unknown> = {}) => {
    const r = await import("@/app/api/invoices/route");
    const res = await api<{ invoice: Invoice }>(r.POST, "/api/invoices", { json: { contact_id, currency: "INR", items: [{ description: "Steel bolts", qty: 1, unit_minor, tax_rate_id: gstRateId, hsn_sac: "7318" }], ...extra }, expect: 201 });
    const send = await import("@/app/api/invoices/[id]/send/route");
    await api(send.POST, `/api/invoices/${res.body.invoice.id}/send`, { json: {}, params: { id: res.body.invoice.id }, expect: [200, 201] });
    return res.body.invoice;
  };

  it("without a tax profile the engine behaves as before (single GST row)", async () => {
    const rates = await import("@/app/api/tax-rates/route");
    gstRateId = (await api<{ rate: { id: string } }>(rates.POST, "/api/tax-rates", { json: { name: "GST", rate_bp: 1800, kind: "gst" }, expect: 201 })).body.rate.id;
    vatRateId = (await api<{ rate: { id: string } }>(rates.POST, "/api/tax-rates", { json: { name: "VAT", rate_bp: 2000, kind: "vat" }, expect: 201 })).body.rate.id;
    const c = await contact("Pre Profile", {});
    const inv = await invoice(c);
    expect(inv.tax_breakdown.map((b) => b.name)).toEqual(["GST"]);
    expect(inv.tax_minor).toBe(18_000);
    await sql(`DELETE FROM invoices WHERE id = $1`, [inv.id]);
  });

  it("saves an India GST profile (validates the GSTIN checksum)", async () => {
    const p = await import("@/app/api/tax/profile/route");
    await api(p.PUT, "/api/tax/profile", { method: "PUT", json: { regime: "india_gst", country: "IN", registration_number: "27AAPFU0939F1ZX" }, expect: 400 });
    const ok = await api<{ profile: { regime: string } }>(p.PUT, "/api/tax/profile", {
      method: "PUT", json: { regime: "india_gst", country: "IN", registration_number: SELLER_GSTIN, filing_frequency: "monthly", e_invoicing_enabled: true, settings: { legal_name: "Kernel Traders Pvt Ltd", address_line1: "12 MG Road", city: "Mumbai", postal_code: "400001" } }, expect: 200,
    });
    expect(ok.body.profile.regime).toBe("india_gst");
    await api(p.PUT, "/api/tax/profile", { method: "PUT", json: { regime: "india_gst", bogus: 1 }, expect: 400 });
  });

  it("intra-state invoice splits CGST/SGST; inter-state uses IGST", async () => {
    const same = await contact("Local Co", { tax_number: SELLER_GSTIN, tax_registration_type: "b2b", tax_country: "IN" });
    intra = await invoice(same);
    expect(intra.tax_breakdown.map((b) => [b.name, b.rate_bp, b.tax_minor])).toEqual([["CGST", 900, 9000], ["SGST", 900, 9000]]);
    expect(intra.total_minor).toBe(118_000);
    const row = await sqlOne<{ place_of_supply: string; tax_regime: string; reverse_charge: boolean }>(`SELECT place_of_supply, tax_regime, reverse_charge FROM invoices WHERE id = $1`, [intra.id]);
    expect(row).toMatchObject({ place_of_supply: "27", tax_regime: "india_gst", reverse_charge: false });

    const ka = await contact("Bharat Retail", { tax_number: BUYER_KA, tax_registration_type: "b2b", tax_country: "IN" });
    inter = await invoice(ka, 200_000);
    expect(inter.tax_breakdown.map((b) => [b.name, b.tax_minor])).toEqual([["IGST", 36_000]]);
    expect((await sqlOne<{ place_of_supply: string }>(`SELECT place_of_supply FROM invoices WHERE id = $1`, [inter.id]))?.place_of_supply).toBe("29");
  });

  it("credit note against the inter-state invoice keeps IGST (contact-aware)", async () => {
    const cn = await import("@/app/api/credit-notes/route");
    const made = await api<{ credit_note: { id: string; tax_breakdown: Breakdown[]; total_minor: number } }>(cn.POST, "/api/credit-notes", {
      json: { invoice_id: inter.id, items: [{ description: "Steel bolts", qty: 1, unit_minor: 50_000, tax_rate_id: gstRateId, hsn_sac: "7318" }], issue: true }, expect: 201,
    });
    expect(made.body.credit_note.tax_breakdown.map((b) => b.name)).toEqual(["IGST"]);
    expect(made.body.credit_note.total_minor).toBe(59_000);
  });

  it("GSTR-1 totals: B2B rows, negative credit note, HSN summary, deterministic hash", async () => {
    const rep = await import("@/app/api/tax/reports/route");
    const get = () => api<{ report: Report }>(rep.GET, "/api/tax/reports", { query: { regime: "india_gst", ...range }, expect: 200 });
    const a = (await get()).body.report;
    expect(a.sections.find((s) => s.key === "b2b")?.rows).toHaveLength(2);
    expect(a.sections.find((s) => s.key === "cdn")?.rows).toHaveLength(1);
    expect(a.totals.cgst).toBe(9000);
    expect(a.totals.sgst).toBe(9000);
    expect(a.totals.igst).toBe(36_000 - 9000);
    expect(a.sections.find((s) => s.key === "hsn")?.rows.some((r) => r[0] === "7318")).toBe(true);
    expect((await get()).body.report.report_hash).toBe(a.report_hash);
    const csv = await call(rep.GET, req("/api/tax/reports", { query: { regime: "india_gst", ...range, format: "csv" } }), {}, 200);
    expect(csv.res.headers.get("content-type")).toContain("text/csv");
    expect(csv.text).toContain("12 - HSN summary");
    await api(rep.GET, "/api/tax/reports", { query: { regime: "india_gst", from: "bad", to: today }, expect: 400 });
  });

  it("e-invoice: validation errors listed, generate IRP JSON, simulated submit returns IRN", async () => {
    const route = await import("@/app/api/invoices/[id]/e-invoice/route");
    const fail = await api<{ errors: string[] }>(route.POST, `/api/invoices/${intra.id}/e-invoice`, { json: { action: "generate" }, params: { id: intra.id }, expect: 422 });
    expect(fail.body.errors.join("|")).toMatch(/Buyer address line is missing|Buyer PIN code/);
    // complete the buyer address, then it generates
    await sql(`UPDATE crm_contacts SET billing_address = $2 WHERE id = (SELECT contact_id FROM invoices WHERE id = $1)`, [inter.id, JSON.stringify({ line1: "5 Brigade Road", city: "Bengaluru", postal_code: "560001", country: "IN" })]);
    const gen = await api<{ e_invoice: { status: string; format: string } }>(route.POST, `/api/invoices/${inter.id}/e-invoice`, { json: { action: "generate" }, params: { id: inter.id }, expect: 201 });
    expect(gen.body.e_invoice).toMatchObject({ status: "generated", format: "in_irp_json" });
    const dl = await call(route.GET, req(`/api/invoices/${inter.id}/e-invoice`), { id: inter.id }, 200);
    const payload = JSON.parse(dl.text) as { ItemList: Array<{ HsnCd: string; IgstAmt: number }>; ValDtls: { TotInvVal: number } };
    expect(payload.ItemList[0]).toMatchObject({ HsnCd: "7318", IgstAmt: 360 });
    expect(payload.ValDtls.TotInvVal).toBe(2360);
    const sub = await api<{ e_invoice: { status: string; provider_ref: string }; simulated: boolean }>(route.POST, `/api/invoices/${inter.id}/e-invoice`, { json: { action: "submit" }, params: { id: inter.id }, expect: 200 });
    expect(sub.body.simulated).toBe(true);
    expect(sub.body.e_invoice.status).toBe("accepted");
    expect(sub.body.e_invoice.provider_ref).toMatch(/^[0-9a-f]{64}$/);
    expect((await sqlOne<{ e_invoice_status: string }>(`SELECT e_invoice_status FROM invoices WHERE id = $1`, [inter.id]))?.e_invoice_status).toBe("accepted");
    await api(route.POST, `/api/invoices/${inter.id}/e-invoice`, { json: { action: "generate" }, params: { id: inter.id }, expect: 409 });
    const list = await import("@/app/api/tax/e-invoices/route");
    expect((await api<{ e_invoices: unknown[] }>(list.GET, "/api/tax/e-invoices", { expect: 200 })).body.e_invoices).toHaveLength(2);
  });

  it("EU profile: B2B reverse-charge invoice and the EC sales list", async () => {
    const p = await import("@/app/api/tax/profile/route");
    await api(p.PUT, "/api/tax/profile", { method: "PUT", json: { regime: "eu_vat", country: "DE", registration_number: "DE123456789", filing_frequency: "quarterly" }, expect: 200 });
    const fr = await contact("Société FR", { tax_number: "FR12345678901", tax_registration_type: "b2b", tax_country: "FR" });
    const r = await import("@/app/api/invoices/route");
    const res = await api<{ invoice: Invoice }>(r.POST, "/api/invoices", { json: { contact_id: fr, currency: "EUR", items: [{ description: "Consulting", qty: 1, unit_minor: 100_000, tax_rate_id: vatRateId }] }, expect: 201 });
    expect(res.body.invoice.tax_minor).toBe(0);
    const send = await import("@/app/api/invoices/[id]/send/route");
    await api(send.POST, `/api/invoices/${res.body.invoice.id}/send`, { json: {}, params: { id: res.body.invoice.id }, expect: [200, 201] });
    expect(await sqlOne(`SELECT 1 FROM invoices WHERE id = $1 AND reverse_charge = TRUE AND place_of_supply = 'FR'`, [res.body.invoice.id])).toBeTruthy();
    const rep = await import("@/app/api/tax/reports/route");
    const out = await api<{ report: Report }>(rep.GET, "/api/tax/reports", { query: { regime: "eu_vat", ...range }, expect: 200 });
    const ecl = out.body.report.sections.find((s) => s.key === "ecl")!;
    expect(ecl.rows).toEqual([["FR12345678901", "FR", 0, 100_000]].map((x) => x));
  });

  it("prepares a filing, then marks it filed manually", async () => {
    const rep = await import("@/app/api/tax/reports/route");
    const prep = await api<{ filing: { id: string; status: string; report_hash: string } }>(rep.POST, "/api/tax/reports", { json: { regime: "eu_vat", ...range }, expect: 201 });
    expect(prep.body.filing.status).toBe("prepared");
    const filings = await import("@/app/api/tax/filings/route");
    const filed = await api<{ filing: { status: string; filed_ref: string } }>(filings.PATCH, "/api/tax/filings", { method: "PATCH", json: { id: prep.body.filing.id, action: "file", filed_ref: "ARN-123" }, expect: 200 });
    expect(filed.body.filing).toMatchObject({ status: "filed", filed_ref: "ARN-123" });
    expect((await api<{ filings: unknown[] }>(filings.GET, "/api/tax/filings", { expect: 200 })).body.filings).toHaveLength(1);
  });

  it("plan gate: reports and e-invoices return 402 when the plan lacks tax_compliance", async () => {
    const plans = await import("@/app/api/plans/subscription/route");
    await api(plans.GET, "/api/plans/subscription", { expect: 200 });
    await sql(`UPDATE subscriptions SET trial_ends_at = NOW() - INTERVAL '1 day', current_period_end = NOW() - INTERVAL '1 day' WHERE user_id = $1`, [org.dataId]);
    process.env.PLANS_ENFORCED = "true";
    const rep = await import("@/app/api/tax/reports/route");
    const res = await api<{ error: string }>(rep.GET, "/api/tax/reports", { query: { regime: "eu_vat", ...range }, expect: 402 });
    expect(res.body.error).toBe("plan_limit");
    delete process.env.PLANS_ENFORCED;
  });

  it("API v1: 401 without a key, 403 without read:billing, 200 with it; e-invoices list", async () => {
    const keys = await import("@/app/api/api-keys/route");
    const good = (await api<{ key: string }>(keys.POST, "/api/api-keys", { json: { name: "tax", scopes: ["read:billing"] }, expect: 201 })).body.key;
    const bad = (await api<{ key: string }>(keys.POST, "/api/api-keys", { json: { name: "crm only", scopes: ["read:crm"] }, expect: 201 })).body.key;
    const v1 = await import("@/app/api/v1/tax/reports/route");
    const q = { regime: "eu_vat", ...range };
    await api(v1.GET, "/api/v1/tax/reports", { query: q, expect: 401 });
    await api(v1.GET, "/api/v1/tax/reports", { query: q, headers: { authorization: `Bearer ${bad}` }, expect: 403 });
    const ok = await api<{ data: Report }>(v1.GET, "/api/v1/tax/reports", { query: q, headers: { authorization: `Bearer ${good}` }, expect: 200 });
    expect(ok.body.data.report_hash).toMatch(/^[0-9a-f]{64}$/);
    const list = await import("@/app/api/v1/e-invoices/route");
    await api(list.GET, "/api/v1/e-invoices", { expect: 401 });
    const l = await api<{ data: Array<{ format: string }> }>(list.GET, "/api/v1/e-invoices", { headers: { authorization: `Bearer ${good}` }, expect: 200 });
    expect(l.body.data.length).toBeGreaterThan(0);
  });

  it("route auth: viewer without edit cannot save a profile (403)", async () => {
    setScope(org, { role: "viewer" });
    const p = await import("@/app/api/tax/profile/route");
    await api(p.PUT, "/api/tax/profile", { method: "PUT", json: { regime: "generic" }, expect: 403 });
    setScope(org);
  });
});
