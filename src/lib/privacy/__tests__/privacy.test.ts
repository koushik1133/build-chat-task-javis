import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn(), queryOne: vi.fn() }));
vi.mock("@/lib/dsql", () => ({ query: mocks.query, queryOne: mocks.queryOne, withRetry: async <T,>(fn: () => Promise<T>) => fn() }));
vi.mock("@/lib/table-exists", () => ({ tableExists: async () => true }));

import { anonymizeRow, anonymizeRows, collectKeys, ERASED_CUSTOMER_LABEL, ERASED_NAME, REDACTED, stripInternalKeys, tombstoneHash, tombstonesFor } from "@/lib/privacy/anonymize";
import {
  breachHoursRemaining,
  clampDueDays,
  computeDueAt,
  daysUntil,
  enforceRetentionFloor,
  isDueSoon,
  RETENTION_META,
  toPrivacySettings,
} from "@/lib/privacy/constants";
import { canSendMarketing, grantedSubset } from "@/lib/privacy/consent";

describe("anonymizer", () => {
  it("replaces PII in place and keeps non-personal columns", () => {
    const row = { id: "c1", user_id: "u1", full_name: "Ana Díaz", email: "ana@x.io", phone: "+91 98765", notes: "VIP", deal_value: 1200, created_at: "2024-01-01" };
    const out = anonymizeRow(row);
    expect(out).toEqual({ id: "c1", user_id: "u1", full_name: ERASED_NAME, email: null, phone: null, notes: REDACTED, deal_value: 1200, created_at: "2024-01-01" });
  });
  it("keeps financial amounts and labels the customer on invoices", () => {
    const [inv] = anonymizeRows([{ id: "i1", number: "INV-1", total_minor: 9900, currency: "INR", name: "Ana", notes: "x" }]);
    expect(inv.total_minor).toBe(9900);
    expect(inv.name).toBe(ERASED_CUSTOMER_LABEL);
    expect(inv.notes).toBe(REDACTED);
  });
  it("leaves null values null and empties JSON blobs", () => {
    expect(anonymizeRow({ email: null, data: '{"a":1}', messages: "[...]" })).toEqual({ email: null, data: "{}", messages: "[]" });
  });
  it("tombstone hash is stable and normalises case / spacing", () => {
    expect(tombstoneHash("Ana@X.io")).toBe(tombstoneHash(" ana@x.io "));
    expect(tombstoneHash("+91 98765-43210")).toBe(tombstoneHash("+919876543210"));
    expect(tombstoneHash("a@b.c")).toMatch(/^[0-9a-f]{64}$/);
    expect(tombstonesFor(["a@b.c", "A@B.C", null, ""])).toHaveLength(1);
  });
});

describe("export whitelist", () => {
  it("strips internal ids anywhere in a bundle", () => {
    const bundle = {
      subject: { id: "c1", user_id: "u1" },
      tickets: [{ id: "t1", assigned_to: "staff", messages: [{ body: "hi", author_id: "staff", user_id: "u1" }] }],
      invoices: [{ id: "i1", payments: [{ amount_minor: 1, created_by: "x" }] }],
    };
    const clean = stripInternalKeys(bundle);
    const keys = collectKeys(clean);
    for (const k of ["user_id", "assigned_to", "author_id", "created_by", "owner_user_id", "token_hash"]) expect(keys.has(k), k).toBe(false);
    expect(keys.has("amount_minor")).toBe(true);
    expect(clean.tickets[0].messages[0]).toEqual({ body: "hi" });
  });
});

describe("due-date math", () => {
  const t0 = new Date("2026-01-01T00:00:00Z");
  it("defaults to 30 days and caps at the 90-day statutory maximum", () => {
    expect(clampDueDays(undefined)).toBe(30);
    expect(clampDueDays(0)).toBe(30);
    expect(clampDueDays(45)).toBe(45);
    expect(clampDueDays(400)).toBe(90);
    expect(computeDueAt(t0).toISOString()).toBe("2026-01-31T00:00:00.000Z");
    expect(computeDueAt(t0, 365).toISOString()).toBe("2026-04-01T00:00:00.000Z");
  });
  it("flags due-soon at 5 days and overdue as negative", () => {
    const due = computeDueAt(t0, 30);
    expect(daysUntil(due, new Date("2026-01-20T00:00:00Z"))).toBe(11);
    expect(isDueSoon(due, new Date("2026-01-20T00:00:00Z"))).toBe(false);
    expect(isDueSoon(due, new Date("2026-01-27T00:00:00Z"))).toBe(true);
    expect(daysUntil(due, new Date("2026-02-05T00:00:00Z"))).toBeLessThan(0);
  });
  it("72h breach clock counts down from detection", () => {
    expect(breachHoursRemaining("2026-01-01T00:00:00Z", new Date("2026-01-02T00:00:00Z"))).toBe(48);
    expect(breachHoursRemaining("2026-01-01T00:00:00Z", new Date("2026-01-05T00:00:00Z"))).toBeLessThan(0);
  });
  it("privacy settings clamp due days and coerce booleans", () => {
    expect(toPrivacySettings({ dsr_due_days: 120, auto_fulfil_access: "yes", grievance_officer_email: " dpo@x.io " })).toEqual({
      grievance_officer_name: null,
      grievance_officer_email: "dpo@x.io",
      dsr_due_days: 90,
      auto_fulfil_access: false,
    });
  });
});

