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

import { requireScope, ScopeError, scopeErrorResponse } from "@/lib/auth/scope";

const USER = { id: "u1", email: "owner@x.com" };
const PERSONAL = { id: "org-p", name: "p", slug: "p", owner_user_id: "u1", settings: null };
const OTHER = { id: "org-o", name: "o", slug: "o", owner_user_id: "u2", settings: null };

beforeEach(() => {
  mocks.requireUser.mockReset();
  mocks.query.mockReset().mockResolvedValue([]);
  mocks.queryOne.mockReset().mockResolvedValue(null);
  mocks.cookieGet.mockReset().mockReturnValue(undefined);
});

describe("requireScope", () => {
  it("throws ScopeError UNAUTHORIZED when not signed in", async () => {
    mocks.requireUser.mockRejectedValue(new Error("UNAUTHORIZED"));
    await expect(requireScope()).rejects.toMatchObject({ name: "ScopeError", code: "UNAUTHORIZED" });
    expect(scopeErrorResponse(new ScopeError("UNAUTHORIZED"))?.status).toBe(401);
  });

  it("auto-creates the personal org on first use", async () => {
    mocks.requireUser.mockResolvedValue({ user: USER });
    mocks.queryOne.mockResolvedValueOnce(null); // no org yet
    const scope = await requireScope();
    const inserts = mocks.query.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO"));
    expect(inserts.some(([sql]) => String(sql).includes("organizations"))).toBe(true);
    expect(inserts.some(([sql]) => String(sql).includes("memberships"))).toBe(true);
    expect(scope.role).toBe("owner");
    expect(scope.dataId).toBe("u1");
    expect(scope.orgName).toContain("owner");
  });

  it("forbids a viewer on an edit check and allows the owner", async () => {
    mocks.requireUser.mockResolvedValue({ user: USER });
    mocks.cookieGet.mockReturnValue({ value: "org-o" });
    mocks.queryOne.mockResolvedValueOnce(PERSONAL).mockResolvedValueOnce({ ...OTHER, role: "viewer" });
    await expect(requireScope({ area: "crm", edit: true })).rejects.toMatchObject({ code: "FORBIDDEN" });

    mocks.queryOne.mockReset().mockResolvedValueOnce(PERSONAL);
    mocks.cookieGet.mockReturnValue(undefined);
    const scope = await requireScope({ area: "crm", edit: true });
    expect(scope.isOwner).toBe(true);
    expect(scope.can("crm", true)).toBe(true);
  });

  it("never exposes a supabase/service-role client", async () => {
    mocks.requireUser.mockResolvedValue({ user: USER, supabase: { admin: true } });
    mocks.queryOne.mockResolvedValueOnce(PERSONAL);
    const scope = await requireScope();
    expect(Object.keys(scope).sort()).toEqual(
      ["can", "dataId", "email", "isOwner", "orgId", "orgName", "orgSlug", "permissions", "role", "userId"].sort()
    );
    expect("supabase" in scope).toBe(false);
  });

  it("falls back to the personal org for an unknown cookie org", async () => {
    mocks.requireUser.mockResolvedValue({ user: USER });
    mocks.cookieGet.mockReturnValue({ value: "org-does-not-exist" });
    mocks.queryOne.mockResolvedValueOnce(PERSONAL).mockResolvedValueOnce(null);
    const scope = await requireScope();
    expect(scope.orgId).toBe("org-p");
    expect(scope.role).toBe("owner");
  });
});
