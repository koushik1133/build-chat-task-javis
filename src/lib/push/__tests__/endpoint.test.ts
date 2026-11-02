import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
vi.mock("@/lib/dsql", () => ({
  query: (...args: unknown[]) => query(...args),
  queryOne: vi.fn(),
  withRetry: (fn: () => unknown) => fn(),
}));

import { isAllowedPushEndpoint, isPushSubscription } from "@/lib/push/send";
import { PushEndpointOwnedError, saveSubscription } from "@/lib/push/sink";

const keys = { p256dh: Buffer.alloc(65, 4).toString("base64url"), auth: Buffer.alloc(16, 1).toString("base64url") };

describe("isAllowedPushEndpoint", () => {
  it("accepts public https push-service hosts", () => {
    expect(isAllowedPushEndpoint("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
    expect(isAllowedPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/x")).toBe(true);
    expect(isAllowedPushEndpoint("https://web.push.apple.com/Q")).toBe(true);
  });

  it("refuses non-https, credentials, IP literals, loopback and internal suffixes", () => {
    expect(isAllowedPushEndpoint("http://fcm.googleapis.com/x")).toBe(false);
    expect(isAllowedPushEndpoint("https://user:pw@fcm.googleapis.com/x")).toBe(false);
    expect(isAllowedPushEndpoint("https://169.254.169.254/latest/meta-data/")).toBe(false);
    expect(isAllowedPushEndpoint("https://10.0.0.5/push")).toBe(false);
    expect(isAllowedPushEndpoint("https://[::1]/push")).toBe(false);
    expect(isAllowedPushEndpoint("https://localhost/push")).toBe(false);
    expect(isAllowedPushEndpoint("https://db.internal/push")).toBe(false);
    expect(isAllowedPushEndpoint("https://printer.local/push")).toBe(false);
    expect(isAllowedPushEndpoint("https://intranet/push")).toBe(false);
    expect(isAllowedPushEndpoint("not a url")).toBe(false);
    expect(isAllowedPushEndpoint(`https://a.b/${"x".repeat(2048)}`)).toBe(false);
  });

  it("is enforced by isPushSubscription", () => {
    expect(isPushSubscription({ endpoint: "https://push.example/abc", keys })).toBe(true);
    expect(isPushSubscription({ endpoint: "https://127.0.0.1/abc", keys })).toBe(false);
  });
});

describe("saveSubscription endpoint ownership", () => {
  beforeEach(() => query.mockReset());

  it("lets the registering member move their own endpoint to another workspace", async () => {
    query.mockResolvedValueOnce([{ id: "sub-1", member_id: "member-a" }]).mockResolvedValueOnce([]);
    const id = await saveSubscription("org-2", "member-a", { endpoint: "https://push.example/abc", keys }, "UA");
    expect(id).toBe("sub-1");
    expect(String(query.mock.calls[1][0])).toContain("UPDATE push_subscriptions");
    expect(query.mock.calls[1][1]).toEqual(["sub-1", "org-2", "member-a", JSON.stringify(keys), "UA"]);
  });

  it("refuses to re-bind an endpoint registered by a different member", async () => {
    query.mockResolvedValueOnce([{ id: "sub-1", member_id: "member-a" }]);
    await expect(saveSubscription("org-2", "member-b", { endpoint: "https://push.example/abc", keys })).rejects.toBeInstanceOf(PushEndpointOwnedError);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("inserts a new row scoped to the org data id", async () => {
    query.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await saveSubscription("org-1", "member-a", { endpoint: "https://push.example/new", keys }, null);
    const [sql, params] = query.mock.calls[1];
    expect(String(sql)).toContain("INSERT INTO push_subscriptions");
    expect(params.slice(1, 4)).toEqual(["org-1", "member-a", "https://push.example/new"]);
  });
});
