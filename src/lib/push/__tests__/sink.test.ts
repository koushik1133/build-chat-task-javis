import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
vi.mock("@/lib/dsql", () => ({
  query: (...args: unknown[]) => query(...args),
  queryOne: vi.fn(),
  withRetry: (fn: () => unknown) => fn(),
}));
vi.mock("@/lib/table-exists", () => ({ tableExists: async () => true }));

import { createECDH } from "node:crypto";
import { generateVapidKeys } from "@/lib/push/vapid";
import { MAX_PAYLOAD_BYTES } from "@/lib/push/send";
import { deliverPushForUser } from "@/lib/push/sink";

const saved: Record<string, string | undefined> = {};
const ENV = ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"];

function subscriptionRow(id: string) {
  const ua = createECDH("prime256v1");
  ua.generateKeys();
  return {
    id,
    user_id: "org",
    member_id: null,
    endpoint: `https://push.example/${id}`,
    keys: JSON.stringify({ p256dh: ua.getPublicKey().toString("base64url"), auth: Buffer.alloc(16, 7).toString("base64url") }),
    user_agent: null,
    created_at: "",
  };
}

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  const keys = generateVapidKeys();
  process.env.VAPID_PUBLIC_KEY = keys.publicKey;
  process.env.VAPID_PRIVATE_KEY = keys.privateKey;
  process.env.VAPID_SUBJECT = "mailto:ops@example.com";
  query.mockReset();
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

describe("deliverPushForUser never throws", () => {
  it("counts a device as failed when the payload cannot be encrypted (oversized url) instead of rejecting", async () => {
    query.mockImplementation(async (sql: string) => (sql.includes("FROM push_subscriptions") ? [subscriptionRow("a"), subscriptionRow("b")] : []));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 201 })));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await deliverPushForUser("org", { title: "Hi", body: "x", url: "/" + "u".repeat(MAX_PAYLOAD_BYTES) });
    expect(res).toMatchObject({ configured: true, sent: 0, failed: 2, removed: 0 });
    warn.mockRestore();
  });

  it("delivers, prunes 410 endpoints and reports counts", async () => {
    const deleted: unknown[] = [];
    query.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.startsWith("DELETE FROM push_subscriptions")) {
        deleted.push(params[0]);
        return [];
      }
      if (sql.includes("FROM push_subscriptions")) return [subscriptionRow("ok"), subscriptionRow("gone")];
      return [];
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => new Response("", { status: String(url).endsWith("/gone") ? 410 : 201 }))
    );
    const res = await deliverPushForUser("org", { title: "Hi", body: "x" });
    expect(res).toEqual({ configured: true, sent: 1, failed: 1, removed: 1 });
    expect(deleted).toEqual(["gone"]);
  });
});
