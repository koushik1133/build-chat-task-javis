/**
 * Documents end-to-end: starter templates → document from a contact (merge
 * fields) → send to 2 signers in order → signer 1 OTP + sign → signer 2 blocked
 * until 1 → signer 2 signs → signed PDF attached + hashes → decline path on a
 * second document → expiry sweep → attachment upload (local fallback) → portal
 * lists files + documents → DSR export includes attachment metadata → API v1.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { api, call, cleanupDataIds, createTestOrg, describeDb, expectEvent, req, setScope, sql, sqlOne, type TestOrg } from "./setup";
import type { DocumentDTO, DocumentTemplateDTO, PublicDocument } from "@/lib/documents/types";
import type { AttachmentDTO } from "@/lib/attachments/types";

vi.mock("@/lib/auth/scope", () => import("./setup").then((m) => m.scopeMockFactory()));
vi.mock("@/lib/supabase/server", () => import("./setup").then((m) => m.supabaseMockFactory()));

const localDir = mkdtempSync(join(tmpdir(), "kh-attachments-"));
process.env.ATTACHMENTS_LOCAL_DIR = localDir;

interface Contact { id: string; full_name: string; email: string | null }

async function latestMail(dataId: string, recipient: string, kindMarker: string): Promise<{ body: string; data: string }> {
  const mail = await sqlOne<{ body: string; data: string }>(
    `SELECT body, data FROM notification_outbox WHERE user_id = $1 AND recipient = $2 AND data LIKE $3 ORDER BY created_at DESC, id DESC LIMIT 1`,
    [dataId, recipient, `%${kindMarker}%`]
  );
  if (!mail) throw new Error(`no ${kindMarker} email for ${recipient}`);
  return mail;
}
async function otpFor(dataId: string, email: string): Promise<string> {
  const m = (await latestMail(dataId, email, "document_otp")).body.match(/is:\s*(\d{6})/);
  if (!m) throw new Error("no OTP in email");
  return m[1];
}
async function signTokenFor(dataId: string, email: string): Promise<string> {
  const m = (await latestMail(dataId, email, "document_sign")).body.match(/\/p\/sign\/([A-Za-z0-9_-]+)/);
  if (!m) throw new Error("no signing link in email");
  return m[1];
}

describeDb("documents flow", () => {
  let org: TestOrg;
  let contact: Contact;
  let template: DocumentTemplateDTO;
  let doc: DocumentDTO;
  let declineDoc: DocumentDTO;
  let token1: string;
  let token2: string;
  let attachment: AttachmentDTO;
  let portalToken: string;
  const signer1 = "ada@example.test";
  const signer2 = "bob@example.test";

  beforeAll(async () => {
    org = await createTestOrg("documents");
    setScope(org);
  });
  afterAll(async () => {
    await cleanupDataIds([org.dataId]);
    rmSync(localDir, { recursive: true, force: true });
  });

  it("installs the starter templates idempotently", async () => {
    const route = await import("@/app/api/document-templates/route");
    const first = await api<{ installed: DocumentTemplateDTO[]; skipped: string[] }>(route.POST, "/api/document-templates", { json: { install: "starters" }, expect: 201 });
    expect(first.body.installed.length).toBe(5);
    const again = await api<{ installed: DocumentTemplateDTO[]; skipped: string[] }>(route.POST, "/api/document-templates", { json: { install: "starters" }, expect: 201 });
    expect(again.body.installed.length).toBe(0);
    expect(again.body.skipped.length).toBe(5);
    const list = await api<{ templates: DocumentTemplateDTO[]; starters: Array<{ installed: boolean }> }>(route.GET, "/api/document-templates", { expect: 200 });
    template = list.body.templates.find((t) => t.starter_slug === "service-agreement")!;
    expect(template).toBeTruthy();
    expect(list.body.starters.every((s) => s.installed)).toBe(true);
  });

  it("creates a document from the template with contact + org merge fields rendered and escaped", async () => {
    const contacts = await import("@/app/api/crm/contacts/route");
    const c = await api<{ contact: Contact }>(contacts.POST, "/api/crm/contacts", { json: { full_name: "Ada Client", email: signer1, company: "Client Co" }, expect: 201 });
    contact = c.body.contact;
    const route = await import("@/app/api/documents/route");
    const r = await api<{ document: DocumentDTO }>(route.POST, "/api/documents", {
      json: {
        template_id: template.id,
        contact_id: contact.id,
        signing_order: "sequential",
        merge_data: { service_description: "# Not a heading\nMonthly **retainer** work", fee: "$2,500 per month", start_date: "2026-12-01", notice_days: "30" },
        signers: [
          { name: "Ada Client", email: signer1, role: "client" },
          { name: "Bob Provider", email: signer2, role: "provider" },
        ],
      },
      expect: 201,
    });
    doc = r.body.document;
    expect(doc.status).toBe("draft");
    expect(doc.body_md).toContain("**Ada Client** of Client Co");
    expect(doc.body_md).toContain(`**${org.name}**`);
    expect(doc.body_md).toContain("\\# Not a heading");
    expect(doc.body_md).toContain("\\*\\*retainer\\*\\*");
    expect(doc.body_md).not.toContain("{{");
    expect(doc.signers.map((s) => s.email)).toEqual([signer1, signer2]);
    expect(doc.merge_data["contact.email"]).toBe(signer1);
  });

  it("rejects a document missing required fields", async () => {
    const route = await import("@/app/api/documents/route");
    const r = await api<{ error: string; detail: string }>(route.POST, "/api/documents", { json: { template_id: template.id, merge_data: {} }, expect: 400 });
    expect(r.body.detail).toMatch(/Missing required fields/);
  });

  it("sends for signature: frozen hash, sequential → only signer 1 emailed, event emitted", async () => {
    const send = await import("@/app/api/documents/[id]/send/route");
    const r = await api<{ document: DocumentDTO; notified: Array<{ email: string; url: string }> }>(send.POST, `/api/documents/${doc.id}/send`, { json: { message: "Please sign" }, params: { id: doc.id }, expect: 200 });
    expect(r.body.document.status).toBe("sent");
    expect(r.body.document.pdf_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.body.notified.map((n) => n.email)).toEqual([signer1]);
    doc = r.body.document;
    token1 = await signTokenFor(org.dataId, signer1);
    expect(token1.length).toBeGreaterThan(20);
    await expectEvent(org.dataId, "document.sent", doc.id);
    // Body is frozen now.
    const patch = await import("@/app/api/documents/[id]/route");
    await api(patch.PATCH, `/api/documents/${doc.id}`, { method: "PATCH", json: { title: "Nope" }, params: { id: doc.id }, expect: 400 });
  });

  it("signer 1 opens the link (viewed), requests OTP, is bound to their email, signs", async () => {
    const pub = await import("@/app/api/p/sign/[token]/route");
    const g = await api<{ document: PublicDocument }>(pub.GET, `/api/p/sign/${token1}`, { params: { token: token1 }, expect: 200 });
    expect(g.body.document.status).toBe("viewed");
    expect(g.body.document.your_turn).toBe(true);
    expect(g.body.document.signer.email_hint).not.toBe(signer1);
    expect(g.body.document.others[0].name).toBe("Bob Provider");
    await expectEvent(org.dataId, "document.viewed", doc.id);

    const otp = await import("@/app/api/p/sign/[token]/otp/route");
    const wrong = await api<{ detail: string }>(otp.POST, `/api/p/sign/${token1}/otp`, { json: { email: "stranger@example.test" }, params: { token: token1 }, expect: 400 });
    expect(wrong.body.detail).toMatch(/different email/);
    await api(otp.POST, `/api/p/sign/${token1}/otp`, { json: { email: signer1 }, params: { token: token1 }, expect: 200 });
    const code = await otpFor(org.dataId, signer1);

    const sign = await import("@/app/api/p/sign/[token]/sign/route");
    const bad = await api<{ detail: string }>(sign.POST, `/api/p/sign/${token1}/sign`, { json: { otp: code === "000000" ? "000001" : "000000", email: signer1, signature_text: "Ada Client", consent: true }, params: { token: token1 }, expect: 400 });
    expect(bad.body.detail).toMatch(/Incorrect/);
    const ok = await api<{ document: PublicDocument; completed: boolean }>(sign.POST, `/api/p/sign/${token1}/sign`, {
      json: { otp: code, email: signer1, signature_text: "Ada Client", consent: true },
      params: { token: token1 },
      headers: { "x-forwarded-for": "203.0.113.9", "user-agent": "itest-agent" },
      expect: 200,
    });
    expect(ok.body.completed).toBe(false);
    expect(ok.body.document.signer.status).toBe("signed");
    // Code consumed: replay fails.
    await api(sign.POST, `/api/p/sign/${token1}/sign`, { json: { otp: code, email: signer1, signature_text: "Ada", consent: true }, params: { token: token1 }, expect: 400 });
  });

  it("signer 2 was blocked until signer 1 signed, then gets their link and signs → document signed, PDF attached, hashes stored", async () => {
    token2 = await signTokenFor(org.dataId, signer2);
    expect(token2).not.toBe(token1);
    const pub = await import("@/app/api/p/sign/[token]/route");
    const g = await api<{ document: PublicDocument }>(pub.GET, `/api/p/sign/${token2}`, { params: { token: token2 }, expect: 200 });
    expect(g.body.document.your_turn).toBe(true);
    expect(g.body.document.others[0].status).toBe("signed");

    const otp = await import("@/app/api/p/sign/[token]/otp/route");
    await api(otp.POST, `/api/p/sign/${token2}/otp`, { json: { email: signer2 }, params: { token: token2 }, expect: 200 });
    const code = await otpFor(org.dataId, signer2);
    const sign = await import("@/app/api/p/sign/[token]/sign/route");
    const ok = await api<{ document: PublicDocument; completed: boolean }>(sign.POST, `/api/p/sign/${token2}/sign`, { json: { otp: code, email: signer2, signature_text: "B. Provider", consent: true }, params: { token: token2 }, expect: 200 });
    expect(ok.body.completed).toBe(true);
    expect(ok.body.document.status).toBe("signed");
    expect(ok.body.document.signed_pdf_hash).toMatch(/^[0-9a-f]{64}$/);
    await expectEvent(org.dataId, "document.signed", doc.id);

    const get = await import("@/app/api/documents/[id]/route");
    const d = await api<{ document: DocumentDTO }>(get.GET, `/api/documents/${doc.id}`, { params: { id: doc.id }, expect: 200 });
    expect(d.body.document.status).toBe("signed");
    expect(d.body.document.signers.every((s) => s.status === "signed")).toBe(true);
    expect(d.body.document.signed_pdf_hash).not.toBe(d.body.document.pdf_hash);

    // Signed PDF attached to the document and the contact (portal-visible).
    const att = await import("@/app/api/attachments/route");
    const onDoc = await api<{ attachments: AttachmentDTO[] }>(att.GET, `/api/attachments`, { query: { entity_kind: "document", entity_id: doc.id }, expect: 200 });
    expect(onDoc.body.attachments.length).toBe(1);
    expect(onDoc.body.attachments[0].content_type).toBe("application/pdf");
    expect(onDoc.body.attachments[0].visibility).toBe("portal");
    const onContact = await api<{ attachments: AttachmentDTO[] }>(att.GET, `/api/attachments`, { query: { entity_kind: "contact", entity_id: contact.id }, expect: 200 });
    expect(onContact.body.attachments.some((a) => a.file_name.endsWith("-signed.pdf"))).toBe(true);

    // Owner PDF carries evidence; the public signer copy is redacted.
    const pdf = await import("@/app/api/documents/[id]/pdf/route");
    const ownerPdf = await call(pdf.GET, req(`/api/documents/${doc.id}/pdf`), { id: doc.id }, 200);
    expect(ownerPdf.res.headers.get("content-type")).toBe("application/pdf");
    expect(ownerPdf.text).toContain("203.0.113.9");
    const pubPdf = await import("@/app/api/p/sign/[token]/pdf/route");
    const signerPdf = await call(pubPdf.GET, req(`/api/p/sign/${token2}/pdf`), { token: token2 }, 200);
    expect(signerPdf.text).not.toContain("203.0.113.9");
    expect(signerPdf.text).toContain("IP and device recorded");
    // Signer evidence is stored.
    const signers = await import("@/app/api/documents/[id]/signers/route");
    const ev = await api<{ signers: Array<{ ip: string | null; consent_text: string | null; signature_text: string | null }> }>(signers.GET, `/api/documents/${doc.id}/signers`, { params: { id: doc.id }, expect: 200 });
    expect(ev.body.signers[0].ip).toBe("203.0.113.9");
    expect(ev.body.signers[0].consent_text).toBeTruthy();
    expect(ev.body.signers[1].signature_text).toBe("B. Provider");
  });

  it("decline path: OTP purpose is enforced and the document becomes declined", async () => {
    const route = await import("@/app/api/documents/route");
    const r = await api<{ document: DocumentDTO }>(route.POST, "/api/documents", {
      json: { title: "Side letter", kind: "letter", body_md: "# Side letter\n\nHello {{contact.full_name}}.", contact_id: contact.id, signers: [{ name: "Ada Client", email: signer1 }] },
      expect: 201,
    });
    declineDoc = r.body.document;
    expect(declineDoc.body_md).toContain("Hello Ada Client.");
    const send = await import("@/app/api/documents/[id]/send/route");
    await api(send.POST, `/api/documents/${declineDoc.id}/send`, { json: {}, params: { id: declineDoc.id }, expect: 200 });
    const token = await signTokenFor(org.dataId, signer1);
    const otp = await import("@/app/api/p/sign/[token]/otp/route");
    await api(otp.POST, `/api/p/sign/${token}/otp`, { json: { email: signer1, purpose: "sign" }, params: { token }, expect: 200 });
    const signCode = await otpFor(org.dataId, signer1);
    const decline = await import("@/app/api/p/sign/[token]/decline/route");
    // A "sign" code cannot be replayed to decline.
    const wrong = await api<{ detail: string }>(decline.POST, `/api/p/sign/${token}/decline`, { json: { otp: signCode, email: signer1, reason: "no" }, params: { token }, expect: 400 });
    expect(wrong.body.detail).toMatch(/Incorrect/);
    await api(otp.POST, `/api/p/sign/${token}/otp`, { json: { email: signer1, purpose: "decline" }, params: { token }, expect: 200 });
    const declineCode = await otpFor(org.dataId, signer1);
    const out = await api<{ document: PublicDocument }>(decline.POST, `/api/p/sign/${token}/decline`, { json: { otp: declineCode, email: signer1, reason: "Terms changed" }, params: { token }, expect: 200 });
    expect(out.body.document.status).toBe("declined");
    await expectEvent(org.dataId, "document.declined", declineDoc.id);
    // Signing after decline is refused.
    const sign = await import("@/app/api/p/sign/[token]/sign/route");
    await api(sign.POST, `/api/p/sign/${token}/sign`, { json: { otp: declineCode, email: signer1, signature_text: "Ada", consent: true }, params: { token }, expect: 400 });
  });

  it("void revokes signing links; expiry sweep expires overdue documents", async () => {
    const route = await import("@/app/api/documents/route");
    const r = await api<{ document: DocumentDTO }>(route.POST, "/api/documents", { json: { title: "Old offer", kind: "proposal", body_md: "# Offer", signers: [{ name: "Ada", email: signer1 }] }, expect: 201 });
    const send = await import("@/app/api/documents/[id]/send/route");
    await api(send.POST, `/api/documents/${r.body.document.id}/send`, { json: {}, params: { id: r.body.document.id }, expect: 200 });
    await sql(`UPDATE documents SET expires_at = NOW() - INTERVAL '1 day' WHERE id = $1`, [r.body.document.id]);
    const { expireDocuments } = await import("@/lib/documents/documents");
    const swept = await expireDocuments(50);
    expect(swept.expired).toBeGreaterThanOrEqual(1);
    const row = await sqlOne<{ status: string }>(`SELECT status FROM documents WHERE id = $1`, [r.body.document.id]);
    expect(row?.status).toBe("expired");
    await expectEvent(org.dataId, "document.expired", r.body.document.id);
    const token = await signTokenFor(org.dataId, signer1);
    const pub = await import("@/app/api/p/sign/[token]/route");
    const g = await api<{ document: PublicDocument }>(pub.GET, `/api/p/sign/${token}`, { params: { token }, expect: 200 });
    expect(g.body.document.status).toBe("expired");
    expect(g.body.document.your_turn).toBe(false);

    // Void a fresh sent document → token 404s.
    const v = await api<{ document: DocumentDTO }>(route.POST, "/api/documents", { json: { title: "To void", kind: "other", body_md: "x", signers: [{ name: "Ada", email: signer1 }] }, expect: 201 });
    await api(send.POST, `/api/documents/${v.body.document.id}/send`, { json: {}, params: { id: v.body.document.id }, expect: 200 });
    const vt = await signTokenFor(org.dataId, signer1);
    const voidRoute = await import("@/app/api/documents/[id]/void/route");
    const voided = await api<{ document: DocumentDTO }>(voidRoute.POST, `/api/documents/${v.body.document.id}/void`, { json: {}, params: { id: v.body.document.id }, expect: 200 });
    expect(voided.body.document.status).toBe("void");
    await api(pub.GET, `/api/p/sign/${vt}`, { params: { token: vt }, expect: 404 });
    await api(pub.GET, `/api/p/sign/not-a-real-token`, { params: { token: "not-a-real-token" }, expect: 404 });
  });

  it("uploads an attachment to the contact (local fallback), validates type/size, downloads and soft-deletes", async () => {
    const route = await import("@/app/api/attachments/route");
    const form = new FormData();
    form.set("file", new File([Buffer.from("name,amount\nAda,5\n")], "ledger.csv", { type: "text/csv" }));
    form.set("entity_kind", "contact");
    form.set("entity_id", contact.id);
    form.set("visibility", "portal");
    const up = await call<{ attachment: AttachmentDTO }>(route.POST, new NextRequest(`http://localhost:3001/api/attachments`, { method: "POST", body: form }), {}, 201);
    attachment = up.body.attachment;
    expect(attachment.content_type).toBe("text/csv");
    expect(attachment.sha256).toMatch(/^[0-9a-f]{64}$/);
    await expectEvent(org.dataId, "attachment.added", contact.id);

    const bad = new FormData();
    bad.set("file", new File([Buffer.from("MZ...")], "evil.exe", { type: "application/x-msdownload" }));
    bad.set("entity_kind", "contact");
    bad.set("entity_id", contact.id);
    await call(route.POST, new NextRequest(`http://localhost:3001/api/attachments`, { method: "POST", body: bad }), {}, 415);

    const fakePng = new FormData();
    fakePng.set("file", new File([Buffer.from("<svg onload=alert(1)>")], "x.png", { type: "image/png" }));
    fakePng.set("entity_kind", "contact");
    fakePng.set("entity_id", contact.id);
    await call(route.POST, new NextRequest(`http://localhost:3001/api/attachments`, { method: "POST", body: fakePng }), {}, 415);

    const missing = new FormData();
    missing.set("file", new File([Buffer.from("x")], "a.txt", { type: "text/plain" }));
    missing.set("entity_kind", "quote");
    missing.set("entity_id", "nope");
    await call(route.POST, new NextRequest(`http://localhost:3001/api/attachments`, { method: "POST", body: missing }), {}, 404);

    const one = await import("@/app/api/attachments/[id]/route");
    const dl = await call(one.GET, req(`/api/attachments/${attachment.id}`), { id: attachment.id }, 200);
    expect(dl.text).toContain("name,amount");
    expect(dl.res.headers.get("x-attachment-sha256")).toBe(attachment.sha256);

    // Viewer role cannot delete.
    setScope(org, { role: "viewer", userId: "itest-viewer" });
    await api(one.DELETE, `/api/attachments/${attachment.id}`, { method: "DELETE", params: { id: attachment.id }, expect: 403 });
    setScope(org);
  });

  it("portal lists portal-visible files and the contact's documents", async () => {
    const { issueShareToken } = await import("@/lib/share-tokens");
    portalToken = (await issueShareToken(org.dataId, "portal", contact.id, 1)).token;
    const files = await import("@/app/api/p/portal/[token]/attachments/route");
    const f = await api<{ attachments: AttachmentDTO[] }>(files.GET, `/api/p/portal/${portalToken}/attachments`, { params: { token: portalToken }, expect: 200 });
    expect(f.body.attachments.some((a) => a.id === attachment.id)).toBe(true);
    expect(f.body.attachments.some((a) => a.entity_kind === "document")).toBe(true);
    expect(f.body.attachments.every((a) => a.visibility === "portal")).toBe(true);
    const dl = await call(files.GET, req(`/api/p/portal/${portalToken}/attachments`, { query: { id: attachment.id } }), { token: portalToken }, 200);
    expect(dl.text).toContain("name,amount");
    await call(files.GET, req(`/api/p/portal/${portalToken}/attachments`, { query: { id: "not-mine" } }), { token: portalToken }, 404);

    const docs = await import("@/app/api/p/portal/[token]/documents/route");
    const d = await api<{ documents: Array<{ id: string; status: string }> }>(docs.GET, `/api/p/portal/${portalToken}/documents`, { params: { token: portalToken }, expect: 200 });
    expect(d.body.documents.find((x) => x.id === doc.id)?.status).toBe("signed");
    expect(d.body.documents.find((x) => x.id === declineDoc.id)?.status).toBe("declined");
  });

  it("DSR export includes attachment metadata and documents; erasure removes the files", async () => {
    const { buildSubjectExport, eraseSubject } = await import("@/lib/privacy/dsr");
    const bundle = await buildSubjectExport(org.dataId, { kind: "contact", id: contact.id });
    expect(bundle.attachments.some((a) => a.id === attachment.id && a.sha256 === attachment.sha256)).toBe(true);
    expect(bundle.attachments.every((a) => !("storage_path" in a))).toBe(true);
    expect(bundle.documents.some((d) => d.id === doc.id)).toBe(true);

    // Internal attachment too (not portal) so erasure covers both visibilities.
    const att = await import("@/app/api/attachments/route");
    const form = new FormData();
    form.set("file", new File([Buffer.from("%PDF-1.4\n%fake\n")], "note.pdf", { type: "application/pdf" }));
    form.set("entity_kind", "contact");
    form.set("entity_id", contact.id);
    await call(att.POST, new NextRequest(`http://localhost:3001/api/attachments`, { method: "POST", body: form }), {}, 201);

    const result = await eraseSubject(org.dataId, { kind: "contact", id: contact.id }, { mode: "anonymize" });
    expect(result.affected.attachments).toBeGreaterThanOrEqual(3);
    const left = await sql(`SELECT id FROM attachments WHERE user_id = $1 AND entity_kind = 'contact' AND entity_id = $2`, [org.dataId, contact.id]);
    expect(left.length).toBe(0);
    const one = await import("@/app/api/attachments/[id]/route");
    await api(one.GET, `/api/attachments/${attachment.id}`, { params: { id: attachment.id }, expect: 404 });
    const signers = await sql<{ email: string; ip: string | null }>(`SELECT email, ip FROM document_signers WHERE document_id = $1 ORDER BY order_index`, [doc.id]);
    expect(signers[0].email).toBe("");
    expect(signers[0].ip).toBeNull();
    expect(signers[1].email).toBe(signer2);
  });

  it("API v1 lists/gets/creates/sends documents through the registry; tools are registered", async () => {
    const keys = await import("@/app/api/api-keys/route");
    const k = await api<{ key: string }>(keys.POST, "/api/api-keys", { json: { name: "docs", scopes: ["read:crm", "write:crm"] }, expect: 201 });
    const bearer = { authorization: `Bearer ${k.body.key}` };
    const list = await import("@/app/api/v1/documents/route");
    await api(list.GET, "/api/v1/documents", { expect: 401 });
    const l = await api<{ data: DocumentDTO[] }>(list.GET, "/api/v1/documents", { headers: bearer, query: { status: "signed" }, expect: 200 });
    expect(l.body.data.map((d) => d.id)).toContain(doc.id);
    const created = await api<{ data: DocumentDTO }>(list.POST, "/api/v1/documents", {
      headers: bearer,
      json: { template_id: template.id, title: "Via API", merge_data: { service_description: "API work", fee: "$1", start_date: "2026-12-01", notice_days: "7", "contact.full_name": "API Client" }, signers: [{ name: "API Client", email: "api@example.test" }] },
      expect: 201,
    });
    expect(created.body.data.status).toBe("draft");
    expect(created.body.data.body_md).toContain("API Client");
    const one = await import("@/app/api/v1/documents/[id]/route");
    const g = await api<{ data: DocumentDTO }>(one.GET, `/api/v1/documents/${created.body.data.id}`, { headers: bearer, params: { id: created.body.data.id }, expect: 200 });
    expect(g.body.data.signers[0].email).toBe("api@example.test");
    const send = await import("@/app/api/v1/documents/[id]/send/route");
    const sent = await api<{ data: DocumentDTO & { notified: Array<{ email: string }> } }>(send.POST, `/api/v1/documents/${created.body.data.id}/send`, { headers: bearer, json: {}, params: { id: created.body.data.id }, expect: 200 });
    expect(sent.body.data.status).toBe("sent");
    expect(sent.body.data.notified[0].email).toBe("api@example.test");
    await api(one.GET, `/api/v1/documents/does-not-exist`, { headers: bearer, params: { id: "does-not-exist" }, expect: 404 });
    const tpl = await import("@/app/api/v1/document-templates/route");
    const t = await api<{ data: DocumentTemplateDTO[] }>(tpl.GET, "/api/v1/document-templates", { headers: bearer, expect: 200 });
    expect(t.body.data.length).toBe(5);

    const { getTool } = await import("@/lib/agents/registry");
    const { ensureToolsLoaded } = await import("@/lib/agents/tools");
    ensureToolsLoaded();
    for (const name of ["documents.create_from_template", "documents.send", "documents.status"]) expect(getTool(name), name).toBeTruthy();
  });
});
