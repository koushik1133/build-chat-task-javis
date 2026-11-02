import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn(), queryOne: vi.fn() }));
vi.mock("@/lib/dsql", () => ({ query: mocks.query, queryOne: mocks.queryOne }));
vi.mock("@/lib/notifications/outbox", () => ({ enqueueNotification: vi.fn(async () => "n1") }));

import { AgencyForbiddenError, createChildOrg } from "@/lib/agency/orgs";

const CHILD_ROW = (id: string) => ({ id, name: "Client", slug: "client", owner_user_id: id, parent_org_id: "org-parent", kind: "client", archived_at: null, created_at: "2026-01-01" });

beforeEach(() => {
  mocks.query.mockReset().mockResolvedValue([]);
  mocks.queryOne.mockReset().mockResolvedValue(null);
});

describe("createChildOrg authorisation", () => {
  it.each(["manager", "member", "viewer"] as const)("refuses a %s even if settings-edit was granted by an override", async (role) => {
    await expect(createChildOrg({ orgId: "org-parent", userId: "u-x", dataId: "u-owner", role }, { name: "Client" })).rejects.toBeInstanceOf(AgencyForbiddenError);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("gives an acting admin an admin seat on the child, and the parent owner the owner seat", async () => {
    mocks.queryOne
      .mockResolvedValueOnce({ owner_user_id: "u-owner" }) // parent owner lookup
      .mockImplementationOnce(async (_sql: string, params: unknown[]) => CHILD_ROW(String(params[0]))); // re-read
    const dto = await createChildOrg({ orgId: "org-parent", userId: "u-admin", dataId: "u-owner", role: "admin" }, { name: "Client" });
    const seats = mocks.query.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO memberships")).map(([, p]) => [(p as unknown[])[2], (p as unknown[])[3]]);
    expect(seats).toEqual(expect.arrayContaining([["u-owner", "owner"], ["u-admin", "admin"]]));
    expect(seats.some(([uid, role]) => uid === "u-admin" && role === "owner")).toBe(false);
    expect(dto.members).toBe(2);
    expect(dto.dataId).toBe(dto.id);
  });

  it("gives the owner a single owner seat when they create the workspace themselves", async () => {
    mocks.queryOne.mockResolvedValueOnce({ owner_user_id: "u-owner" }).mockImplementationOnce(async (_sql: string, params: unknown[]) => CHILD_ROW(String(params[0])));
    const dto = await createChildOrg({ orgId: "org-parent", userId: "u-owner", dataId: "u-owner", role: "owner" }, { name: "Client" });
    const seats = mocks.query.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO memberships"));
    expect(seats).toHaveLength(1);
    expect((seats[0][1] as unknown[])[3]).toBe("owner");
    expect(dto.members).toBe(1);
  });
});
