import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  requireScope: vi.fn(),
}));

vi.mock("@/lib/dsql", () => ({ query: mocks.query, queryOne: vi.fn(), withRetry: (fn: () => unknown) => fn() }));
vi.mock("@/lib/auth/scope", () => ({
  requireScope: mocks.requireScope,
  scopeErrorResponse: () => null,
}));
vi.mock("@/lib/i18n/server", () => ({ getRequestLocale: async () => "en" }));
vi.mock("@/lib/org-settings", () => ({ getOrgSettings: async () => ({ locale: "en", currency: "USD", timezone: "UTC" }) }));

import { GET } from "@/app/api/search/route";

type Group = { kind: string; items: Array<{ id: string; href: string }> };

beforeEach(() => {
  mocks.query.mockReset();
  mocks.requireScope.mockResolvedValue({ dataId: "org", userId: "u1", orgName: "Org", can: () => true });
});

async function search(q: string): Promise<Group[]> {
  const res = await GET(new Request(`http://localhost/api/search?q=${encodeURIComponent(q)}`));
  return ((await res.json()) as { groups: Group[] }).groups;
}

describe("GET /api/search", () => {
  it("links tickets and articles to the pages that actually exist (query-param deep links)", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM tickets")) return [{ id: "t1", number: 7, subject: "Login", status: "open", priority: "normal", requester_name: null }];
      if (sql.includes("FROM kb_articles")) return [{ id: "a1", slug: "reset-password", title: "Reset", status: "published", category: null }];
      return [];
    });
    const groups = await search("login");
    const ticket = groups.find((g) => g.kind === "ticket")?.items[0];
    const article = groups.find((g) => g.kind === "article")?.items[0];
    expect(ticket?.href).toBe("/helpdesk?ticket=t1");
    expect(article?.href).toBe("/knowledge?article=a1");
  });

  it("escapes ILIKE wildcards and a failing kind does not break the others", async () => {
    mocks.query.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes("FROM tickets")) throw new Error("relation tickets does not exist");
      if (sql.includes("FROM crm_contacts")) {
        expect(params[1]).toBe("%50\\%\\_off%");
        return [{ id: "c1", full_name: "Ada", email: null, company: null }];
      }
      return [];
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const groups = await search("50%_off");
    expect(groups.map((g) => g.kind)).toEqual(["contact"]);
    warn.mockRestore();
  });

  it("skips kinds the caller's role cannot view", async () => {
    mocks.requireScope.mockResolvedValue({ dataId: "org", userId: "u1", orgName: "Org", can: (a: string) => a === "tasks" });
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM tasks")) return [{ id: 1, title: "Call Ada", done: false }];
      throw new Error(`should not query: ${sql.slice(0, 30)}`);
    });
    const groups = await search("ada");
    expect(groups.map((g) => g.kind)).toEqual(["task"]);
  });
});
