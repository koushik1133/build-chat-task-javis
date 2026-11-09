import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SEC regression: POST /api/errors/report must
 *  - attribute signed-in reports to the workspace data id (not the actor id),
 *  - store anonymous reports unattributed,
 *  - enforce a global bucket on top of the per-IP bucket.
 */
const mocks = vi.hoisted(() => ({
  requireScope: vi.fn(),
  rateLimitAsync: vi.fn(),
  captureError: vi.fn(),
}));
vi.mock("@/lib/auth/scope", () => ({ requireScope: mocks.requireScope }));
vi.mock("@/lib/request-limits", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/request-limits")>()),
  rateLimitAsync: mocks.rateLimitAsync,
  clientIp: () => "203.0.113.9",
}));
vi.mock("@/lib/errors/capture", () => ({ captureError: mocks.captureError }));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/errors/report/route";

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/errors/report", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
}
const ok = { allowed: true, remaining: 1, resetAt: 0 };
const blocked = { allowed: false, remaining: 0, resetAt: 0 };

beforeEach(() => {
  mocks.requireScope.mockReset();
  mocks.rateLimitAsync.mockReset().mockResolvedValue(ok);
  mocks.captureError.mockReset().mockResolvedValue("e1");
});

describe("POST /api/errors/report", () => {
  it("files a signed-in report under the workspace data id", async () => {
    mocks.requireScope.mockResolvedValue({ userId: "member-1", dataId: "org-owner" });
    const res = await POST(post({ message: "boom", route: "/settings" }));
    expect(res.status).toBe(201);
    expect(mocks.captureError.mock.calls[0]?.[1]).toMatchObject({ userId: "org-owner", route: "client:/settings" });
  });
  it("stores anonymous reports unattributed", async () => {
    mocks.requireScope.mockRejectedValue(new Error("UNAUTHORIZED"));
    await POST(post({ message: "boom", route: "/" }));
    expect(mocks.captureError.mock.calls[0]?.[1]).toMatchObject({ userId: null });
  });
  it("applies a global bucket after the per-IP bucket", async () => {
    mocks.rateLimitAsync.mockResolvedValueOnce(ok).mockResolvedValueOnce(blocked);
    const res = await POST(post({ message: "boom", route: "/" }));
    expect(res.status).toBe(429);
    expect(mocks.rateLimitAsync.mock.calls[1]?.[0]).toBe("errors-report:global");
    expect(mocks.captureError).not.toHaveBeenCalled();
  });
  it("rejects oversized or unknown fields", async () => {
    mocks.requireScope.mockRejectedValue(new Error("UNAUTHORIZED"));
    expect((await POST(post({ message: "x".repeat(3000), route: "/" }))).status).toBe(400);
    expect((await POST(post({ message: "x", route: "/", extra: 1 }))).status).toBe(400);
  });
});
