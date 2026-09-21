import { describe, expect, it } from "vitest";
import { AREAS, DEFAULT_MATRIX, ROLES, canManageRole, isArea, isRole } from "@/lib/auth/roles";

describe("roles: canManageRole", () => {
  it("owner can manage every role", () => {
    for (const r of ROLES) expect(canManageRole("owner", r)).toBe(true);
  });
  it("admin can manage everything except owner", () => {
    expect(canManageRole("admin", "owner")).toBe(false);
    for (const r of ROLES.filter((x) => x !== "owner")) expect(canManageRole("admin", r)).toBe(true);
  });
  it("manager, member and viewer cannot manage anyone", () => {
    for (const actor of ["manager", "member", "viewer"] as const) {
      for (const r of ROLES) expect(canManageRole(actor, r)).toBe(false);
    }
  });
});

describe("roles: DEFAULT_MATRIX shape", () => {
  it("has an entry for every role and every area", () => {
    for (const role of ROLES) {
      const row = DEFAULT_MATRIX[role];
      expect(row).toBeDefined();
      for (const area of AREAS) {
        const cell = row[area];
        expect(typeof cell.view).toBe("boolean");
        expect(typeof cell.edit).toBe("boolean");
        // edit without view is never a valid cell
        if (cell.edit) expect(cell.view).toBe(true);
      }
    }
  });
  it("owner and admin have full access everywhere", () => {
    for (const area of AREAS) {
      expect(DEFAULT_MATRIX.owner[area]).toEqual({ view: true, edit: true });
      expect(DEFAULT_MATRIX.admin[area]).toEqual({ view: true, edit: true });
    }
  });
  it("viewer never has edit and cannot see team or settings", () => {
    for (const area of AREAS) expect(DEFAULT_MATRIX.viewer[area].edit).toBe(false);
    expect(DEFAULT_MATRIX.viewer.team.view).toBe(false);
    expect(DEFAULT_MATRIX.viewer.settings.view).toBe(false);
  });
});

describe("roles: guards", () => {
  it("isRole / isArea accept known values and reject others", () => {
    expect(isRole("admin")).toBe(true);
    expect(isRole("root")).toBe(false);
    expect(isArea("crm")).toBe(true);
    expect(isArea("nope")).toBe(false);
    expect(isRole(null)).toBe(false);
  });
});
