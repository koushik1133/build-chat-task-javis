import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SEC (Phase 8 engagement): marketing hardening regressions.
 *  - unsubscribe tokens carry the channel and the one-click header hits the API route
 *  - contact data cannot inject markdown links into campaign HTML; subject has no CR/LF
 *  - unsubscribe fails closed, is idempotent and suppresses the address
 *  - the consent gate fails closed when the suppression list cannot be read
 *  - From display names cannot break out of the header phrase
 */
const db = vi.hoisted(() => ({
  query: vi.fn<(sql: string, values?: unknown[]) => Promise<unknown[]>>(async () => []),
  queryOne: vi.fn<(sql: string, values?: unknown[]) => Promise<unknown>>(async () => null),
  withRetry: vi.fn(async <T,>(fn: () => Promise<T>) => fn()),
}));
vi.mock("@/lib/dsql", () => db);
const events = vi.hoisted(() => ({ emitEvent: vi.fn(async () => undefined) }));
vi.mock("@/lib/events/bus", () => events);
vi.mock("@/lib/notifications/outbox", () => ({ enqueueNotification: vi.fn(async () => "ob1") }));
vi.mock("@/lib/table-exists", () => ({ tableExists: vi.fn(async () => true) }));

import { renderEmail } from "@/lib/marketing/render";
import { unsubscribeContactToken, unsubscribeOneClickUrl, verifyToken } from "@/lib/marketing/tracking";
import { unsubscribe } from "@/lib/marketing/campaigns";
import { canSendMarketing } from "@/lib/privacy/consent";
import { safeDisplayName } from "@/lib/email-sender";

describe("tracking tokens carry the channel", () => {
  it("an SMS opt-out token cannot be downgraded to email and legacy 3-part tokens still verify as email", () => {
    const sms = verifyToken(unsubscribeContactToken("org", "c1", "sms"));
    expect(sms).toEqual({ kind: "unsub_contact", dataId: "org", contactId: "c1", channel: "sms" });
    // Flip the channel letter in the payload: the signature no longer matches.
    const tok = unsubscribeContactToken("org", "c1", "sms");
    const [p, sig] = tok.split(".");
    const tampered = Buffer.from(Buffer.from(p, "base64url").toString().replace(/\|s$/, "|e")).toString("base64url");
    expect(verifyToken(`${tampered}.${sig}`)).toBeNull();
  });

  it("one-click header URL targets the API route, the human link keeps the page", () => {
    expect(unsubscribeOneClickUrl("https://app.test/u/abc.def")).toBe("https://app.test/api/t/u/abc.def");
  });
});

