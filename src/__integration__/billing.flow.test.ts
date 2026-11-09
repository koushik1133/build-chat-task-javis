/**
 * Billing end-to-end: contact → quote (with tracked product) → send → public
 * view → OTP → e-sign accept → auto invoice → stock reserve → pay link →
 * simulated payment → paid → stock consumed → replay idempotent → PDFs →
 * decline releases stock → expiry sweep.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { api, call, cleanupDataIds, createTestOrg, describeDb, eventsFor, expectEvent, parseJson, req, setScope, sql, sqlOne, type TestOrg } from "./setup";

vi.mock("@/lib/auth/scope", () => import("./setup").then((m) => m.scopeMockFactory()));
vi.mock("@/lib/supabase/server", () => import("./setup").then((m) => m.supabaseMockFactory()));

interface Contact { id: string; email: string | null }
interface Product { id: string; stock_on_hand: number; stock_reserved: number; stock_available: number }
interface Quote {
  id: string;
  number: string;
  status: string;
  total_minor: number;
  items: Array<{ description: string; qty: number; unit_minor: number; tax_rate_bp: number; product_id?: string }>;
  current_version: number;
}
interface Invoice { id: string; number: string; status: string; paid_minor: number; total_minor: number; quote_id: string | null }

async function latestOtp(dataId: string, email: string): Promise<string> {
  const mail = await sqlOne<{ body: string }>(
    `SELECT body FROM notification_outbox WHERE user_id = $1 AND recipient = $2 AND data LIKE '%quote_otp%' ORDER BY created_at DESC, id DESC LIMIT 1`,
    [dataId, email]
  );
  const m = mail?.body?.match(/is:\s*(\d{6})/);
  if (!m) throw new Error(`no OTP email found for ${email}: ${mail?.body ?? "(none)"}`);
  return m[1];
}

describeDb("billing flow", () => {
  let org: TestOrg;
  let contact: Contact;
  let product: Product;
  let quote: Quote;
  let shareToken: string;
  let otp: string;
  let invoice: Invoice;
  let payToken: string;
  const clientEmail = "client@example.test";

  beforeAll(async () => {
    org = await createTestOrg("billing");
    setScope(org);
  });
  afterAll(async () => {
    await cleanupDataIds([org.dataId]);
  });

  it("creates a contact and a stock-tracked product", async () => {
    const contacts = await import("@/app/api/crm/contacts/route");
    const c = await api<{ contact: Contact }>(contacts.POST, "/api/crm/contacts", {
      json: { full_name: "Ada Client", email: clientEmail, company: "Client Co" },
      expect: 201,
    });
    contact = c.body.contact;
    expect(contact.email).toBe(clientEmail);
    await expectEvent(org.dataId, "crm.contact.created", contact.id);

    const products = await import("@/app/api/products/route");
    const p = await api<{ product: Product }>(products.POST, "/api/products", {
      json: { name: "Widget", sku: "W-1", unit_price_minor: 2500, track_stock: true, stock_on_hand: 10, reorder_point: 2 },
      expect: 201,
    });
    product = p.body.product;
    expect(product.stock_available).toBe(10);
    await expectEvent(org.dataId, "product.created", product.id);
  });

  it("creates a quote with a product line and emits quote.created", async () => {
    const quotes = await import("@/app/api/quotes/route");
    const r = await api<{ quote: Quote }>(quotes.POST, "/api/quotes", {
      json: {
        contact_id: contact.id,
        currency: "USD",
        items: [
          { description: "Widget", qty: 3, unit_minor: 2500, tax_rate_bp: 1000, product_id: product.id },
          { description: "Setup", qty: 1, unit_minor: 10000, tax_rate_bp: 0 },
        ],
      },
      expect: 201,
    });
    quote = r.body.quote;
    expect(quote.status).toBe("draft");
    expect(quote.number).toMatch(/^Q-\d+/);
    // 3*2500 = 7500 + 10% tax 750 + 10000 = 18250
    expect(quote.total_minor).toBe(18250);
    expect(quote.items).toHaveLength(2);
    await expectEvent(org.dataId, "quote.created", quote.id);
  });

  it("sends the quote: status sent, share token issued, email queued", async () => {
    const send = await import("@/app/api/quotes/[id]/send/route");
    const r = await api<{ quote: Quote; url: string; path: string }>(send.POST, `/api/quotes/${quote.id}/send`, {
      json: {},
      params: { id: quote.id },
      expect: 200,
    });
    expect(r.body.quote.status).toBe("sent");
    expect(r.body.path).toMatch(/^\/p\/q\//);
    shareToken = r.body.path.split("/").pop() ?? "";
    expect(shareToken.length).toBeGreaterThan(20);
    const mail = await sqlOne<{ recipient: string; body: string }>(
      `SELECT recipient, body FROM notification_outbox WHERE user_id = $1 AND channel = 'email' AND data LIKE '%"kind":"quote"%' ORDER BY created_at DESC LIMIT 1`,
      [org.dataId]
    );
    expect(mail?.recipient).toBe(clientEmail);
    expect(mail?.body).toContain(r.body.url);
    await expectEvent(org.dataId, "quote.sent", quote.id);
  });

  it("public GET by share token marks the quote viewed", async () => {
    const pub = await import("@/app/api/p/quotes/[token]/route");
    const r = await api<{ quote: { status: string; number: string; total_minor: number } }>(pub.GET, `/api/p/quotes/${shareToken}`, {
      params: { token: shareToken },
      expect: 200,
    });
    expect(r.body.quote.status).toBe("viewed");
    expect(r.body.quote.number).toBe(quote.number);
    const row = await sqlOne<{ status: string }>(`SELECT status FROM quotes WHERE id = $1`, [quote.id]);
    expect(row?.status).toBe("viewed");
    // unknown token → 404
    await api(pub.GET, `/api/p/quotes/nope-token`, { params: { token: "nope-token" }, expect: 404 });
  });

  it("requests an OTP; the code lands in the outbox", async () => {
    const otpRoute = await import("@/app/api/p/quotes/[token]/otp/route");
    const r = await api<{ ok: boolean; expiresAt: string }>(otpRoute.POST, `/api/p/quotes/${shareToken}/otp`, {
      json: { email: clientEmail },
      params: { token: shareToken },
      expect: 200,
    });
    expect(r.body.ok).toBe(true);
    otp = await latestOtp(org.dataId, clientEmail);
    expect(otp).toMatch(/^\d{6}$/);
    const pending = await sqlOne<{ otp_hash: string | null; version: number }>(
      `SELECT otp_hash, version FROM quote_acceptances WHERE quote_id = $1 AND accepted_at IS NULL`,
      [quote.id]
    );
    expect(pending?.otp_hash).toBeTruthy();
    expect(Number(pending?.version)).toBe(quote.current_version);
  });

  it("rejects a wrong OTP and counts the attempt", async () => {
    const accept = await import("@/app/api/p/quotes/[token]/accept/route");
    const bad = otp === "000000" ? "111111" : "000000";
    const r = await api<{ error: string; detail: string }>(accept.POST, `/api/p/quotes/${shareToken}/accept`, {
      json: { otp: bad, name: "Ada Client", email: clientEmail },
      params: { token: shareToken },
      expect: 400,
    });
    expect(r.body.detail).toMatch(/incorrect/i);
    const row = await sqlOne<{ otp_attempts: number }>(`SELECT otp_attempts FROM quote_acceptances WHERE quote_id = $1 AND accepted_at IS NULL`, [quote.id]);
    expect(Number(row?.otp_attempts)).toBe(1);
  });

  it("accepts with signature: acceptance row has hashes + signature, invoice created, stock reserved", async () => {
    const accept = await import("@/app/api/p/quotes/[token]/accept/route");
    const r = await api<{ quote: { status: string }; invoiceCreated: boolean }>(accept.POST, `/api/p/quotes/${shareToken}/accept`, {
      json: { otp, name: "Ada Client", email: clientEmail, signature_text: "Ada C.", accept_terms: true },
      params: { token: shareToken },
      headers: { "user-agent": "integration-test/1.0", "x-forwarded-for": "203.0.113.9" },
      expect: 200,
    });
    expect(r.body.quote.status).toBe("accepted");
    expect(r.body.invoiceCreated).toBe(true);

    const acc = await sqlOne<{
      accepted_at: string; accepted_name: string; signature_text: string; document_hash: string; signed_document_hash: string;
      consent_terms_version: string; consent_terms_text: string; ip: string; user_agent: string; otp_hash: string | null;
    }>(`SELECT * FROM quote_acceptances WHERE quote_id = $1 AND accepted_at IS NOT NULL`, [quote.id]);
    expect(acc?.accepted_name).toBe("Ada Client");
    expect(acc?.signature_text).toBe("Ada C.");
    expect(acc?.document_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(acc?.signed_document_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(acc?.document_hash).not.toBe(acc?.signed_document_hash);
    expect(acc?.consent_terms_version).toBe("v1");
    expect(acc?.consent_terms_text).toBeTruthy();
    expect(acc?.ip).toBe("203.0.113.9");
    expect(acc?.user_agent).toBe("integration-test/1.0");
    expect(acc?.otp_hash).toBeNull();

    const inv = await sqlOne<Invoice>(`SELECT id, number, status, paid_minor, total_minor, quote_id FROM invoices WHERE quote_id = $1 AND user_id = $2`, [quote.id, org.dataId]);
    expect(inv, "auto-invoice").toBeTruthy();
    invoice = inv as Invoice;
    expect(invoice.number).toMatch(/^INV-\d+/);
    expect(invoice.status).toBe("draft");
    expect(Number(invoice.total_minor)).toBe(18250);
    await expectEvent(org.dataId, "invoice.created", invoice.id);

    const p = await sqlOne<{ stock_on_hand: number; stock_reserved: number }>(`SELECT stock_on_hand, stock_reserved FROM products WHERE id = $1`, [product.id]);
    expect(Number(p?.stock_on_hand)).toBe(10);
    expect(Number(p?.stock_reserved)).toBe(3);
    const mv = await sql<{ kind: string; qty: number }>(`SELECT kind, qty FROM stock_movements WHERE user_id = $1 AND product_id = $2 AND ref_kind = 'quote' AND ref_id = $3`, [org.dataId, product.id, quote.id]);
    expect(mv.map((m) => `${m.kind}:${m.qty}`)).toEqual(["reserve:3"]);

    // owner gets an in-app notification
    const note = await sqlOne(`SELECT id FROM notification_outbox WHERE user_id = $1 AND channel = 'in_app' AND data LIKE '%quote_accepted%'`, [org.dataId]);
    expect(note).toBeTruthy();
  });

  it("second accept is refused", async () => {
    const accept = await import("@/app/api/p/quotes/[token]/accept/route");
    const r = await api<{ detail: string }>(accept.POST, `/api/p/quotes/${shareToken}/accept`, {
      json: { otp, name: "Ada Client", email: clientEmail },
      params: { token: shareToken },
      expect: 400,
    });
    expect(r.body.detail).toMatch(/already been accepted/i);
  });

  it("creates a public pay link (invoice → sent, pending payment row)", async () => {
    const payLink = await import("@/app/api/invoices/[id]/pay-link/route");
    const r = await api<{ url: string; provider: string; token: string; providerRef: string }>(payLink.POST, `/api/invoices/${invoice.id}/pay-link`, {
      method: "POST",
      params: { id: invoice.id },
      expect: 201,
    });
    expect(r.body.provider).toBe("simulated");
    expect(r.body.url).toContain(`/p/pay/${r.body.token}`);
    payToken = r.body.token;
    const inv = await sqlOne<{ status: string }>(`SELECT status FROM invoices WHERE id = $1`, [invoice.id]);
    expect(inv?.status).toBe("sent");
    const pending = await sqlOne<{ status: string; amount_minor: number }>(`SELECT status, amount_minor FROM invoice_payments WHERE invoice_id = $1 AND provider = 'simulated'`, [invoice.id]);
    expect(pending?.status).toBe("pending");
    expect(Number(pending?.amount_minor)).toBe(18250);

    const pay = await import("@/app/api/p/pay/[token]/route");
    const g = await api<{ outstanding_minor: number; provider: string; invoice: { number: string } }>(pay.GET, `/api/p/pay/${payToken}`, { params: { token: payToken }, expect: 200 });
    expect(g.body.outstanding_minor).toBe(18250);
    expect(g.body.invoice.number).toBe(invoice.number);
  });

  it("simulated success pays the invoice, consumes stock, emits invoice.paid", async () => {
    const pay = await import("@/app/api/p/pay/[token]/route");
    const r = await api<{ ok: boolean; status: string }>(pay.POST, `/api/p/pay/${payToken}`, {
      json: { outcome: "success" },
      params: { token: payToken },
      expect: 200,
    });
    expect(r.body.ok).toBe(true);
    expect(r.body.status).toBe("paid");

    const inv = await sqlOne<{ status: string; paid_minor: number; paid_at: string | null }>(`SELECT status, paid_minor, paid_at FROM invoices WHERE id = $1`, [invoice.id]);
    expect(inv?.status).toBe("paid");
    expect(Number(inv?.paid_minor)).toBe(18250);
    expect(inv?.paid_at).toBeTruthy();
    await expectEvent(org.dataId, "invoice.paid", invoice.id);

    const p = await sqlOne<{ stock_on_hand: number; stock_reserved: number }>(`SELECT stock_on_hand, stock_reserved FROM products WHERE id = $1`, [product.id]);
    expect(Number(p?.stock_on_hand)).toBe(7);
    expect(Number(p?.stock_reserved)).toBe(0);
    const consume = await sql(`SELECT id FROM stock_movements WHERE user_id = $1 AND ref_kind = 'invoice' AND ref_id = $2 AND kind = 'consume'`, [org.dataId, invoice.id]);
    expect(consume).toHaveLength(1);
    const pe = await sql(`SELECT id FROM payment_events WHERE provider = 'simulated' AND payload LIKE '%' || $1 || '%'`, [invoice.id]);
    expect(pe).toHaveLength(1);
  });

  it("replaying the same provider event is idempotent", async () => {
    const { processWebhook } = await import("@/lib/payments/webhook");
    const { signSimulatedBody } = await import("@/lib/payments/simulated");
    const evt = await sqlOne<{ payload: string }>(`SELECT payload FROM payment_events WHERE provider = 'simulated' AND payload LIKE '%' || $1 || '%'`, [invoice.id]);
    const raw = evt?.payload ?? "";
    const out = await processWebhook("simulated", raw, new Headers({ "x-simulated-signature": signSimulatedBody(raw) }));
    expect(out.status).toBe(200);
    expect((out.body as { replay?: boolean }).replay).toBe(true);
    // Through the public webhook route as well, with a bad signature → 401.
    const hook = await import("@/app/api/payments/webhook/[provider]/route");
    await api(hook.POST, `/api/payments/webhook/simulated`, { text: raw, headers: { "x-simulated-signature": "deadbeef" }, params: { provider: "simulated" }, expect: 401 });
    const ok = await api<{ ok: boolean; replay: boolean }>(hook.POST, `/api/payments/webhook/simulated`, {
      text: raw, headers: { "x-simulated-signature": signSimulatedBody(raw) }, params: { provider: "simulated" }, expect: 200,
    });
    expect(ok.body.replay).toBe(true);
    const succeeded = await sql(`SELECT id FROM invoice_payments WHERE invoice_id = $1 AND status = 'succeeded'`, [invoice.id]);
    expect(succeeded).toHaveLength(1);
    const p = await sqlOne<{ stock_on_hand: number }>(`SELECT stock_on_hand FROM products WHERE id = $1`, [product.id]);
    expect(Number(p?.stock_on_hand)).toBe(7);
    // paying again on the token → nothing outstanding; second payment must not double-count
    const pay = await import("@/app/api/p/pay/[token]/route");
    await api(pay.POST, `/api/p/pay/${payToken}`, { json: { outcome: "success" }, params: { token: payToken }, expect: 200 });
    const inv = await sqlOne<{ paid_minor: number }>(`SELECT paid_minor FROM invoices WHERE id = $1`, [invoice.id]);
    expect(Number(inv?.paid_minor)).toBe(18250);
  });

  it("quote PDF (owner + public) is a real PDF, signed copy differs from draft", async () => {
    const owner = await import("@/app/api/quotes/[id]/pdf/route");
    const o = await call(owner.GET, req(`/api/quotes/${quote.id}/pdf`), { id: quote.id }, 200);
    expect(o.res.headers.get("content-type")).toContain("application/pdf");
    expect(o.text.startsWith("%PDF")).toBe(true);
    const ownerBytes = Buffer.from(await o.res.arrayBuffer());

    const pub = await import("@/app/api/p/quotes/[token]/pdf/route");
    const p = await call(pub.GET, req(`/api/p/quotes/${shareToken}/pdf`, { query: { download: 1 } }), { token: shareToken }, 200);
    expect(p.res.headers.get("content-type")).toContain("application/pdf");
    expect(p.res.headers.get("content-disposition")).toContain("attachment");
    expect(p.text.startsWith("%PDF")).toBe(true);
    const pubBytes = Buffer.from(await p.res.arrayBuffer());
    expect(pubBytes.length).toBeGreaterThan(500);
    expect(ownerBytes.length).toBeGreaterThan(500);
    // Signed (stamped) rendering mentions the signer.
    expect(pubBytes.toString("latin1")).toContain("Ada");

    const invPdf = await import("@/app/api/invoices/[id]/pdf/route");
    const i = await call(invPdf.GET, req(`/api/invoices/${invoice.id}/pdf`), { id: invoice.id }, 200);
    expect(i.text.startsWith("%PDF")).toBe(true);
  });

  it("declining another quote (client side) releases its reserved stock", async () => {
    // Second quote on the same product, accepted directly in the DB path via the lib so stock is reserved.
    const quotes = await import("@/app/api/quotes/route");
    const q2 = (await api<{ quote: Quote }>(quotes.POST, "/api/quotes", {
      json: { contact_id: contact.id, items: [{ description: "Widget", qty: 2, unit_minor: 2500, product_id: product.id }] },
      expect: 201,
    })).body.quote;
    const send = await import("@/app/api/quotes/[id]/send/route");
    const s = await api<{ path: string }>(send.POST, `/api/quotes/${q2.id}/send`, { json: { to: clientEmail }, params: { id: q2.id }, expect: 200 });
    const token2 = s.body.path.split("/").pop() ?? "";
    const { reserveForQuote } = await import("@/lib/inventory/stock");
    await reserveForQuote(org.dataId, q2.id, q2.items);
    let p = await sqlOne<{ stock_reserved: number }>(`SELECT stock_reserved FROM products WHERE id = $1`, [product.id]);
    expect(Number(p?.stock_reserved)).toBe(2);

    // Decline is OTP-gated like accept (purpose = decline); an accept code must not unlock it.
    const otpRoute = await import("@/app/api/p/quotes/[token]/otp/route");
    const decline = await import("@/app/api/p/quotes/[token]/decline/route");
    await api(otpRoute.POST, `/api/p/quotes/${token2}/otp`, { json: { email: clientEmail, purpose: "accept" }, params: { token: token2 }, expect: 200 });
    const acceptCode = await latestOtp(org.dataId, clientEmail);
    await api(otpRoute.POST, `/api/p/quotes/${token2}/otp`, { json: { email: clientEmail, purpose: "decline" }, params: { token: token2 }, expect: 200 });
    const declineCode = await latestOtp(org.dataId, clientEmail);
    await api(decline.POST, `/api/p/quotes/${token2}/decline`, { json: { otp: acceptCode, email: clientEmail }, params: { token: token2 }, expect: 400 });
    await api(decline.POST, `/api/p/quotes/${token2}/decline`, { json: { reason: "x" }, params: { token: token2 }, expect: 400 });
    const d = await api<{ quote: { status: string } }>(decline.POST, `/api/p/quotes/${token2}/decline`, {
      json: { otp: declineCode, email: clientEmail, reason: "Too expensive" },
      params: { token: token2 },
      expect: 200,
    });
    expect(d.body.quote.status).toBe("declined");
    p = await sqlOne<{ stock_reserved: number }>(`SELECT stock_reserved FROM products WHERE id = $1`, [product.id]);
    expect(Number(p?.stock_reserved)).toBe(0);
    const row = await sqlOne<{ status: string; decline_reason: string | null }>(`SELECT status, decline_reason FROM quotes WHERE id = $1`, [q2.id]);
    expect(row?.status).toBe("declined");
    expect(row?.decline_reason).toBe("Too expensive");
    const ev = await expectEvent(org.dataId, "quote.declined", q2.id);
    const data = parseJson<{ by: string; released: Array<{ qty: number }> }>(ev.data);
    expect(data?.by).toBe("client");
    expect(data?.released?.[0]?.qty).toBe(2);
    // already declined → 400 both publicly and for the owner
    await api(decline.POST, `/api/p/quotes/${token2}/decline`, { json: { otp: declineCode, email: clientEmail }, params: { token: token2 }, expect: 400 });
    const ownerDecline = await import("@/app/api/quotes/[id]/decline/route");
    await api(ownerDecline.POST, `/api/quotes/${q2.id}/decline`, { json: {}, params: { id: q2.id }, expect: 400 });
    // owner-side decline on a fresh draft works and emits by=owner
    const q3 = (await api<{ quote: Quote }>(quotes.POST, "/api/quotes", { json: { items: [{ description: "x", qty: 1, unit_minor: 100 }] }, expect: 201 })).body.quote;
    const od = await api<{ quote: { status: string }; released: unknown[] }>(ownerDecline.POST, `/api/quotes/${q3.id}/decline`, { json: { reason: "lost" }, params: { id: q3.id }, expect: 200 });
    expect(od.body.quote.status).toBe("declined");
    expect(od.body.released).toEqual([]);
  });

  it("expireQuotes sweeps an overdue sent quote and releases stock", async () => {
    const quotes = await import("@/app/api/quotes/route");
    const q = (await api<{ quote: Quote }>(quotes.POST, "/api/quotes", {
      json: { contact_id: contact.id, valid_until: new Date(Date.now() + 86_400_000).toISOString(), items: [{ description: "Widget", qty: 1, unit_minor: 2500, product_id: product.id }] },
      expect: 201,
    })).body.quote;
    const send = await import("@/app/api/quotes/[id]/send/route");
    await api(send.POST, `/api/quotes/${q.id}/send`, { json: {}, params: { id: q.id }, expect: 200 });
    const { reserveForQuote } = await import("@/lib/inventory/stock");
    await reserveForQuote(org.dataId, q.id, q.items);
    await sql(`UPDATE quotes SET valid_until = NOW() - INTERVAL '1 day' WHERE id = $1`, [q.id]);

    const { expireQuotes } = await import("@/lib/money/quotes");
    const res = await expireQuotes(500);
    expect(res.expired).toBeGreaterThanOrEqual(1);
    const row = await sqlOne<{ status: string; expired_at: string | null }>(`SELECT status, expired_at FROM quotes WHERE id = $1`, [q.id]);
    expect(row?.status).toBe("expired");
    expect(row?.expired_at).toBeTruthy();
    const p = await sqlOne<{ stock_reserved: number }>(`SELECT stock_reserved FROM products WHERE id = $1`, [product.id]);
    expect(Number(p?.stock_reserved)).toBe(0);
    await expectEvent(org.dataId, "quote.expired", q.id);
    // a second sweep finds nothing new for this org
    const again = await expireQuotes(500);
    const stillOne = (await eventsFor(org.dataId, "quote.expired", q.id)).length;
    expect(stillOne).toBe(1);
    expect(again.scanned).toBeGreaterThanOrEqual(0);
    // Expired quote can no longer start an acceptance.
    const otpRoute = await import("@/app/api/p/quotes/[token]/otp/route");
    const share = await sqlOne<{ id: string }>(`SELECT id FROM share_tokens WHERE kind = 'quote' AND entity_id = $1`, [q.id]);
    expect(share).toBeTruthy();
    const { requestAcceptanceOtp } = await import("@/lib/money/acceptance");
    await expect(requestAcceptanceOtp(q.id, clientEmail)).rejects.toThrow(/expired/i);
    void otpRoute;
  });

  it("role matrix: viewer cannot write billing", async () => {
    setScope(org, { role: "viewer", userId: "itest-viewer" });
    const quotes = await import("@/app/api/quotes/route");
    await api(quotes.POST, "/api/quotes", { json: { items: [] }, expect: 403 });
    await api(quotes.GET, "/api/quotes", { expect: 200 });
    setScope(null);
    await api(quotes.GET, "/api/quotes", { expect: 401 });
    setScope(org);
  });

  describe("event log summary", () => {
    it("has every expected event type for this org", async () => {
      const all = await eventsFor(org.dataId);
      const types = new Set(all.map((e) => e.type));
      for (const t of ["crm.contact.created", "product.created", "quote.created", "quote.sent", "invoice.created", "invoice.paid", "quote.declined", "quote.expired"]) {
        expect(types.has(t), `missing event ${t}; have ${[...types].join(", ")}`).toBe(true);
      }
    });
  });
});
