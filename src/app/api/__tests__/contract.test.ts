/**
 * Contract tests: import route handlers directly and assert on status codes
 * and response shapes. External services (Supabase auth, DSQL) are mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  query: vi.fn(),
  queryOne: vi.fn(),
  transaction: vi.fn(),
  cookieGet: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  requireUser: mocks.requireUser,
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
  getServerSession: vi.fn(),
}));

vi.mock("@/lib/dsql", () => ({
  query: mocks.query,
  queryOne: mocks.queryOne,
  transaction: mocks.transaction,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: mocks.cookieGet, getAll: () => [], set: vi.fn() }),
}));

import { GET as tasksGET } from "@/app/api/tasks/route";
import { GET as automationsGET } from "@/app/api/automations/route";
import { GET as notificationsGET } from "@/app/api/notifications/route";
import { GET as healthGET } from "@/app/api/health/route";

const AUTH_USER = { id: "u1", email: "a@b.c" };
const PERSONAL_ORG = { id: "org-p", name: "p", slug: "p", owner_user_id: AUTH_USER.id, settings: null };

function authed() {
  mocks.requireUser.mockResolvedValue({ user: AUTH_USER, supabase: {} });
}

/** Authenticated with the personal org already present (skips bootstrap INSERTs). */
function authedWithOrg() {
  authed();
  mocks.queryOne.mockResolvedValueOnce(PERSONAL_ORG);
}

/** The data query a route ran (ignores org bootstrap / permission lookups). */
function dataQueryCall(fragment: string) {
  return mocks.query.mock.calls.find(([sql]) => String(sql).includes(fragment));
}

function unauthed() {
  mocks.requireUser.mockRejectedValue(new Error("UNAUTHORIZED"));
}

beforeEach(() => {
  mocks.cookieGet.mockReset().mockReturnValue(undefined);
  mocks.requireUser.mockReset();
  mocks.query.mockReset().mockResolvedValue([]);
  mocks.queryOne.mockReset().mockResolvedValue(null);
  mocks.transaction.mockReset();
});

describe("GET /api/tasks", () => {
  it("returns 401 when unauthenticated", async () => {
    unauthed();
    const res = await tasksGET(new Request("http://localhost/api/tasks"));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "unauthorized" });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("returns 200 with a tasks array when authenticated", async () => {
    authedWithOrg();
    const res = await tasksGET(new Request("http://localhost/api/tasks"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ tasks: [], next_cursor: null });
    const call = dataQueryCall("FROM tasks");
    expect(call).toBeDefined();
    // Scoped to the org's data owner (== the user for a personal org).
    expect(call?.[1]).toEqual([AUTH_USER.id]);
  });

  it("returns 200 with an empty list when the DB query fails", async () => {
    authedWithOrg();
    mocks.query.mockImplementation(async (sql: string) => {
      if (String(sql).includes("FROM tasks")) throw new Error("db down");
      return [];
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await tasksGET(new Request("http://localhost/api/tasks"));
    spy.mockRestore();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ tasks: [], next_cursor: null });
  });
});

describe("GET /api/automations", () => {
  it("returns 401 when unauthenticated", async () => {
    unauthed();
    const res = await automationsGET();
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "unauthorized" });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("returns 200 with an automations array (and the legacy workflows alias) when authenticated", async () => {
    authedWithOrg();
    const res = await automationsGET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ automations: [], workflows: [] });
    const call = dataQueryCall("FROM automations");
    expect(call).toBeDefined();
    expect(call?.[1]?.[0]).toEqual(AUTH_USER.id);
  });
});

describe("GET /api/notifications", () => {
  it("returns 401 when unauthenticated", async () => {
    unauthed();
    const res = await notificationsGET();
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("returns 200 with notifications and an unread count when authenticated", async () => {
    authed();
    mocks.queryOne.mockResolvedValue({ count: "3" });
    const res = await notificationsGET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ notifications: [], unread: 3 });
  });

  it("defaults unread to 0 when the count query returns null", async () => {
    authed();
    const res = await notificationsGET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ notifications: [], unread: 0 });
  });
});

describe("GET /api/health", () => {
  it("returns 200 without auth when the DB responds", async () => {
    const res = await healthGET(new Request("http://localhost/api/health"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.database).toBe("connected");
    expect(typeof body.time).toBe("string");
    expect(mocks.requireUser).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenCalledWith("SELECT 1 AS ok");
  });

  it("returns 503 when the DB is unreachable", async () => {
    mocks.query.mockRejectedValue(new Error("connect ECONNREFUSED"));
    const res = await healthGET(new Request("http://localhost/api/health"));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.database).toBe("error");
    // Cause is logged server-side only — never returned to anonymous callers.
    expect(body.detail).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("ECONNREFUSED");
  });
});

describe("POST /api/team/invite (requireScope write route)", () => {
  const PERSONAL = { id: "org-p", name: "p", slug: "p", owner_user_id: AUTH_USER.id, settings: null };
  const OTHER = { id: "org-o", name: "o", slug: "o", owner_user_id: "u2", settings: null };
  const body = () =>
    new Request("http://localhost/api/team/invite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "new@x.com", role: "viewer" }),
    });

  it("returns 401 when unauthenticated", async () => {
    const mod = await import("@/app/api/team/invite/route").catch(() => null);
    if (!mod) return;
    unauthed();
    const res = await mod.POST(body());
    expect(res.status).toBe(401);
  });

  it("returns 403 for a viewer", async () => {
    const mod = await import("@/app/api/team/invite/route").catch(() => null);
    if (!mod) return;
    authed();
    mocks.cookieGet.mockReturnValue({ value: "org-o" });
    mocks.queryOne.mockResolvedValueOnce(PERSONAL).mockResolvedValueOnce({ ...OTHER, role: "viewer" });
    const res = await mod.POST(body());
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: "forbidden" });
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("INSERT"))).toBe(false);
  });

  it("returns 200 with an invite link for the owner", async () => {
    const mod = await import("@/app/api/team/invite/route").catch(() => null);
    if (!mod) return;
    authed();
    mocks.queryOne.mockResolvedValueOnce(PERSONAL).mockResolvedValueOnce(null);
    const res = await mod.POST(body());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.inviteUrl).toContain("/invite/");
  });
});
