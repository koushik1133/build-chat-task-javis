import { beforeEach, describe, expect, it, vi } from "vitest";

/** SEC regression: the legacy /api/onboarding POST validates and bounds its body instead of spreading raw JSON into SQL. */
const mocks = vi.hoisted(() => ({ query: vi.fn(), queryOne: vi.fn(), requireScope: vi.fn() }));
vi.mock("@/lib/dsql", () => ({ query: mocks.query, queryOne: mocks.queryOne }));
vi.mock("@/lib/auth/scope", () => ({ requireScope: mocks.requireScope, scopeErrorResponse: () => null }));

import { POST } from "@/app/api/onboarding/route";

const post = (body: string) => POST(new Request("http://localhost/api/onboarding", { method: "POST", body, headers: { "content-type": "application/json" } }));

beforeEach(() => {
  mocks.query.mockReset().mockResolvedValue([]);
  mocks.queryOne.mockReset().mockResolvedValue(null);
  mocks.requireScope.mockReset().mockResolvedValue({ dataId: "org", userId: "u1" });
});

describe("POST /api/onboarding (legacy profile)", () => {
  it("accepts a bounded, well-typed profile", async () => {
    const res = await post(JSON.stringify({ company_name: "Acme", industry: "agency", modules: ["crm"] }));
    expect(res.status).toBe(200);
    const params = mocks.query.mock.calls[0]?.[1] as unknown[];
    expect(params[0]).toBe("org");
    expect(params[1]).toBe("Acme");
    expect(params[10]).toBe(JSON.stringify(["crm"]));
  });
  it("rejects non-string fields, unknown keys, oversized values and bad JSON", async () => {
    expect((await post(JSON.stringify({ company_name: { $gt: "" } }))).status).toBe(400);
    expect((await post(JSON.stringify({ company_name: "Acme", evil: true }))).status).toBe(400);
    expect((await post(JSON.stringify({ company_name: "x".repeat(300) }))).status).toBe(400);
    expect((await post("{nope")).status).toBe(400);
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it("refuses an oversized payload", async () => {
    const res = await post(JSON.stringify({ company_name: "Acme", product_desc: "y".repeat(20_000) }));
    expect(res.status).toBe(413);
  });
});
