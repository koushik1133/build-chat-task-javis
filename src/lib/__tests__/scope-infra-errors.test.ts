import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/supabase/server", () => ({ requireUser: vi.fn(), getServerSession: vi.fn() }));
vi.mock("@/lib/dsql", () => ({ query: vi.fn(), queryOne: vi.fn() }));
import { scopeErrorResponse, ScopeError } from "@/lib/auth/scope";

describe("scopeErrorResponse", () => {
  it("keeps 401 for unauthenticated users", async () => {
    const r = scopeErrorResponse(new ScopeError("UNAUTHORIZED"));
    expect(r?.status).toBe(401);
  });
  it("reports a missing table as a 503 schema_outdated, not a fake 401", async () => {
    const err = Object.assign(new Error("relation \"organizations\" does not exist"), { code: "42P01" });
    const r = scopeErrorResponse(err);
    expect(r?.status).toBe(503);
    expect((await r!.json()).code).toBe("schema_outdated");
  });
  it("reports a missing endpoint as db_not_configured without leaking details", async () => {
    const r = scopeErrorResponse(new Error("DSQL_ENDPOINT is not set. Add your cluster endpoint"));
    expect(r?.status).toBe(503);
    expect((await r!.json()).code).toBe("db_not_configured");
  });
  it("reports other faults as database_unavailable", async () => {
    const r = scopeErrorResponse(new Error("connect ETIMEDOUT 10.0.0.1:5432"));
    expect(r?.status).toBe(503);
    expect(JSON.stringify(await r!.json())).not.toContain("10.0.0.1");
  });
});
