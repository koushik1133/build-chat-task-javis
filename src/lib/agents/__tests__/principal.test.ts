import { describe, expect, it } from "vitest";
import { canFromStored, principalFromApiScopes, principalFromCan, principalFromScope, serializePrincipal } from "../principal";
import { DEFAULT_MATRIX } from "@/lib/auth/roles";

describe("run principal", () => {
  it("write:agents key cannot see billing", () => {
    const p = principalFromApiScopes(["write:agents"]);
    const can = canFromStored(serializePrincipal(p).permissions)!;
    expect(can("agents", true)).toBe(true);
    expect(can("billing")).toBe(false);
    expect(can("reports")).toBe(false);
  });
  it("read scope grants view only; mcp grants all", () => {
    const can = canFromStored(JSON.stringify(principalFromApiScopes(["read:billing"]).permissions))!;
    expect(can("billing")).toBe(true);
    expect(can("billing", true)).toBe(false);
    const all = canFromStored(JSON.stringify(principalFromApiScopes(["mcp"]).permissions))!;
    expect(all("settings", true)).toBe(true);
  });
  it("null stored principal falls back (undefined), malformed fails closed", () => {
    expect(canFromStored(null)).toBeUndefined();
    expect(canFromStored("{bad")!("crm")).toBe(false);
  });
  it("scope and can snapshots round-trip", () => {
    const p = principalFromScope({ role: "viewer", permissions: DEFAULT_MATRIX.viewer });
    const can = canFromStored(JSON.stringify(p.permissions))!;
    expect(can("crm", true)).toBe(false);
    const q = principalFromCan((a, e) => a === "crm" && !e);
    expect(q.permissions.crm).toEqual({ view: true, edit: false });
  });
});
