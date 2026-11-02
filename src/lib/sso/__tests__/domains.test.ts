import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ queryOne: vi.fn() }));
vi.mock("@/lib/dsql", () => ({ query: vi.fn(), queryOne: mocks.queryOne }));

import { canClaimSsoDomain, emailDomain, isPublicMailDomain } from "@/lib/sso/domains";

beforeEach(() => mocks.queryOne.mockReset().mockResolvedValue(null));

describe("canClaimSsoDomain", () => {
  it("lets a workspace claim the domain its owner signs in with", async () => {
    expect(await canClaimSsoDomain({ orgId: "org-a", email: "ceo@acme.com" }, "ACME.com")).toBe(true);
    expect(mocks.queryOne).not.toHaveBeenCalled();
  });
  it("refuses another company's domain when nobody in the workspace uses it", async () => {
    expect(await canClaimSsoDomain({ orgId: "org-a", email: "ceo@acme.com" }, "victim.com")).toBe(false);
    const [sql, params] = mocks.queryOne.mock.calls[0];
    expect(String(sql)).toContain("FROM memberships");
    expect(String(sql)).toContain("status = 'active'");
    expect(params).toEqual(["org-a", "victim.com"]);
  });
  it("accepts when an active member has an address on the domain", async () => {
    mocks.queryOne.mockResolvedValueOnce({ id: "m1" });
    expect(await canClaimSsoDomain({ orgId: "org-a", email: "ceo@acme.com" }, "partner.io")).toBe(true);
  });
  it("never allows public mailbox providers, even for their own users", async () => {
    expect(await canClaimSsoDomain({ orgId: "org-a", email: "someone@gmail.com" }, "gmail.com")).toBe(false);
    expect(isPublicMailDomain("Outlook.com")).toBe(true);
    expect(emailDomain("a@b@C.com")).toBe("c.com");
    expect(emailDomain("nope")).toBeNull();
  });
});
