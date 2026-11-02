import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn(), queryOne: vi.fn() }));
vi.mock("@/lib/dsql", () => ({ query: mocks.query, queryOne: mocks.queryOne }));

import {
  applyGroupPatch,
  applyUserPatch,
  matchesFilter,
  normalisePath,
  parseFilter,
  parsePaging,
  parsePatchOps,
  scimError,
  SCIM,
} from "@/lib/scim/schema";
import { authenticateScim, bearerFrom, createScimToken, hashScimToken, verifyScimToken } from "@/lib/scim/auth";

beforeEach(() => {
  mocks.query.mockReset().mockResolvedValue([]);
  mocks.queryOne.mockReset().mockResolvedValue(null);
});

describe("SCIM filter parser", () => {
  it("parses userName eq with quotes and case-insensitive operators", () => {
    expect(parseFilter('userName eq "ana@acme.com"')).toEqual({ attr: "username", op: "eq", value: "ana@acme.com" });
    expect(parseFilter('userName EQ "x"')).toEqual({ attr: "username", op: "eq", value: "x" });
    expect(parseFilter('emails.value co "acme"')).toEqual({ attr: "emails.value", op: "co", value: "acme" });
  });
  it("parses booleans, presence and escaped quotes", () => {
    expect(parseFilter("active eq true")).toEqual({ attr: "active", op: "eq", value: true });
    expect(parseFilter("name.givenName pr")).toEqual({ attr: "name.givenname", op: "pr", value: null });
    expect(parseFilter('displayName eq "say \\"hi\\""')).toEqual({ attr: "displayname", op: "eq", value: 'say "hi"' });
  });
  it("rejects what it does not support", () => {
    expect(parseFilter('userName eq "a" and active eq true')).toBeNull();
    expect(parseFilter("userName eq")).toBeNull();
    expect(parseFilter("")).toBeNull();
    expect(parseFilter(null)).toBeNull();
    expect(parseFilter('userName gt "a"')).toBeNull();
  });
  it("matches resources case-insensitively, including multi-valued attributes", () => {
    const user = { userName: "Ana@Acme.com", active: true, emails: [{ value: "ana@acme.com", primary: true }], name: { givenName: "Ana" } };
    expect(matchesFilter(user, parseFilter('userName eq "ANA@acme.com"')!)).toBe(true);
    expect(matchesFilter(user, parseFilter('emails.value sw "ana"')!)).toBe(true);
    expect(matchesFilter(user, parseFilter('emails eq "ana@acme.com"')!)).toBe(true);
    expect(matchesFilter(user, parseFilter("active eq false")!)).toBe(false);
    expect(matchesFilter(user, parseFilter("name.familyName pr")!)).toBe(false);
    expect(matchesFilter(user, parseFilter('userName ne "bob@acme.com"')!)).toBe(true);
  });
  it("clamps paging", () => {
    expect(parsePaging({ startIndex: "0", count: "9999" })).toEqual({ startIndex: 1, count: 200 });
    expect(parsePaging({ startIndex: "3", count: "x" })).toEqual({ startIndex: 3, count: 50 });
  });
});

