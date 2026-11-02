import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
vi.mock("@/lib/dsql", () => ({
  query: (...args: unknown[]) => query(...args),
  queryOne: vi.fn(),
  withRetry: (fn: () => unknown) => fn(),
}));
vi.mock("@/lib/agents/queue", () => ({ enqueueJob: vi.fn() }));
const tableExists = vi.fn();
vi.mock("@/lib/table-exists", () => ({ tableExists: (...a: unknown[]) => tableExists(...a) }));

import { runPlaybookDetectors } from "@/lib/agents/playbooks";

beforeEach(() => {
  query.mockReset();
  tableExists.mockReset();
  query.mockResolvedValue([]);
});

function candidateSql(): string {
  const call = query.mock.calls.find(([s]) => String(s).includes("FROM crm_contacts") && String(s).includes("UNION"));
  return String(call?.[0]);
}

describe("playbook candidate users", () => {
  it("includes tickets in the UNION only when the helpdesk table exists", async () => {
    tableExists.mockResolvedValue(true);
    await runPlaybookDetectors();
    expect(tableExists).toHaveBeenCalledWith("tickets");
    expect(candidateSql()).toContain("UNION SELECT user_id FROM tickets");
  });

  it("leaves tickets out before the helpdesk migration so the other playbooks keep running", async () => {
    tableExists.mockResolvedValue(false);
    await runPlaybookDetectors();
    const sql = candidateSql();
    expect(sql).toContain("FROM social_brands");
    expect(sql).not.toContain("tickets");
  });
});
