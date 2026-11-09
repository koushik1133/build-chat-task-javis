/**
 * Privacy (consent ledger, notices, retention, DSR verify/export/erase) and
 * mail (simulated mailbox connect → simulate inbound → sync → disconnect).
 * Each half is skipped with a note when its lane's tables are not present.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { api, call, cleanupDataIds, createTestOrg, describeDb, req, setScope, sql, sqlOne, tableExists, type TestOrg } from "./setup";

vi.mock("@/lib/auth/scope", () => import("./setup").then((m) => m.scopeMockFactory()));
vi.mock("@/lib/supabase/server", () => import("./setup").then((m) => m.supabaseMockFactory()));

const PRIVACY_TABLES = ["consent_records", "privacy_notices", "dsr_requests", "retention_policies"];
const MAIL_TABLES = ["mail_accounts", "mail_messages"];

async function allExist(names: string[]): Promise<boolean> {
  for (const n of names) if (!(await tableExists(n))) return false;
  return true;
}

describeDb("privacy + mail flow", () => {
  let org: TestOrg;
  let hasPrivacy = false;
  let hasMail = false;

  beforeAll(async () => {
    org = await createTestOrg("privacy-mail");
    setScope(org);
    hasPrivacy = await allExist(PRIVACY_TABLES);
    hasMail = await allExist(MAIL_TABLES);
    if (!hasPrivacy) console.warn(`[integration] privacy tables missing (${PRIVACY_TABLES.join(", ")}) — privacy flow skipped; apply aws/phase5/d.sql`);
    if (!hasMail) console.warn(`[integration] mail tables missing (${MAIL_TABLES.join(", ")}) — mail flow skipped; apply the Phase 4 mail migration`);
  });
  afterAll(async () => {
    await cleanupDataIds([org.dataId]);
  });

  describe("privacy", () => {
    let contactId: string;
    let requestId: string;
    const email = "subject@example.test";

    it("consent ledger: grant, withdraw, history; current state follows the latest row", async (ctx) => {
      if (!hasPrivacy) return ctx.skip();
      const contacts = await import("@/app/api/crm/contacts/route");
      contactId = (await api<{ contact: { id: string } }>(contacts.POST, "/api/crm/contacts", { json: { full_name: "Data Subject", email, phone: "+15550123" }, expect: 201 })).body.contact.id;
      const consents = await import("@/app/api/privacy/consents/route");
      const g = await api<{ consent: { status: string; purpose: string; source: string } }>(consents.POST, "/api/privacy/consents", {
        json: { subject_kind: "contact", subject_id: contactId, purpose: "marketing_email", status: "granted", note: "Signed up at the fair" }, expect: 201,
      });
      expect(g.body.consent).toMatchObject({ status: "granted", purpose: "marketing_email", source: "manual" });
      await api(consents.POST, "/api/privacy/consents", { json: { subject_kind: "contact", subject_id: contactId, purpose: "mind_control", status: "granted" }, expect: 400 });
      const cur = await api<{ current: Record<string, { status: string }>; history: unknown[] }>(consents.GET, "/api/privacy/consents", { query: { subject_kind: "contact", subject_id: contactId }, expect: 200 });
      expect(cur.body.current.marketing_email?.status).toBe("granted");
      expect(cur.body.history).toHaveLength(1);
      await api(consents.POST, "/api/privacy/consents", { json: { subject_kind: "contact", subject_id: contactId, purpose: "marketing_email", status: "withdrawn" }, expect: 201 });
      const after = await api<{ current: Record<string, { status: string }>; history: unknown[] }>(consents.GET, "/api/privacy/consents", { query: { subject_kind: "contact", subject_id: contactId }, expect: 200 });
      expect(after.body.current.marketing_email?.status).toBe("withdrawn");
      expect(after.body.history).toHaveLength(2);
      expect(await sql(`SELECT id FROM consent_records WHERE user_id = $1 AND subject_id = $2`, [org.dataId, contactId])).toHaveLength(2);
      const { canSendMarketing } = await import("@/lib/privacy/consent");
      const decision = await canSendMarketing(org.dataId, contactId, "email");
      expect(decision.allowed).toBe(false);
      const search = await api<{ contacts: Array<{ id: string; consent: Record<string, { status: string }> }> }>(consents.GET, "/api/privacy/consents", { query: { q: "Data Subject" }, expect: 200 });
      expect(search.body.contacts.find((c) => c.id === contactId)?.consent.marketing_email?.status).toBe("withdrawn");
    });

    it("notices publish immutable versions; retention policies clamp to the statutory floor", async (ctx) => {
      if (!hasPrivacy) return ctx.skip();
      const notices = await import("@/app/api/privacy/notices/route");
      const n1 = await api<{ notice: { version: number; locale: string } }>(notices.POST, "/api/privacy/notices", { json: { locale: "en", body_md: "# Privacy notice\n\nWe keep your data safe and only as long as needed." }, expect: 201 });
      const n2 = await api<{ notice: { version: number } }>(notices.POST, "/api/privacy/notices", { json: { locale: "en", body_md: "# Privacy notice v2\n\nWe keep your data safe, only as long as needed, and tell you when it changes." }, expect: 201 });
      expect(n1.body.notice.version).toBe(1);
      expect(n2.body.notice.version).toBe(2);
      await api(notices.POST, "/api/privacy/notices", { json: { locale: "fr", body_md: "x".repeat(30) }, expect: 400 });
      const list = await api<{ notices: Array<{ version: number; locale: string }>; slug: string }>(notices.GET, "/api/privacy/notices", { expect: 200 });
      expect(list.body.notices.filter((n) => n.locale === "en").map((n) => n.version)).toEqual([2, 1]);
      expect(list.body.slug).toBe(org.slug);

      const retention = await import("@/app/api/privacy/retention/route");
      const clamped = await api<{ policy: { entity_kind: string; keep_days: number; action: string; enabled: boolean } }>(retention.PUT, "/api/privacy/retention", { method: "PUT", json: { entity_kind: "audit_log", keep_days: 30, action: "archive", enabled: true }, expect: 200 });
      expect(clamped.body.policy.keep_days).toBeGreaterThanOrEqual(365); // statutory floor
      const upd = await api<{ policy: { keep_days: number } }>(retention.PUT, "/api/privacy/retention", { method: "PUT", json: { entity_kind: "audit_log", keep_days: 1500, action: "archive", enabled: false }, expect: 200 });
      expect(upd.body.policy.keep_days).toBe(1500);
      expect(await sql(`SELECT id FROM retention_policies WHERE user_id = $1 AND entity_kind = 'audit_log'`, [org.dataId])).toHaveLength(1);
      const g = await api<{ policies: Array<{ entity_kind: string }>; never: string[] }>(retention.GET, "/api/privacy/retention", { expect: 200 });
      expect(g.body.policies.map((p) => p.entity_kind)).toContain("audit_log");
      expect(g.body.never).toContain("invoices");
      await api(retention.PUT, "/api/privacy/retention", { method: "PUT", json: { entity_kind: "invoices", keep_days: 1, action: "delete", enabled: true }, expect: 400 });
    });

    it("DSR: open → OTP verify (from outbox) → export bundle → anonymize erases PII and completes the request", async (ctx) => {
      if (!hasPrivacy) return ctx.skip();
      const requests = await import("@/app/api/privacy/requests/route");
      const r = await api<{ request: { id: string; status: string; kind: string; subject_email: string | null; due_at?: string | null } }>(requests.POST, "/api/privacy/requests", {
        json: { subject_kind: "contact", subject_id: contactId, kind: "erasure", notes: "Asked by phone" }, expect: 201,
      });
      requestId = r.body.request.id;
      expect(r.body.request.status).toBe("received");
      expect(r.body.request.subject_email).toBe(email);
      const open = await api<{ requests: Array<{ id: string }> }>(requests.GET, "/api/privacy/requests", { query: { status: "open" }, expect: 200 });
      expect(open.body.requests.map((x) => x.id)).toContain(requestId);

      const erase = await import("@/app/api/privacy/requests/[id]/erase/route");
      await api(erase.POST, `/api/privacy/requests/${requestId}/erase`, { json: { mode: "anonymize" }, params: { id: requestId }, expect: 409 }); // not verified yet

      const verify = await import("@/app/api/privacy/requests/[id]/verify/route");
      const sent = await api<{ sent: boolean; expiresAt: string }>(verify.POST, `/api/privacy/requests/${requestId}/verify`, { json: {}, params: { id: requestId }, expect: 200 });
      expect(sent.body.sent).toBe(true);
      const mail = await sqlOne<{ body: string }>(`SELECT body FROM notification_outbox WHERE user_id = $1 AND recipient = $2 AND data LIKE '%dsr_otp%' ORDER BY created_at DESC LIMIT 1`, [org.dataId, email]);
      const code = mail?.body.match(/code is:\s*(\d{6})/)?.[1] ?? "";
      expect(code).toMatch(/^\d{6}$/);
      await api(verify.POST, `/api/privacy/requests/${requestId}/verify`, { json: { code: code === "000000" ? "111111" : "000000" }, params: { id: requestId }, expect: 400 });
      const ok = await api<{ request: { status: string; verified_at: string | null } }>(verify.POST, `/api/privacy/requests/${requestId}/verify`, { json: { code }, params: { id: requestId }, expect: 200 });
      expect(ok.body.request.verified_at).toBeTruthy();

      const exp = await import("@/app/api/privacy/requests/[id]/export/route");
      const bundle = await call(exp.GET, req(`/api/privacy/requests/${requestId}/export`), { id: requestId }, 200);
      expect(bundle.res.headers.get("content-disposition")).toContain("subject-export-");
      const parsed = JSON.parse(bundle.text) as { request_id: string; kind: string };
      expect(parsed.request_id).toBe(requestId);
      expect(bundle.text).toContain("Data Subject");
      expect(bundle.text).toContain(email);
      expect(await sqlOne(`SELECT id FROM audit_log WHERE user_id = $1 AND action = 'privacy.subject.exported' AND entity_id = $2`, [org.dataId, requestId])).toBeTruthy();

      const done = await api<{ result: Record<string, unknown>; request: { status: string; completed_at?: string | null } }>(erase.POST, `/api/privacy/requests/${requestId}/erase`, { json: { mode: "anonymize" }, params: { id: requestId }, expect: 200 });
      expect(done.body.request.status).toBe("completed");
      const contact = await sqlOne<{ full_name: string; email: string | null; phone: string | null }>(`SELECT full_name, email, phone FROM crm_contacts WHERE id = $1`, [contactId]);
      expect(contact?.full_name).not.toBe("Data Subject");
      expect(contact?.email ?? "").not.toContain("subject@example.test");
      expect(contact?.phone ?? "").not.toBe("+15550123");
      // Tombstones keep the erased identifiers out of future marketing.
      const { isTombstoned } = await import("@/lib/privacy/consent");
      expect(await isTombstoned(org.dataId, email, "marketing_email")).toBe(true);
      await api(erase.POST, `/api/privacy/requests/${requestId}/erase`, { json: { mode: "anonymize" }, params: { id: requestId }, expect: 409 });
      const closed = await api<{ requests: Array<{ id: string }> }>(requests.GET, "/api/privacy/requests", { query: { status: "open" }, expect: 200 });
      expect(closed.body.requests.map((x) => x.id)).not.toContain(requestId);
    });

    it("privacy routes are settings-only (viewer → 403)", async (ctx) => {
      if (!hasPrivacy) return ctx.skip();
      setScope(org, { role: "manager", userId: "itest-manager" });
      const consents = await import("@/app/api/privacy/consents/route");
      await api(consents.GET, "/api/privacy/consents", { expect: 403 });
      setScope(org);
    });
  });

  describe("mail", () => {
    let accountId: string;

    it("connects a simulated mailbox (redirect carries the account id)", async (ctx) => {
      if (!hasMail) return ctx.skip();
      const connect = await import("@/app/api/mail/connect/[provider]/route");
      const r = await call(connect.GET, req(`/api/mail/connect/simulated`), { provider: "simulated" }, [302, 307, 308]);
      const loc = new URL(r.res.headers.get("location") ?? "", "http://localhost");
      expect(loc.pathname).toBe("/settings/mail");
      expect(loc.searchParams.get("connected")).toBe("simulated");
      accountId = loc.searchParams.get("account") ?? "";
      expect(accountId).toBeTruthy();
      await api(connect.GET, `/api/mail/connect/pigeon`, { params: { provider: "pigeon" }, expect: 404 });
      const accounts = await import("@/app/api/mail/accounts/route");
      const a = await api<{ accounts: Array<{ id: string; provider: string; email: string; status: string }>; migrated: boolean }>(accounts.GET, "/api/mail/accounts", { expect: 200 });
      expect(a.body.migrated).toBe(true);
      expect(a.body.accounts.find((x) => x.id === accountId)).toMatchObject({ provider: "simulated", status: "connected" });
      expect(JSON.stringify(a.body)).not.toContain('"auth"');
    });

    it("simulated inbound mail is synced into mail_messages exactly once", async (ctx) => {
      if (!hasMail) return ctx.skip();
      const simulate = await import("@/app/api/mail/simulate/route");
      const r = await api<{ ok: boolean; messageId: string; imported: number; skipped: number; error: string | null }>(simulate.POST, "/api/mail/simulate", {
        json: { accountId, from: "Sender@Example.test", subject: "Quote please", body: "Hi, can you quote 3 widgets?" }, expect: 200,
      });
      expect(r.body.ok).toBe(true);
      expect(r.body.imported).toBe(1);
      const rows = await sql<{ from_addr: string; subject: string; direction: string; provider_message_id: string; is_read: boolean }>(`SELECT from_addr, subject, direction, provider_message_id, is_read FROM mail_messages WHERE user_id = $1 AND account_id = $2`, [org.dataId, accountId]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ from_addr: "sender@example.test", subject: "Quote please", direction: "in", provider_message_id: r.body.messageId, is_read: false });
      // Re-syncing with nothing new imports nothing and keeps the message count.
      const { syncAccount } = await import("@/lib/mail/sync");
      const again = await syncAccount(accountId);
      expect(again.imported).toBe(0);
      expect(await sql(`SELECT id FROM mail_messages WHERE account_id = $1`, [accountId])).toHaveLength(1);
      const acct = await sqlOne<{ last_sync_at: string | null; status: string }>(`SELECT last_sync_at, status FROM mail_accounts WHERE id = $1`, [accountId]);
      expect(acct?.status).toBe("connected");
      expect(acct?.last_sync_at).toBeTruthy();
      await api(simulate.POST, "/api/mail/simulate", { json: { accountId: "nope", from: "a@b.test", subject: "s", body: "b" }, expect: 404 });
    });

    it("disconnecting removes the account and its messages", async (ctx) => {
      if (!hasMail) return ctx.skip();
      const accounts = await import("@/app/api/mail/accounts/route");
      await api(accounts.DELETE, "/api/mail/accounts", { method: "DELETE", query: { id: accountId }, expect: 200 });
      expect(await sql(`SELECT id FROM mail_accounts WHERE id = $1`, [accountId])).toHaveLength(0);
      expect(await sql(`SELECT id FROM mail_messages WHERE account_id = $1`, [accountId])).toHaveLength(0);
      await api(accounts.DELETE, "/api/mail/accounts", { method: "DELETE", query: { id: accountId }, expect: 404 });
      setScope(org, { role: "viewer", userId: "itest-viewer" });
      await api(accounts.GET, "/api/mail/accounts", { expect: 403 });
      setScope(org);
    });
  });
});
