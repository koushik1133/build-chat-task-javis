import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/supabase/server", () => ({ requireUser: vi.fn(), getServerSession: vi.fn() }));
vi.mock("@/lib/dsql", () => ({ query: vi.fn(), queryOne: vi.fn() }));
import { scopeErrorResponse, ScopeError } from "@/lib/auth/scope";

describe("scopeErrorResponse", () => {
  it("keeps 401 for unauthenticated users", async () => {
    expect(scopeErrorResponse(new ScopeError("UNAUTHORIZED"))?.status).toBe(401);
  });
  it("does not swallow unrelated errors (callers map their own domain errors)", () => {
    expect(scopeErrorResponse(new Error("validation failed"))).toBeNull();
    expect(scopeErrorResponse(Object.assign(new Error("relation \"x\" does not exist"), { code: "42P01" }))).toBeNull();
  });
  it("reports a missing table during scope resolution as 503 schema_outdated", async () => {
    const under = Object.assign(new Error("relation \"organizations\" does not exist"), { code: "42P01" });
    const r = scopeErrorResponse(new ScopeError("UNAVAILABLE", "x", under));
    expect(r?.status).toBe(503);
    expect((await r!.json()).code).toBe("schema_outdated");
  });
  it("reports a missing endpoint as db_not_configured", async () => {
    const r = scopeErrorResponse(new ScopeError("UNAVAILABLE", "x", new Error("DSQL_ENDPOINT is not set. Add your cluster endpoint")));
    expect(r?.status).toBe(503);
    expect((await r!.json()).code).toBe("db_not_configured");
  });
  it("reports other faults as database_unavailable without leaking details", async () => {
    const r = scopeErrorResponse(new ScopeError("UNAVAILABLE", "x", new Error("connect ETIMEDOUT 10.0.0.1:5432")));
    expect(r?.status).toBe(503);
    expect(JSON.stringify(await r!.json())).not.toContain("10.0.0.1");
  });
});