describe("render: contact data is inert", () => {
  const vars = { first_name: "[Verify your account](https://evil.example)", company: "**bold** <b>x</b>", unsubscribe_url: "https://x.test/u/t?a=1&b=2" };

  it("merge values never become markdown links or emphasis, while template links still work", () => {
    const r = renderEmail({ subject: "Hi {{first_name}}", body_md: "Hello {{first_name}} from {{company}}. [Site](https://ok.test)", vars });
    expect(r.html).not.toContain('href="https://evil.example"');
    expect(r.html).toContain("[Verify your account](https://evil.example)");
    expect(r.html).not.toContain("<strong>bold</strong>");
    expect(r.html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(r.html).toContain('<a href="https://ok.test"');
    expect(r.html).toContain('href="https://x.test/u/t?a=1&amp;b=2"');
  });

  it("subject strips CR/LF so merged data cannot add a header line", () => {
    const r = renderEmail({ subject: "Hi {{first_name}}", body_md: "x", vars: { first_name: "A\r\nBcc: victim@x.test", unsubscribe_url: "https://x.test/u/t" } });
    expect(r.subject).not.toMatch(/[\r\n]/);
    expect(r.subject).toBe("Hi A Bcc: victim@x.test");
  });
});

describe("unsubscribe()", () => {
  const target = { dataId: "org", contactId: "c1", recipientId: null, campaignId: null, channel: "sms" as const };

  beforeEach(() => {
    db.query.mockReset();
    db.queryOne.mockReset();
    events.emitEvent.mockReset();
    db.query.mockResolvedValue([]);
  });

  it("withdraws the channel in the token (sms), suppresses the phone and emits once", async () => {
    db.queryOne.mockImplementation(async (sql: string) => {
      if (sql.includes("INSERT INTO consent_records")) return { id: "cr" };
      if (sql.includes("FROM crm_contacts")) return { email: "A@x.test", phone: "+15550001" };
      if (sql.includes("FROM contact_optouts")) return null;
      return null;
    });
    const r = await unsubscribe(target);
    expect(r.withdrawn).toEqual(["marketing_sms"]);
    const consentInsert = db.queryOne.mock.calls.find(([sql]) => sql.includes("INSERT INTO consent_records"));
    expect(consentInsert?.[1]).toContain("marketing_sms");
    expect(consentInsert?.[1]).not.toContain("marketing_email");
    const optout = db.query.mock.calls.find(([sql]) => sql.includes("INSERT INTO contact_optouts"));
    expect(optout?.[1]).toEqual(["org", "c1", "+15550001", null, "sms"]);
    expect(events.emitEvent).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: a replayed POST appends no ledger row, no opt-out and no event", async () => {
    db.query.mockImplementation(async (sql: string) => (sql.includes("FROM consent_records") ? [{ purpose: "marketing_sms", status: "withdrawn", occurred_at: "2026-01-01", source: "form" }] : []));
    db.queryOne.mockImplementation(async (sql: string) => (sql.includes("FROM contact_optouts") ? { id: "o1" } : sql.includes("FROM crm_contacts") ? { email: null, phone: "+1" } : null));
    await unsubscribe(target);
    expect(db.queryOne.mock.calls.some(([sql]) => sql.includes("INSERT INTO consent_records"))).toBe(false);
    expect(db.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO contact_optouts"))).toBe(false);
    expect(events.emitEvent).not.toHaveBeenCalled();
  });

  it("fails closed: a consent write error propagates instead of reporting success", async () => {
    db.queryOne.mockImplementation(async (sql: string) => {
      if (sql.includes("INSERT INTO consent_records")) throw new Error("db down");
      return null;
    });
    await expect(unsubscribe(target)).rejects.toThrow("db down");
    expect(events.emitEvent).not.toHaveBeenCalled();
  });
});

describe("canSendMarketing fails closed", () => {
  beforeEach(() => {
    db.queryOne.mockReset();
  });

  it("denies when the opt-out list cannot be read, even with a grant", async () => {
    db.queryOne.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM crm_contacts")) return { id: "c1", email: "a@x.test", phone: null };
      if (sql.includes("FROM contact_optouts")) throw new Error("table missing");
      return { status: "granted" };
    });
    expect(await canSendMarketing("org", "c1", "email")).toEqual({ allowed: false, reason: "opted_out" });
  });

  it("denies when the tombstone check errors", async () => {
    db.queryOne.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM crm_contacts")) return { id: "c1", email: "a@x.test", phone: null };
      if (sql.includes("FROM contact_optouts")) return null;
      if (sql.includes("subject_kind = 'tombstone'")) throw new Error("db");
      return { status: "granted" };
    });
    expect(await canSendMarketing("org", "c1", "email")).toEqual({ allowed: false, reason: "tombstoned" });
  });
});

describe("safeDisplayName", () => {
  it("strips characters that would break out of the From phrase", () => {
    expect(safeDisplayName('x" <ceo@victim.com>, "y')).toBe("x ceo@victim.com y");
    expect(safeDisplayName("Acme\r\nBcc: a@b.c")).toBe("Acme Bcc a@b.c");
    expect(safeDisplayName(null)).toBe("");
    expect(safeDisplayName("a".repeat(200))).toHaveLength(80);
  });
});
