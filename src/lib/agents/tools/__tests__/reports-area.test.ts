import { beforeEach, describe, expect, it, vi } from "vitest";

/** reports.run must not read a dataset outside the caller's areas (member roles / scoped keys). */
const mocks = vi.hoisted(() => ({
  resolveDataset: vi.fn(),
  runReport: vi.fn(),
  listDatasets: vi.fn(async () => []),
  effectivePermissionsForOwner: vi.fn(),
}));
vi.mock("@/lib/dsql", () => ({ query: vi.fn(), queryOne: vi.fn(), withRetry: (fn: () => unknown) => fn(), transaction: vi.fn() }));
vi.mock("@/lib/reports/query", () => ({
  resolveDataset: mocks.resolveDataset,
  runReport: mocks.runReport,
  listDatasets: mocks.listDatasets,
  ReportSpecError: class extends Error {},
  DatasetUnavailableError: class extends Error {},
}));
vi.mock("@/lib/reports/store", () => ({ getSavedReportById: vi.fn(), listSavedReports: vi.fn(async () => []) }));
vi.mock("@/lib/reports/export", () => ({ formattedRows: (r: { rows: unknown[] }) => r.rows, formattedTotals: () => ({}) }));
vi.mock("@/lib/auth/scope", async (orig) => {
  const actual = await orig<typeof import("@/lib/auth/scope")>();
  return { ...actual, effectivePermissionsForOwner: mocks.effectivePermissionsForOwner };
});
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ requireUser: vi.fn() }));

import "@/lib/agents/tools/reports";
import { getTool } from "@/lib/agents/registry";
import { DEFAULT_MATRIX } from "@/lib/auth/roles";
import type { ToolContext } from "@/lib/agents/types";

const base: ToolContext = { userId: "org-1", runId: "copilot", agentId: null, autonomy: "approve" };
const spec = { dataset: "invoices", filters: [], group_by: [], measures: [{ field: "total_minor", agg: "sum" }] };

describe("reports.run area gating", () => {
  beforeEach(() => {
    mocks.resolveDataset.mockReset();
    mocks.runReport.mockReset();
    mocks.effectivePermissionsForOwner.mockReset();
    mocks.resolveDataset.mockResolvedValue({ key: "invoices", area: "billing" });
    mocks.runReport.mockResolvedValue({ dataset: "invoices", columns: [], rows: [], truncated: false, timezone: "UTC", currency: "USD" });
  });

  it("denies a dataset outside ctx.can when the caller supplied one", async () => {
    const tool = getTool("reports.run")!;
    const r = await tool.run({ ...base, can: (area) => area !== "billing" }, { spec });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/outside the areas/);
    expect(mocks.runReport).not.toHaveBeenCalled();
  });

  it("allows it when ctx.can grants the area", async () => {
    const tool = getTool("reports.run")!;
    const r = await tool.run({ ...base, can: () => true }, { spec });
    expect(r.ok).toBe(true);
    expect(mocks.runReport).toHaveBeenCalledTimes(1);
  });

  it("without ctx.can, loads the owner matrix for the org and applies it", async () => {
    mocks.effectivePermissionsForOwner.mockResolvedValueOnce({ ...DEFAULT_MATRIX.viewer, billing: { view: false, edit: false } });
    const tool = getTool("reports.run")!;
    const denied = await tool.run(base, { spec });
    expect(denied.ok).toBe(false);
    expect(mocks.effectivePermissionsForOwner).toHaveBeenCalledWith("org-1");
    mocks.effectivePermissionsForOwner.mockResolvedValueOnce(DEFAULT_MATRIX.owner);
    const ok = await tool.run(base, { spec });
    expect(ok.ok).toBe(true);
  });
});

describe("reports.run with a stored run principal", () => {
  it("a write:agents-only principal cannot read billing datasets", async () => {
    const { canFromStored, principalFromApiScopes } = await import("@/lib/agents/principal");
    mocks.resolveDataset.mockResolvedValue({ key: "invoices", area: "billing" });
    const can = canFromStored(JSON.stringify(principalFromApiScopes(["write:agents"]).permissions));
    const res = await getTool("reports.run")!.run({ ...base, can }, { spec } as never);
    expect(res.ok).toBe(false);
    expect(mocks.runReport).not.toHaveBeenCalled();
  });
});
