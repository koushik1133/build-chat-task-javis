import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn(), queryOne: vi.fn() }));
vi.mock("@/lib/dsql", () => ({ query: mocks.query, queryOne: mocks.queryOne, withRetry: (fn: () => unknown) => fn(), transaction: vi.fn() }));
vi.mock("@/lib/agents/queue", () => ({ enqueueJob: vi.fn() }));

import { createHash } from "crypto";
import { GET, POST } from "@/app/api/v1/contacts/route";
import { resetRateLimits } from "@/lib/request-limits";

const KEY = "kh_" + "a".repeat(40);
const keyHash = createHash("sha256").update(KEY, "utf8").digest("hex");

function keyRow(scopes: string[]) {
  return { id: "key1", user_id: "user1", name: "t", key_prefix: KEY.slice(0, 8), scopes: JSON.stringify(scopes), last_used_at: null, created_at: "2026-01-01T00:00:00Z", revoked_at: null };
}

function req(path: string, init: RequestInit = {}) {
  return new Request(`http://localhost${path}`, init);
}
const ctx = { params: Promise.resolve({}) };

beforeEach(() => {
  mocks.query.mockReset();
  mocks.queryOne.mockReset();
  mocks.query.mockResolvedValue([]);
  resetRateLimits();
});

describe("GET /api/v1/contacts auth", () => {
  it("401 without a key, with the error envelope and WWW-Authenticate", async () => {
    const res = await GET(req("/api/v1/contacts"), ctx);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/Bearer/);
    const body = await res.json();
    expect(body.error.code).toBe("unauthorized");
    expect(mocks.queryOne).not.toHaveBeenCalled();
  });

  it("401 for an unknown key", async () => {
    mocks.queryOne.mockResolvedValueOnce(null);
    const res = await GET(req("/api/v1/contacts", { headers: { authorization: `Bearer ${KEY}` } }), ctx);
    expect(res.status).toBe(401);
    expect(mocks.queryOne.mock.calls[0][1]).toEqual([keyHash]);
  });

  it("403 when the key lacks read:crm", async () => {
    mocks.queryOne.mockResolvedValueOnce(keyRow(["read:tasks"]));
    const res = await GET(req("/api/v1/contacts", { headers: { authorization: `Bearer ${KEY}` } }), ctx);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatchObject({ code: "forbidden", details: { required: "read:crm" } });
    expect(res.headers.get("x-ratelimit-limit")).toBe("600");
  });

  it("200 with the data/meta envelope and rate-limit headers for read:crm", async () => {
    mocks.queryOne.mockResolvedValueOnce(keyRow(["read:crm"]));
    mocks.query.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes("FROM crm_contacts")) {
        expect(params[0]).toBe("user1");
        return [{ id: "c1", user_id: "user1", domain: "general", full_name: "Ada", email: null, phone: null, company: null, role: null, tags: "[]", lifecycle: "lead", notes: null, last_contact: null, deal_value: "0", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }];
      }
      return [];
    });
    const res = await GET(req("/api/v1/contacts?limit=10", { headers: { authorization: `Bearer ${KEY}` } }), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-ratelimit-remaining")).toBe("599");
    const body = await res.json();
    expect(body).toEqual({ data: [expect.objectContaining({ id: "c1", full_name: "Ada", tags: [], deal_value: 0 })], meta: { next_cursor: null } });
  });

  it("write scope implies read; legacy mcp grants everything", async () => {
    mocks.queryOne.mockResolvedValueOnce(keyRow(["write:crm"]));
    expect((await GET(req("/api/v1/contacts", { headers: { authorization: `Bearer ${KEY}` } }), ctx)).status).toBe(200);
    mocks.queryOne.mockResolvedValueOnce(keyRow(["mcp"]));
    expect((await GET(req("/api/v1/contacts", { headers: { authorization: `Bearer ${KEY}` } }), ctx)).status).toBe(200);
  });

  it("400 for a malformed cursor", async () => {
    mocks.queryOne.mockResolvedValueOnce(keyRow(["read:crm"]));
    const res = await GET(req("/api/v1/contacts?cursor=%2A", { headers: { authorization: `Bearer ${KEY}` } }), ctx);
    expect(res.status).toBe(400);
  });
});

describe("POST /api/v1/contacts", () => {
  it("403 with read-only scope, 422 on invalid body, 201 on success", async () => {
    mocks.queryOne.mockResolvedValueOnce(keyRow(["read:crm"]));
    const forbidden = await POST(req("/api/v1/contacts", { method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: "{}" }), ctx);
    expect(forbidden.status).toBe(403);

    mocks.queryOne.mockResolvedValueOnce(keyRow(["write:crm"]));
    const invalid = await POST(req("/api/v1/contacts", { method: "POST", headers: { authorization: `Bearer ${KEY}` }, body: JSON.stringify({ email: "nope" }) }), ctx);
    expect(invalid.status).toBe(422);
    expect((await invalid.json()).error.details).toEqual(expect.arrayContaining([expect.objectContaining({ path: "full_name" })]));

    mocks.queryOne.mockResolvedValueOnce(keyRow(["write:crm"]));
    mocks.queryOne.mockResolvedValueOnce({ id: "c9", user_id: "user1", domain: "general", full_name: "Ada", email: "ada@example.com", phone: null, company: null, role: null, tags: "[]", lifecycle: "lead", notes: null, last_contact: null, deal_value: "0", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });
    const ok = await POST(req("/api/v1/contacts", { method: "POST", headers: { authorization: `Bearer ${KEY}` }, body: JSON.stringify({ full_name: "Ada", email: "ada@example.com" }) }), ctx);
    expect(ok.status).toBe(201);
    expect((await ok.json()).data.id).toBe("c9");
  });
});
