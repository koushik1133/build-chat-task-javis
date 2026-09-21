import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const queryOne = vi.fn();
vi.mock("@/lib/dsql", () => ({
  query: (...args: unknown[]) => query(...args),
  queryOne: (...args: unknown[]) => queryOne(...args),
  withRetry: async <T,>(fn: () => Promise<T>) => fn(),
}));

const sendEmailUnified = vi.fn(async () => ({ success: true, message: "ok" }));
vi.mock("@/lib/email-sender", () => ({ sendEmailUnified: () => sendEmailUnified() }));

import { channelStatus } from "@/lib/notifications/status";
import { dispatch } from "@/lib/notifications/channels";
import { drainOutbox, enqueueNotification } from "@/lib/notifications/outbox";

const ENV_KEYS = ["RESEND_API_KEY", "EMAIL_PROVIDER", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER"];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  query.mockReset();
  queryOne.mockReset();
  sendEmailUnified.mockClear();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

describe("channelStatus", () => {
  it("is simulated for email/sms/whatsapp without provider env", () => {
    expect(channelStatus()).toEqual({ email: "simulated", sms: "simulated", whatsapp: "simulated", in_app: "live", webhook: "live" });
  });

  it("goes live when RESEND_API_KEY and TWILIO_* are set", () => {
    process.env.RESEND_API_KEY = "re_test";
    process.env.TWILIO_ACCOUNT_SID = "AC1";
    process.env.TWILIO_AUTH_TOKEN = "tok";
    process.env.TWILIO_FROM_NUMBER = "+15550000000";
    expect(channelStatus()).toMatchObject({ email: "live", sms: "live", whatsapp: "live" });
  });
});

describe("dispatch", () => {
  const msg = { recipient: "a@b.c", subject: "Your code", body: "123456", data: null };

  it("simulates email when no provider is configured", async () => {
    const out = await dispatch({ ...msg, channel: "email" });
    expect(out.status).toBe("simulated");
    expect(sendEmailUnified).not.toHaveBeenCalled();
  });

  it("sends email through the provider when RESEND_API_KEY is set", async () => {
    process.env.RESEND_API_KEY = "re_test";
    const out = await dispatch({ ...msg, channel: "email" });
    expect(out.status).toBe("sent");
    expect(sendEmailUnified).toHaveBeenCalledTimes(1);
  });

  it("simulates sms without Twilio and posts to Twilio with it", async () => {
    expect((await dispatch({ ...msg, channel: "sms", recipient: "+15551234567" })).status).toBe("simulated");

    process.env.TWILIO_ACCOUNT_SID = "AC1";
    process.env.TWILIO_AUTH_TOKEN = "tok";
    process.env.TWILIO_FROM_NUMBER = "+15550000000";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ sid: "SM1" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await dispatch({ ...msg, channel: "whatsapp", recipient: "+15551234567" });
    expect(out).toEqual({ status: "sent", providerId: "SM1" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("api.twilio.com");
    expect(String(init.body)).toContain("whatsapp%3A%2B15551234567");
  });

  it("marks in_app sent immediately and rejects bad webhook URLs", async () => {
    expect((await dispatch({ ...msg, channel: "in_app" })).status).toBe("sent");
    await expect(dispatch({ ...msg, channel: "webhook", recipient: "not a url" })).rejects.toThrow(/valid URL/);
  });
});

describe("enqueueNotification + drainOutbox", () => {
  it("inserts a queued row", async () => {
    query.mockResolvedValue([]);
    const id = await enqueueNotification("org", { channel: "email", recipient: "a@b.c", subject: "Hi", body: "x", data: { k: 1 } });
    expect(id).toMatch(/[0-9a-f-]{36}/);
    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("INSERT INTO notification_outbox");
    expect(values.slice(1, 7)).toEqual(["org", "email", "a@b.c", "Hi", "x", '{"k":1}']);
  });

  it("rejects unknown channels", async () => {
    await expect(enqueueNotification("org", { channel: "pigeon" as never, recipient: "x" })).rejects.toThrow(/unknown channel/);
  });

  it("drains due rows and records simulated status", async () => {
    const row = {
      id: "n1", user_id: "org", channel: "email", recipient: "a@b.c", subject: "Code", body: "999",
      data: null, status: "queued", attempts: 1, error: null, scheduled_at: "", sent_at: null, read_at: null, created_at: "",
    };
    query.mockImplementation(async (sql: string) => (sql.includes("SELECT id FROM notification_outbox") ? [{ id: "n1" }] : []));
    queryOne.mockResolvedValue(row);
    const res = await drainOutbox(10);
    expect(res).toEqual({ claimed: 1, sent: 0, simulated: 1, failed: 0 });
    const update = query.mock.calls.find(([sql]) => String(sql).includes("SET status = $2, sent_at"));
    expect(update?.[1]).toEqual(["n1", "simulated"]);
  });

  it("requeues on error and fails after the last attempt", async () => {
    const row = {
      id: "n2", user_id: "org", channel: "webhook", recipient: "https://example.test/hook", subject: null, body: null,
      data: null, status: "queued", attempts: 3, error: null, scheduled_at: "", sent_at: null, read_at: null, created_at: "",
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    query.mockImplementation(async (sql: string) => (sql.includes("SELECT id FROM notification_outbox") ? [{ id: "n2" }] : []));
    queryOne.mockResolvedValue(row);
    const res = await drainOutbox(10);
    expect(res.failed).toBe(1);
    const update = query.mock.calls.find(([sql]) => String(sql).includes("SET status = $2, error = $3"));
    expect(update?.[1]?.[1]).toBe("failed");
    spy.mockRestore();
  });
});