describe("SCIM PATCH application", () => {
  const base = { userName: "ana@acme.com", active: true, role: "member" };

  it("normalises op case and applies active=false (Azure-style string boolean)", () => {
    const ops = parsePatchOps({ schemas: [SCIM.PATCH], Operations: [{ op: "Replace", path: "active", value: "False" }] });
    expect(ops).toEqual([{ op: "replace", path: "active", value: "False" }]);
    expect(applyUserPatch(base, ops!)).toMatchObject({ active: false });
  });
  it("applies path-less value objects and role changes", () => {
    const ops = parsePatchOps({ Operations: [{ op: "add", value: { "name.givenName": "Ana", roles: [{ value: "Admin" }] } }] })!;
    const next = applyUserPatch(base, ops);
    expect(next.givenName).toBe("Ana");
    expect(next.role).toBe("admin");
    expect(next.active).toBe(true);
  });
  it("strips value filters from paths and handles remove", () => {
    expect(normalisePath('emails[type eq "work"].value')).toBe("emails.value");
    expect(normalisePath("urn:ietf:params:scim:schemas:core:2.0:User:userName")).toBe("username");
    const next = applyUserPatch(
      { ...base, givenName: "Ana" },
      [
        { op: "replace", path: 'emails[type eq "work"].value', value: "ana.new@acme.com" },
        { op: "remove", path: "name.givenName" },
      ]
    );
    expect(next.userName).toBe("ana.new@acme.com");
    expect(next.givenName).toBeUndefined();
  });
  it("rejects malformed op lists and bad values", () => {
    expect(parsePatchOps({ Operations: [] })).toBeNull();
    expect(parsePatchOps({ Operations: [{ op: "move" }] })).toBeNull();
    expect(parsePatchOps("nope")).toBeNull();
    expect(() => applyUserPatch(base, [{ op: "replace", path: "active", value: "maybe" }])).toThrow(/boolean/);
    expect(() => applyUserPatch(base, [{ op: "remove" }])).toThrow(/path/);
  });
  it("maps group member ops to add/remove/replace lists", () => {
    const change = applyGroupPatch([
      { op: "add", path: "members", value: [{ value: "m1" }, { value: "m2" }] },
      { op: "remove", path: 'members[value eq "m3"]' },
      { op: "remove", path: "members", value: [{ value: "m4" }] },
    ]);
    expect(change).toEqual({ add: ["m1", "m2"], remove: ["m3", "m4"], replace: null });
    expect(applyGroupPatch([{ op: "replace", path: "members", value: [{ value: "m9" }] }]).replace).toEqual(["m9"]);
  });
  it("builds the standard error envelope", () => {
    expect(scimError(400, "bad", "invalidFilter")).toEqual({ schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], status: "400", detail: "bad", scimType: "invalidFilter" });
  });
});

describe("SCIM token auth", () => {
  it("creates a prefixed token, stores only its hash and verifies it", async () => {
    const { token, record } = await createScimToken("org-data", "Okta");
    expect(token.startsWith("scim_")).toBe(true);
    expect(record.name).toBe("Okta");
    const insert = mocks.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO scim_tokens"));
    expect(insert?.[1]).toContain(hashScimToken(token));
    expect(insert?.[1]).not.toContain(token);

    mocks.queryOne
      .mockResolvedValueOnce({ id: record.id, user_id: "org-data", name: "Okta", token_hash: hashScimToken(token), created_at: "", last_used_at: null, revoked_at: null })
      .mockResolvedValueOnce({ id: "org-1", name: "Acme" });
    const ctx = await verifyScimToken(token);
    expect(ctx).toEqual({ tokenId: record.id, dataId: "org-data", orgId: "org-1", orgName: "Acme" });
    expect(mocks.queryOne.mock.calls[0][1]).toEqual([hashScimToken(token)]);
  });

  it("rejects malformed, unknown and revoked tokens", async () => {
    expect(await verifyScimToken("")).toBeNull();
    expect(await verifyScimToken("kh_not_scim_token_xxxxxxxxxxxx")).toBeNull();
    expect(await verifyScimToken("scim_short")).toBeNull();
    expect(await verifyScimToken("scim_" + "a".repeat(40))).toBeNull(); // queryOne → null (unknown or revoked)
  });

  it("parses bearer headers and answers 401 with a SCIM error body", async () => {
    expect(bearerFrom("Bearer abc")).toBe("abc");
    expect(bearerFrom("bearer   abc ")).toBe("abc");
    expect(bearerFrom("Basic abc")).toBeNull();
    expect(bearerFrom(null)).toBeNull();

    const res = await authenticateScim(new Request("http://localhost/api/scim/v2/Users"));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.res.status).toBe(401);
      expect(res.res.headers.get("content-type")).toContain("application/scim+json");
      expect(res.res.headers.get("www-authenticate")).toContain("Bearer");
      await expect(res.res.json()).resolves.toMatchObject({ schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], status: "401" });
    }
    const bad = await authenticateScim(new Request("http://localhost/api/scim/v2/Users", { headers: { authorization: "Bearer scim_" + "b".repeat(40) } }));
    expect(bad.ok).toBe(false);
  });
});