describe("retention floors", () => {
  it("never lets audit go below 365 days or any kind below its floor", () => {
    expect(enforceRetentionFloor("audit_log", 30)).toBe(365);
    expect(enforceRetentionFloor("audit_log", 1000)).toBe(1000);
    expect(enforceRetentionFloor("voice_recordings", 1)).toBe(RETENTION_META.voice_recordings.minDays);
    expect(enforceRetentionFloor("tickets_closed", Number.NaN)).toBe(RETENTION_META.tickets_closed.minDays);
  });
  it("has no retention kind for invoices", () => {
    expect(Object.keys(RETENTION_META)).not.toContain("invoices");
  });
});

describe("consent gating", () => {
  beforeEach(() => {
    mocks.query.mockReset();
    mocks.queryOne.mockReset();
  });
  it("grantedSubset returns only subjects whose latest row is a grant", async () => {
    mocks.query.mockResolvedValueOnce([
      { subject_id: "a", status: "granted" },
      { subject_id: "b", status: "withdrawn" },
    ]);
    const set = await grantedSubset("u1", "contact", ["a", "b", "c"], "marketing_voice");
    expect([...set]).toEqual(["a"]);
  });
  it("canSendMarketing fails closed: unknown contact, opt-out, tombstone, no consent", async () => {
    mocks.queryOne.mockResolvedValueOnce(null);
    expect((await canSendMarketing("u1", "x", "email")).reason).toBe("unknown_contact");

    mocks.queryOne.mockResolvedValueOnce({ id: "c", email: "a@b.c", phone: null }).mockResolvedValueOnce({ id: "opt" });
    expect((await canSendMarketing("u1", "c", "email")).reason).toBe("opted_out");

    mocks.queryOne.mockResolvedValueOnce({ id: "c", email: "a@b.c", phone: null }).mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "tomb" });
    expect((await canSendMarketing("u1", "c", "email")).reason).toBe("tombstoned");

    mocks.queryOne.mockResolvedValueOnce({ id: "c", email: "a@b.c", phone: null }).mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce({ status: "withdrawn" });
    expect((await canSendMarketing("u1", "c", "email")).allowed).toBe(false);

    mocks.queryOne.mockResolvedValueOnce({ id: "c", email: "a@b.c", phone: null }).mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce({ status: "granted" });
    expect(await canSendMarketing("u1", "c", "email")).toEqual({ allowed: true, reason: "granted" });
  });
});

import { otpMatches } from "@/lib/privacy/dsr";

describe("DSR OTP comparison", () => {
  it("SEC: uses a constant-time, length-checked comparison", () => {
    expect(otpMatches("a".repeat(64), "a".repeat(64))).toBe(true);
    expect(otpMatches("a".repeat(64), "b".repeat(64))).toBe(false);
    expect(otpMatches("a".repeat(64), "a".repeat(63))).toBe(false);
  });
});

import { eraseSubject, mailAddressPattern } from "@/lib/privacy/dsr";

describe("DSR mail matching + erasure failure handling", () => {
  it("escapes LIKE metacharacters in the address instead of stripping them", () => {
    expect(mailAddressPattern("John_Doe@Example.com")).toBe("%john\\_doe@example.com%");
    expect(mailAddressPattern("a%b@x.io")).toBe("%a\\%b@x.io%");
  });

  it("does not mark the request completed when an erasure statement fails", async () => {
    mocks.query.mockReset();
    mocks.queryOne.mockReset();
    mocks.queryOne.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM crm_contacts")) return { full_name: "Maya", email: "maya@example.com", phone: null };
      if (sql.includes("INSERT INTO consent_records")) return { id: "t" };
      return null;
    });
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("UPDATE crm_contacts")) throw new Error("column does not exist");
      return [];
    });
    await expect(eraseSubject("u1", { kind: "contact", id: "c1" }, { mode: "anonymize", requestId: "req-1" })).rejects.toThrow(/column does not exist/);
    const completed = mocks.query.mock.calls.find((c) => String(c[0]).includes("status = 'completed'"));
    expect(completed).toBeUndefined();
    // Tombstones were written before the failing statement.
    const tomb = mocks.queryOne.mock.calls.find((c) => String(c[0]).includes("INSERT INTO consent_records"));
    expect(tomb).toBeDefined();
  });
});
