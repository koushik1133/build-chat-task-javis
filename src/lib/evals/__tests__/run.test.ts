import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const queryOne = vi.fn();
vi.mock("@/lib/dsql", () => ({
  query: (...args: unknown[]) => query(...args),
  queryOne: (...args: unknown[]) => queryOne(...args),
}));
vi.mock("@/lib/llm/budgets", () => ({ assertBudget: vi.fn() }));
vi.mock("@/lib/llm/metering", () => ({ recordUsage: vi.fn(), meteredComplete: vi.fn() }));
vi.mock("@/lib/llm/router", () => ({ completeWithTools: vi.fn() }));
vi.mock("@/lib/agents/queue", () => ({ enqueueJob: vi.fn() }));
vi.mock("@/lib/agents/loop", () => ({ buildSystemPrompt: vi.fn(), executeTool: vi.fn(), parseAgentToolNames: () => [], resolveMaxSteps: () => 3, toolResultContent: () => "" }));
vi.mock("@/lib/agents/registry", () => ({ getTool: vi.fn(), listTools: () => [], needsApproval: () => false }));
vi.mock("@/lib/agents/runner", () => ({ loadAgent: vi.fn().mockResolvedValue({ id: "a1", tools: null, max_steps: 3, model: null }) }));
vi.mock("@/lib/agents/tools", () => ({ ensureToolsLoaded: vi.fn() }));
vi.mock("@/lib/evals/judge", () => ({ judgeCase: vi.fn().mockResolvedValue({ score: 90, reasons: "fine" }) }));

import { executeEvalRun } from "@/lib/evals/run";
import { completeWithTools } from "@/lib/llm/router";

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
});

describe("executeEvalRun", () => {
  it("marks the run failed when the final results write throws, never leaving it 'running'", async () => {
    const run = { id: "r1", user_id: "u1", eval_id: "e1", agent_id: "a1", status: "queued" };
    queryOne.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM agent_eval_runs WHERE id = $1 AND user_id = $2")) return { ...run, status: "failed", error: "disk full" };
      if (sql.includes("FROM agent_eval_runs WHERE id = $1")) return run;
      if (sql.includes("FROM agent_evals")) return { id: "e1", user_id: "u1", agent_id: "a1", name: "n", cases: JSON.stringify([{ input: "hi" }]) };
      return null;
    });
    vi.mocked(completeWithTools).mockResolvedValue({ provider: "p", model: "m", content: "answer", toolCalls: [], promptTokens: 1, completionTokens: 1 } as never);
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("finished_at = NOW() WHERE id = $1") && sql.includes("score = $3")) throw new Error("disk full");
      return [];
    });
    const out = await executeEvalRun("r1");
    expect(out?.status).toBe("failed");
    const failWrite = query.mock.calls.find(([sql]) => String(sql).includes("SET status = 'failed'"));
    expect(failWrite?.[1]).toEqual(["r1", "disk full"]);
  });
});
