import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SEC: an API key holding only `write:agents` must not be able to approve
 * (and thereby execute) a queued tool call from an area its scopes exclude.
 */
const db = vi.hoisted(() => ({
  query: vi.fn<(sql: string, values?: unknown[]) => Promise<unknown[]>>(async () => []),
  queryOne: vi.fn<(sql: string, values?: unknown[]) => Promise<unknown>>(async () => null),
  withRetry: vi.fn(async <T,>(fn: () => Promise<T>) => fn()),
}));
vi.mock("@/lib/dsql", () => db);
vi.mock("@/lib/agents/tools/index", () => ({ ensureToolsLoaded: () => undefined }));
vi.mock("@/lib/agents/queue", () => ({ enqueueJob: vi.fn(async () => undefined) }));
vi.mock("@/lib/agents/memory", () => ({ rememberCorrection: vi.fn(async () => undefined) }));

const run = vi.hoisted(() => vi.fn(async () => ({ ok: true, summary: "refunded" })));
vi.mock("@/lib/agents/registry", async () => {
  const { z } = await import("zod");
  const spec = { name: "billing.refund", description: "Refund", module: "billing", scope: "write", input: z.object({ id: z.string() }).strict(), parameters: {}, run };
  return { getTool: (name: string) => (name === "billing.refund" ? spec : undefined) };
});

import { ApprovalError, assertScopesMayExecute, decideApproval } from "@/lib/approvals/decide";

const pending = { id: "ap1", run_id: "mcp", agent_id: null, tool_name: "billing.refund", input: '{"id":"inv1"}', preview: "Refund inv1", status: "pending", decided_by: null, decided_at: null, expires_at: null, created_at: "2026-01-01T00:00:00Z" };

describe("approval decisions respect the caller's API-key scopes", () => {
  beforeEach(() => {
    db.query.mockReset();
    db.queryOne.mockReset();
    run.mockClear();
  });

  it("assertScopesMayExecute: write:agents alone cannot execute a billing write", () => {
    expect(() => assertScopesMayExecute("billing.refund", ["write:agents"])).toThrow(ApprovalError);
    try {
      assertScopesMayExecute("billing.refund", ["write:agents"]);
    } catch (err) {
      expect((err as ApprovalError).status).toBe(403);
      expect((err as ApprovalError).message).toContain("write:billing");
    }
    expect(() => assertScopesMayExecute("billing.refund", ["write:billing"])).not.toThrow();
    expect(() => assertScopesMayExecute("billing.refund", ["mcp"])).not.toThrow();
    expect(() => assertScopesMayExecute("billing.refund", undefined)).not.toThrow();
    // Unknown tools are left to the executor (it reports "not registered").
    expect(() => assertScopesMayExecute("nope.tool", ["read:crm"])).not.toThrow();
  });

  it("refuses to approve out-of-scope tools before touching the approval row", async () => {
    db.queryOne.mockResolvedValueOnce(pending); // getApproval
    await expect(decideApproval("org1", "ap1", { decision: "approved" }, "api_key:k1", { allowedScopes: ["write:agents"] })).rejects.toMatchObject({ status: 403 });
    const updates = db.queryOne.mock.calls.filter(([sql]) => /UPDATE approvals/.test(sql));
    expect(updates).toHaveLength(0);
    expect(run).not.toHaveBeenCalled();
  });

  it("approves and executes when the key holds the tool's scope", async () => {
    db.queryOne.mockResolvedValueOnce(pending); // getApproval
    db.queryOne.mockResolvedValueOnce({ ...pending, status: "approved" }); // UPDATE … RETURNING
    db.queryOne.mockResolvedValueOnce({ ...pending, status: "approved", preview: "Refund inv1 — Done: refunded" }); // preview update
    const out = await decideApproval("org1", "ap1", { decision: "approved" }, "api_key:k1", { allowedScopes: ["write:billing", "write:agents"] });
    expect(run).toHaveBeenCalledTimes(1);
    expect(out.outcome).toBe("Done: refunded");
    const update = db.queryOne.mock.calls.find(([sql]) => /UPDATE approvals SET status/.test(sql));
    expect(update?.[1]).toEqual(["approved", "api_key:k1", "ap1", null, "org1"]);
  });

  it("rejecting never needs the tool's scope", async () => {
    db.queryOne.mockResolvedValueOnce({ ...pending, status: "rejected" }); // UPDATE … RETURNING
    const out = await decideApproval("org1", "ap1", { decision: "rejected" }, "api_key:k1", { allowedScopes: ["write:agents"] });
    expect(out.approval.status).toBe("rejected");
    expect(run).not.toHaveBeenCalled();
  });

  it("in-app operators (no scopes passed) keep the existing behaviour", async () => {
    db.queryOne.mockResolvedValueOnce({ ...pending, status: "approved" });
    db.queryOne.mockResolvedValueOnce({ ...pending, status: "approved" });
    const out = await decideApproval("org1", "ap1", { decision: "approved" });
    expect(out.approval.status).toBe("approved");
    expect(run).toHaveBeenCalledTimes(1);
  });
});
