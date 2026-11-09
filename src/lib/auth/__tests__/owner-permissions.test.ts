import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ query: vi.fn(async () => []), queryOne: vi.fn(async () => null as unknown), withRetry: (fn: () => unknown) => fn(), transaction: vi.fn() }));
vi.mock("@/lib/dsql", () => db);
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ requireUser: vi.fn() }));

import { canFromPermissions, effectivePermissionsForOwner } from "@/lib/auth/scope";
import { DEFAULT_MATRIX } from "@/lib/auth/roles";

describe("effectivePermissionsForOwner", () => {
  beforeEach(() => {
    db.queryOne.mockReset();
  });

  it("returns the owner matrix for a known org data id", async () => {
    db.queryOne.mockResolvedValueOnce({ id: "org-row" });
    const perms = await effectivePermissionsForOwner("owner-1");
    expect(perms).toEqual(DEFAULT_MATRIX.owner);
    const can = canFromPermissions(perms);
    expect(can("reports")).toBe(true);
    expect(can("billing", true)).toBe(true);
  });

  it("falls back to the viewer matrix for an unknown data id so nothing widens", async () => {
    db.queryOne.mockResolvedValueOnce(null);
    const perms = await effectivePermissionsForOwner("ghost");
    expect(perms).toEqual(DEFAULT_MATRIX.viewer);
    expect(canFromPermissions(perms)("billing", true)).toBe(false);
  });
});
