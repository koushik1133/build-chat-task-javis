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

import { GET as tasksGET } from "@/app/api/tasks/route";
import { GET as automationsGET } from "@/app/api/automations/route";
import { GET as notificationsGET } from "@/app/api/notifications/route";
import { GET as healthGET } from "@/app/api/health/route";

const AUTH_USER = { id: "u1", email: "a@b.c" };

function authed() {
  mocks.requireUser.mockResolvedValue({ user: AUTH_USER, supabase: {} });
}

function unauthed() {
  mocks.requireUser.mockRejectedValue(new Error("UNAUTHORIZED"));
}

beforeEach(() => {
  mocks.requireUser.mockReset();
  mocks.query.mockReset().mockResolvedValue([]);
  mocks.queryOne.mockReset().mockResolvedValue(null);
  mocks.transaction.mockReset();
});

describe("GET /api/tasks", () => {
  it("returns 401 when unauthenticated", async () => {
    unauthed();
    const res = await tasksGET();
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "unauthorized" });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("returns 200 with a tasks array when authenticated", async () => {
    authed();
    const res = await tasksGET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ tasks: [] });
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.query.mock.calls[0][1]).toEqual([AUTH_USER.id]);
  });

  it("returns 200 with an empty list when the DB query fails", async () => {
    authed();
    mocks.query.mockRejectedValue(new Error("db down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await tasksGET();
    spy.mockRestore();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ tasks: [] });
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

  it("returns 200 with a workflows array when authenticated", async () => {
    authed();
    const res = await automationsGET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ workflows: [] });
    expect(mocks.query.mock.calls[0][1]).toEqual([AUTH_USER.id]);
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
    const res = await healthGET();
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
    const res = await healthGET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.database).toBe("error");
    // Cause is logged server-side only — never returned to anonymous callers.
    expect(body.detail).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("ECONNREFUSED");
  });
});
