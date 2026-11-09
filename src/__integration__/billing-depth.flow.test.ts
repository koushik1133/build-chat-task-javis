/**
 * Billing depth end-to-end: tax rate → quote with taxed lines (breakdown) →
 * send/accept → invoice with terms → due_at on send → markOverdue →
 * reminder queued → credit note → refund via simulated → statement balances →
 * recurring schedule run creates an invoice → public API v1 lists.
 */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { api, call, cleanupDataIds, createTestOrg, describeDb, expectEvent, req, setScope, sql, sqlOne, type TestOrg } from "./setup";

vi.mock("@/lib/auth/scope", () => import("./setup").then((m) => m.scopeMockFactory()));
vi.mock("@/lib/supabase/server", () => import("./setup").then((m) => m.supabaseMockFactory()));

interface Contact { id: string; email: string | null }
interface TaxRate { id: string; name: string; rate_bp: number; is_default: boolean }
interface Breakdown { rate_id: string | null; name: string; rate_bp: number; taxable_minor: number; tax_minor: number }
interface Quote { id: string; number: string; status: string; subtotal_minor: number; tax_minor: number; total_minor: number; tax_breakdown: Breakdown[]; current_version: number }
interface Invoice { id: string; number: string; status: string; total_minor: number; paid_minor: number; due_at: string | null; terms_days: number | null; tax_breakdown: Breakdown[]; reminder_count: number }
interface CreditNote { id: string; number: string; status: string; total_minor: number }
interface Schedule { id: string; status: string; next_run_at: string; run_count: number; last_invoice_id: string | null }

async function latestOtp(dataId: string, email: string): Promise<string> {
  const mail = await sqlOne<{ body: string }>(
    `SELECT body FROM notification_outbox WHERE user_id = $1 AND recipient = $2 AND data LIKE '%quote_otp%' ORDER BY created_at DESC, id DESC LIMIT 1`,
    [dataId, email]
  );
  const m = mail?.body?.match(/is:\s*(\d{6})/);
  if (!m) throw new Error(`no OTP email found for ${email}`);
  return m[1];
}

