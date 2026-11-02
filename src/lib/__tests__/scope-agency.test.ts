import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  query: vi.fn(),
  queryOne: vi.fn(),
  cookieGet: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  requireUser: mocks.requireUser,
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
}));
vi.mock("@/lib/dsql", () => ({ query: mocks.query, queryOne: mocks.queryOne }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: mocks.cookieGet }),
}));

import { ensurePersonalOrg, requireScope } from "@/lib/auth/scope";

/**
 * Agency mode: a client workspace's owner_user_id is the child org's own id
 * (a synthetic data key), never a Supabase user. requireScope must resolve it
 * through the membership join and ensurePersonalOrg must never adopt it.
 */
const USER = { id: "u-agency", email: "owner@agency.com" };
const PERSONAL = { id: "org-agency", name: "Agency", slug: "agency", owner_user_id: "u-agency", settings: null };
const CHILD = { id: "org-client-1", name: "Client One", slug: "client-one", owner_user_id: "org-client-1", settings: null };

beforeEach(() => {
  mocks.requireUser.mockReset().mockResolvedValue({ user: USER });
  mocks.query.mockReset().mockResolvedValue([]);
  mocks.queryOne.mockReset().mockResolvedValue(null);
  mocks.cookieGet.mockReset().mockReturnValue(undefined);
});

describe("requireScope with a client workspace", () => {
  it("switches into a child org via the owner membership and keys data by the synthetic id", async () => {
    mocks.cookieGet.mockReturnValue({ value: CHILD.id });
    mocks.queryOne
      .mockResolvedValueOnce(PERSONAL) // ensurePersonalOrg
      .mockResolvedValueOnce({ ...CHILD, role: "owner" }); // membership join
    const scope = await requireScope({ area: "billing", edit: true });
    expect(scope.orgId).toBe(CHILD.id);
    expect(scope.dataId).toBe(CHILD.id);
    expect(scope.dataId).not.toBe(USER.id);
    expect(scope.role).toBe("owner");
    expect(scope.isOwner).toBe(true);
    // The membership lookup is what resolved it — by the real user id and the cookie org.
    const join = mocks.queryOne.mock.calls[1];
    expect(String(join[0])).toContain("FROM memberships m JOIN organizations o");
    expect(join[1]).toEqual([USER.id, CHILD.id]);
    // No org bootstrap inserts happened for the child.
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO organizations"))).toBe(false);
  });

  it("falls back to the personal org when the child membership is suspended (archived client)", async () => {
    mocks.cookieGet.mockReturnValue({ value: CHILD.id });
    mocks.queryOne.mockResolvedValueOnce(PERSONAL).mockResolvedValueOnce(null); // join filters status='active'
    const scope = await requireScope();
    expect(scope.orgId).toBe(PERSONAL.id);
    expect(scope.dataId).toBe(USER.id);
  });

  it("ensurePersonalOrg only matches owner_user_id = the auth user, so a client org is never adopted", async () => {
    mocks.queryOne.mockResolvedValueOnce(PERSONAL);
    const org = await ensurePersonalOrg(USER.id, USER.email);
    expect(org.id).toBe(PERSONAL.id);
    const [sql, params] = mocks.queryOne.mock.calls[0];
    expect(String(sql)).toContain("WHERE owner_user_id = $1");
    expect(params).toEqual([USER.id]);
    expect(params).not.toContain(CHILD.owner_user_id);
  });

  it("a client user invited into the child sees the child's data id, not their own", async () => {
    mocks.requireUser.mockResolvedValue({ user: { id: "u-client", email: "cto@client.com" } });
    mocks.cookieGet.mockReturnValue({ value: CHILD.id });
    mocks.queryOne
      .mockResolvedValueOnce({ id: "org-personal-client", name: "p", slug: "p", owner_user_id: "u-client", settings: null })
      .mockResolvedValueOnce({ ...CHILD, role: "member" });
    const scope = await requireScope({ area: "crm" });
    expect(scope.dataId).toBe(CHILD.id);
    expect(scope.role).toBe("member");
    expect(scope.isOwner).toBe(false);
    expect(scope.can("settings")).toBe(false);
  });
});