describeDb("billing depth flow", () => {
  let org: TestOrg;
  let contact: Contact;
  let vat: TaxRate;
  let gst: TaxRate;
  let quote: Quote;
  let shareToken: string;
  let invoice: Invoice;
  let paymentId: string;
  let creditNote: CreditNote;
  let schedule: Schedule;
  const clientEmail = "depth-client@example.test";

  beforeAll(async () => {
    org = await createTestOrg("billing-depth");
    setScope(org);
  });
  afterAll(async () => {
    await cleanupDataIds([org.dataId]);
  });

  it("sets org tax id, numbering prefixes and terms; creates tax rates", async () => {
    const settings = await import("@/app/api/billing/settings/route");
    const s = await api<{ settings: { tax_number: string; invoice_prefix: string; default_terms_days: number; dunning_schedule: number[] } }>(settings.PATCH, "/api/billing/settings", {
      method: "PATCH",
      json: { tax_id_label: "VAT ID", tax_number: "GB123456789", invoice_prefix: "KH", default_terms_days: 7, dunning_schedule: [-3, 0, 7] },
      expect: 200,
    });
    expect(s.body.settings.tax_number).toBe("GB123456789");
    expect(s.body.settings.invoice_prefix).toBe("KH");
    expect(s.body.settings.default_terms_days).toBe(7);

    const rates = await import("@/app/api/tax-rates/route");
    vat = (await api<{ rate: TaxRate }>(rates.POST, "/api/tax-rates", { json: { name: "VAT", rate_bp: 2000, kind: "vat", is_default: true }, expect: 201 })).body.rate;
    gst = (await api<{ rate: TaxRate }>(rates.POST, "/api/tax-rates", { json: { name: "GST", rate_bp: 500, kind: "gst" }, expect: 201 })).body.rate;
    expect(vat.is_default).toBe(true);
    const list = await api<{ rates: TaxRate[] }>(rates.GET, "/api/tax-rates", { expect: 200 });
    expect(list.body.rates.map((r) => r.name).sort()).toEqual(["GST", "VAT"]);
    // invalid body → 400 (strict)
    await api(rates.POST, "/api/tax-rates", { json: { name: "x", rate_bp: 100, bogus: 1 }, expect: 400 });

    const contacts = await import("@/app/api/crm/contacts/route");
    contact = (await api<{ contact: Contact }>(contacts.POST, "/api/crm/contacts", { json: { full_name: "Depth Client", email: clientEmail, company: "Depth Co" }, expect: 201 })).body.contact;
    await api(contacts.PATCH, "/api/crm/contacts", { method: "PATCH", json: { id: contact.id, tax_number: "DE999", billing_address: { line1: "1 Main St", city: "Berlin", country: "DE" } }, expect: 200 });
    const row = await sqlOne<{ tax_number: string; billing_address: string }>(`SELECT tax_number, billing_address FROM crm_contacts WHERE id = $1`, [contact.id]);
    expect(row?.tax_number).toBe("DE999");
    expect(JSON.parse(row?.billing_address ?? "{}").city).toBe("Berlin");
  });

  it("quote with catalogue-taxed lines stores a per-rate breakdown", async () => {
    const quotes = await import("@/app/api/quotes/route");
    const r = await api<{ quote: Quote }>(quotes.POST, "/api/quotes", {
      json: {
        contact_id: contact.id,
        currency: "USD",
        items: [
          { description: "Design", qty: 1, unit_minor: 10000, tax_rate_id: vat.id },
          { description: "Hosting", qty: 2, unit_minor: 1000, tax_rate_id: gst.id },
          { description: "Untaxed", qty: 1, unit_minor: 500 },
        ],
      },
      expect: 201,
    });
    quote = r.body.quote;
    expect(quote.subtotal_minor).toBe(12500);
    expect(quote.tax_minor).toBe(2000 + 100);
    expect(quote.total_minor).toBe(14600);
    expect(quote.tax_breakdown.map((b) => [b.rate_id, b.tax_minor])).toEqual([[gst.id, 100], [vat.id, 2000]]);
    const stored = await sqlOne<{ tax_breakdown: string }>(`SELECT tax_breakdown FROM quotes WHERE id = $1`, [quote.id]);
    expect(JSON.parse(stored?.tax_breakdown ?? "[]")).toHaveLength(2);

    const pdf = await import("@/app/api/quotes/[id]/pdf/route");
    const o = await call(pdf.GET, req(`/api/quotes/${quote.id}/pdf`), { id: quote.id }, 200);
    expect(o.text.startsWith("%PDF")).toBe(true);
    const txt = o.text;
    expect(txt).toContain("GB123456789");
    expect(txt).toContain("DE999");
    expect(txt).toContain("Berlin");
  });

  it("send binds the share link to the recipient; accept creates an invoice with terms and KH prefix", async () => {
    const send = await import("@/app/api/quotes/[id]/send/route");
    const s = await api<{ path: string }>(send.POST, `/api/quotes/${quote.id}/send`, { json: {}, params: { id: quote.id }, expect: 200 });
    shareToken = s.body.path.split("/").pop() ?? "";
    const bound = await sqlOne<{ recipient: string | null }>(`SELECT recipient FROM share_tokens WHERE kind = 'quote' AND entity_id = $1`, [quote.id]);
    expect(bound?.recipient).toBe(clientEmail);

    const otpRoute = await import("@/app/api/p/quotes/[token]/otp/route");
    await api(otpRoute.POST, `/api/p/quotes/${shareToken}/otp`, { json: { email: "someone-else@example.test" }, params: { token: shareToken }, expect: 400 });
    await api(otpRoute.POST, `/api/p/quotes/${shareToken}/otp`, { json: { email: clientEmail.toUpperCase() }, params: { token: shareToken }, expect: 200 });
    const otp = await latestOtp(org.dataId, clientEmail.toUpperCase());

    const accept = await import("@/app/api/p/quotes/[token]/accept/route");
    const a = await api<{ invoiceCreated: boolean }>(accept.POST, `/api/p/quotes/${shareToken}/accept`, {
      json: { otp, name: "Depth Client", email: clientEmail.toUpperCase(), accept_terms: true },
      params: { token: shareToken },
      expect: 200,
    });
    expect(a.body.invoiceCreated).toBe(true);
    const inv = await sqlOne<Invoice>(`SELECT id, number, status, total_minor, paid_minor, due_at, terms_days FROM invoices WHERE quote_id = $1`, [quote.id]);
    expect(inv).toBeTruthy();
    invoice = inv as Invoice;
    expect(invoice.number).toMatch(/^KH-\d{6}$/);
    expect(Number(invoice.total_minor)).toBe(14600);
    // Quote conversion sets an explicit due date (14 days) — breakdown carried over.
    const full = await api<{ invoice: Invoice }>((await import("@/app/api/invoices/[id]/route")).GET, `/api/invoices/${invoice.id}`, { params: { id: invoice.id }, expect: 200 });
    expect(full.body.invoice.tax_breakdown).toHaveLength(2);
  });

  it("invoice created with terms gets due_at = sent_at + terms on send; markOverdue flips it and emits", async () => {
    const invoices = await import("@/app/api/invoices/route");
    const r = await api<{ invoice: Invoice }>(invoices.POST, "/api/invoices", {
      json: { contact_id: contact.id, currency: "USD", terms_days: 1, items: [{ description: "Rush fee", qty: 1, unit_minor: 5000, tax_rate_id: vat.id }] },
      expect: 201,
    });
    invoice = r.body.invoice;
    expect(invoice.terms_days).toBe(1);
    expect(invoice.due_at).toBeNull();
    expect(invoice.total_minor).toBe(6000);

    const send = await import("@/app/api/invoices/[id]/send/route");
    const s = await api<{ invoice: Invoice }>(send.POST, `/api/invoices/${invoice.id}/send`, { json: {}, params: { id: invoice.id }, expect: 200 });
    expect(s.body.invoice.status).toBe("sent");
    expect(s.body.invoice.due_at).toBeTruthy();
    const dueMs = new Date(s.body.invoice.due_at ?? "").getTime() - Date.now();
    expect(dueMs).toBeGreaterThan(23 * 3_600_000);
    expect(dueMs).toBeLessThanOrEqual(24 * 3_600_000 + 60_000);
    const bound = await sqlOne<{ recipient: string | null }>(`SELECT recipient FROM share_tokens WHERE kind = 'invoice' AND entity_id = $1 ORDER BY created_at DESC LIMIT 1`, [invoice.id]);
    expect(bound?.recipient).toBe(clientEmail);

    // Push due date into the past, then sweep.
    await sql(`UPDATE invoices SET due_at = NOW() - INTERVAL '2 days' WHERE id = $1`, [invoice.id]);
    const { markOverdue, sendReminders } = await import("@/lib/money/dunning");
    const o = await markOverdue(100);
    expect(o.marked).toBeGreaterThanOrEqual(1);
    const row = await sqlOne<{ status: string }>(`SELECT status FROM invoices WHERE id = $1`, [invoice.id]);
    expect(row?.status).toBe("overdue");
    await expectEvent(org.dataId, "invoice.overdue", invoice.id);

    // Schedule [-3, 0, 7]: 2 days late → step 2 due; one reminder per sweep (the counter jumps to the current step).
    const rem = await sendReminders(100);
    expect(rem.sent).toBeGreaterThanOrEqual(1);
    const after = await sqlOne<{ reminder_count: number; last_reminder_at: string | null }>(`SELECT reminder_count, last_reminder_at FROM invoices WHERE id = $1`, [invoice.id]);
    expect(Number(after?.reminder_count)).toBe(2);
    expect(after?.last_reminder_at).toBeTruthy();
    const mail = await sqlOne<{ recipient: string; body: string }>(
      `SELECT recipient, body FROM notification_outbox WHERE user_id = $1 AND data LIKE '%invoice_reminder%' ORDER BY created_at DESC LIMIT 1`,
      [org.dataId]
    );
    expect(mail?.recipient).toBe(clientEmail);
    expect(mail?.body).toContain("/p/i/");
    await expectEvent(org.dataId, "invoice.reminder_sent", invoice.id);
    // Second sweep right away: nothing new to send.
    const again = await sendReminders(100);
    const count2 = await sqlOne<{ reminder_count: number }>(`SELECT reminder_count FROM invoices WHERE id = $1`, [invoice.id]);
    expect(Number(count2?.reminder_count)).toBe(2);
    void again;

    // Opt-out suppresses reminders.
    await sql(`UPDATE crm_contacts SET invoice_reminders_opt_out = TRUE WHERE id = $1`, [contact.id]);
    await sql(`UPDATE invoices SET due_at = NOW() - INTERVAL '10 days', last_reminder_at = NULL WHERE id = $1`, [invoice.id]);
    const opt = await sendReminders(100);
    expect(opt.skipped_opt_out).toBeGreaterThanOrEqual(1);
    const count3 = await sqlOne<{ reminder_count: number }>(`SELECT reminder_count FROM invoices WHERE id = $1`, [invoice.id]);
    expect(Number(count3?.reminder_count)).toBe(2);
    await sql(`UPDATE crm_contacts SET invoice_reminders_opt_out = FALSE WHERE id = $1`, [contact.id]);
  });

  it("pays the invoice (simulated), issues a credit note and refunds part through the provider", async () => {
    const payLink = await import("@/app/api/invoices/[id]/pay-link/route");
    const pl = await api<{ token: string }>(payLink.POST, `/api/invoices/${invoice.id}/pay-link`, { method: "POST", params: { id: invoice.id }, expect: 201 });
    const pay = await import("@/app/api/p/pay/[token]/route");
    await api(pay.POST, `/api/p/pay/${pl.body.token}`, { json: { outcome: "success" }, params: { token: pl.body.token }, expect: 200 });
    const paid = await sqlOne<{ status: string; paid_minor: number }>(`SELECT status, paid_minor FROM invoices WHERE id = $1`, [invoice.id]);
    expect(paid?.status).toBe("paid");
    expect(Number(paid?.paid_minor)).toBe(6000);

    const payments = await import("@/app/api/invoices/[id]/payments/route");
    const pr = await api<{ payments: Array<{ id: string; amount_minor: number; refunded_minor: number; status: string }> }>(payments.GET, `/api/invoices/${invoice.id}/payments`, { params: { id: invoice.id }, expect: 200 });
    const succeeded = pr.body.payments.find((p) => p.status === "succeeded");
    expect(succeeded?.amount_minor).toBe(6000);
    paymentId = succeeded?.id ?? "";

    // Credit note for the whole invoice is capped by the invoice total: a second full credit must fail.
    const cnRoute = await import("@/app/api/credit-notes/route");
    const partial = await api<{ credit_note: CreditNote }>(cnRoute.POST, "/api/credit-notes", {
      json: { invoice_id: invoice.id, items: [{ description: "Goodwill", qty: 1, unit_minor: 1000, tax_rate_id: vat.id }], reason: "Late delivery" },
      expect: 201,
    });
    creditNote = partial.body.credit_note;
    expect(creditNote.status).toBe("draft");
    expect(creditNote.number).toMatch(/^CN-\d{6}$/);
    expect(creditNote.total_minor).toBe(1200);
    const issue = await import("@/app/api/credit-notes/[id]/issue/route");
    const issued = await api<{ credit_note: CreditNote }>(issue.POST, `/api/credit-notes/${creditNote.id}/issue`, { method: "POST", params: { id: creditNote.id }, expect: 200 });
    expect(issued.body.credit_note.status).toBe("applied");
    await expectEvent(org.dataId, "credit_note.issued", creditNote.id);
    await api(issue.POST, `/api/credit-notes/${creditNote.id}/issue`, { method: "POST", params: { id: creditNote.id }, expect: 400 });
    await api(cnRoute.POST, "/api/credit-notes", { json: { invoice_id: invoice.id, items: [{ description: "Too much", qty: 1, unit_minor: 6000 }] }, expect: 400 });
    const pdf = await import("@/app/api/credit-notes/[id]/pdf/route");
    const p = await call(pdf.GET, req(`/api/credit-notes/${creditNote.id}/pdf`), { id: creditNote.id }, 200);
    expect(p.text.startsWith("%PDF")).toBe(true);
    expect(p.text).toContain("CREDIT NOTE");

    // Refund the credited amount through the simulated provider; invoice drops to partially paid.
    const refund = await import("@/app/api/invoices/[id]/refund/route");
    await api(refund.POST, `/api/invoices/${invoice.id}/refund`, { json: { paymentId, amount_minor: 999_999 }, params: { id: invoice.id }, expect: 400 });
    const r = await api<{ refund_ref: string; invoice_status: string; payment: { refunded_minor: number } }>(refund.POST, `/api/invoices/${invoice.id}/refund`, {
      json: { paymentId, amount_minor: 1200, credit_note_id: creditNote.id, reason: "Goodwill" },
      params: { id: invoice.id },
      expect: 201,
    });
    expect(r.body.refund_ref).toMatch(/^simrf_/);
    expect(r.body.invoice_status).toBe("partially_paid");
    expect(Number(r.body.payment.refunded_minor)).toBe(1200);
    const inv = await sqlOne<{ status: string; paid_minor: number }>(`SELECT status, paid_minor FROM invoices WHERE id = $1`, [invoice.id]);
    expect(Number(inv?.paid_minor)).toBe(4800);
    const cn = await sqlOne<{ status: string }>(`SELECT status FROM credit_notes WHERE id = $1`, [creditNote.id]);
    expect(cn?.status).toBe("refunded");
    await expectEvent(org.dataId, "payment.refunded", invoice.id);
  });

  it("customer statement balances: invoices − payments − credits + refunds", async () => {
    const st = await import("@/app/api/crm/contacts/[id]/statement/route");
    const r = await api<{ statement: { balances: Array<{ currency: string; invoiced_minor: number; paid_minor: number; credited_minor: number; refunded_minor: number; closing_minor: number }>; entries: Array<{ kind: string }> } }>(
      st.GET,
      `/api/crm/contacts/${contact.id}/statement`,
      { params: { id: contact.id }, expect: 200 }
    );
    const usd = r.body.statement.balances.find((b) => b.currency === "USD");
    // Two invoices: 14600 (from quote, unpaid draft? no — auto-invoice is draft and excluded) + 6000 sent one.
    // Draft invoices are excluded, so: invoiced 6000, paid 6000, credited 1200, refunded 1200 → closing 0.
    expect(usd).toMatchObject({ invoiced_minor: 6000, paid_minor: 6000, credited_minor: 1200, refunded_minor: 1200, closing_minor: 0 });
    expect(r.body.statement.entries.map((e) => e.kind).sort()).toEqual(["credit_note", "invoice", "payment", "refund"]);
    const pdf = await call(st.GET, req(`/api/crm/contacts/${contact.id}/statement`, { query: { format: "pdf" } }), { id: contact.id }, 200);
    expect(pdf.text.startsWith("%PDF")).toBe(true);
    expect(pdf.text).toContain("STATEMENT");
    await api(st.GET, `/api/crm/contacts/${contact.id}/statement`, { params: { id: contact.id }, query: { from: "nope" }, expect: 400 });

    // Portal exposes the balance + statement.
    const link = await import("@/app/api/crm/contacts/[id]/portal-link/route");
    const pl = await api<{ path?: string; url?: string }>(link.POST, `/api/crm/contacts/${contact.id}/portal-link`, { method: "POST", params: { id: contact.id }, expect: [200, 201] });
    const token = (pl.body.path ?? pl.body.url ?? "").split("/").pop() ?? "";
    const portal = await import("@/app/api/p/portal/[token]/route");
    const pd = await api<{ balance_minor: number; balances: Array<{ currency: string; closing_minor: number }> }>(portal.GET, `/api/p/portal/${token}`, { params: { token }, expect: 200 });
    expect(pd.body.balances.find((b) => b.currency === "USD")?.closing_minor).toBe(0);
    const pst = await import("@/app/api/p/portal/[token]/statement/route");
    const ps = await call(pst.GET, req(`/api/p/portal/${token}/statement`, { query: { format: "pdf" } }), { token }, 200);
    expect(ps.text.startsWith("%PDF")).toBe(true);
  });

  it("recurring schedule: run now creates an invoice, advances with month-end clamping; sweep claims due rows", async () => {
    const routes = await import("@/app/api/invoice-schedules/route");
    const firstRun = new Date(Date.UTC(2026, 0, 31, 9, 0, 0)).toISOString();
    const r = await api<{ schedule: Schedule }>(routes.POST, "/api/invoice-schedules", {
      json: {
        name: "Retainer",
        contact_id: contact.id,
        currency: "USD",
        items: [{ description: "Monthly retainer", qty: 1, unit_minor: 20000, tax_rate_id: vat.id }],
        interval: "monthly",
        interval_count: 1,
        day_of_month: 31,
        next_run_at: firstRun,
        auto_send: true,
        terms_days: 14,
      },
      expect: 201,
    });
    schedule = r.body.schedule;
    expect(schedule.status).toBe("active");

    // Due (next_run_at is in the past relative to now) → sweep creates + sends.
    const { runDueSchedules } = await import("@/lib/money/recurring");
    const sweep = await runDueSchedules(10);
    expect(sweep.created).toBeGreaterThanOrEqual(1);
    const after = await sqlOne<Schedule>(`SELECT id, status, next_run_at, run_count, last_invoice_id FROM invoice_schedules WHERE id = $1`, [schedule.id]);
    expect(Number(after?.run_count)).toBe(1);
    expect(new Date(after?.next_run_at ?? "").toISOString().slice(0, 10)).toBe("2026-02-28");
    const inv = await sqlOne<{ status: string; total_minor: number; schedule_id: string; terms_days: number; due_at: string | null }>(`SELECT status, total_minor, schedule_id, terms_days, due_at FROM invoices WHERE id = $1`, [after?.last_invoice_id]);
    expect(inv?.schedule_id).toBe(schedule.id);
    expect(Number(inv?.total_minor)).toBe(24000);
    expect(inv?.status).toBe("sent"); // auto_send
    expect(inv?.due_at).toBeTruthy(); // terms 14 → due set on send
    await expectEvent(org.dataId, "invoice.scheduled_created", after?.last_invoice_id ?? "");

    // Run now from the route (forced) → second invoice, next run clamps to Mar 31.
    const run = await import("@/app/api/invoice-schedules/[id]/run/route");
    const rn = await api<{ result: { invoice_id: string | null }; schedule: Schedule }>(run.POST, `/api/invoice-schedules/${schedule.id}/run`, { method: "POST", params: { id: schedule.id }, expect: 201 });
    expect(rn.body.result.invoice_id).toBeTruthy();
    expect(rn.body.schedule.run_count).toBe(2);
    expect(rn.body.schedule.next_run_at.slice(0, 10)).toBe("2026-03-31");

    // Pause → run refused; resume works; delete.
    const byId = await import("@/app/api/invoice-schedules/[id]/route");
    await api(byId.PATCH, `/api/invoice-schedules/${schedule.id}`, { method: "PATCH", json: { status: "paused" }, params: { id: schedule.id }, expect: 200 });
    await api(run.POST, `/api/invoice-schedules/${schedule.id}/run`, { method: "POST", params: { id: schedule.id }, expect: 400 });
    await api(byId.PATCH, `/api/invoice-schedules/${schedule.id}`, { method: "PATCH", json: { status: "active" }, params: { id: schedule.id }, expect: 200 });
  });

  it("public API v1 lists tax rates, schedules and credit notes with the standard envelope", async () => {
    const { ROUTE_LIST } = await import("@/lib/public-api/registry");
    expect(ROUTE_LIST.map((r) => r.path)).toEqual(expect.arrayContaining(["/tax-rates", "/tax-rates/{id}", "/invoice-schedules", "/invoice-schedules/{id}", "/credit-notes", "/credit-notes/{id}"]));
    const { buildOpenApiDocument } = await import("@/lib/public-api/openapi");
    const doc = buildOpenApiDocument({ serverUrl: "http://localhost:3001" }) as unknown as { paths: Record<string, unknown> };
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(["/tax-rates", "/credit-notes/{id}", "/invoice-schedules/{id}"]));
  });

  it("viewer role cannot mutate billing depth resources", async () => {
    setScope(org, { role: "viewer" });
    const rates = await import("@/app/api/tax-rates/route");
    const r = await api(rates.POST, "/api/tax-rates", { json: { name: "Nope", rate_bp: 100 } });
    expect([401, 403]).toContain(r.status);
    setScope(null);
    const u = await api(rates.GET, "/api/tax-rates");
    expect(u.status).toBe(401);
    setScope(org);
  });
});
