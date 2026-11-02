import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const queryOne = vi.fn();
vi.mock("@/lib/dsql", () => ({
  query: (...args: unknown[]) => query(...args),
  queryOne: (...args: unknown[]) => queryOne(...args),
  withRetry: async <T,>(fn: () => Promise<T>) => fn(),
}));
vi.mock("@/lib/webhooks/subscriptions", () => ({
  getSubscriptionRow: vi.fn(),
  matchesEventType: () => true,
  openSecret: () => "s",
  parseEventTypes: () => ["*"],
}));
vi.mock("@/lib/webhooks/url", () => ({ isAllowedWebhookUrl: () => true, resolvesToPublicAddress: async () => true }));

import { buildPayload, fanOutNewEvents, retryDelivery, samplePayload } from "@/lib/webhooks/dispatch";

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
});

describe("fanOutNewEvents watermark", () => {
  it("compares and advances the (created_at, id) watermark in SQL, never through a JS Date", async () => {
    // Event timestamps keep microseconds; a JS Date would truncate to .123 and re-select
    // this event on every tick (.123456 > .123000). The watermark must stay inside Postgres.
    queryOne.mockResolvedValueOnce({ last_event_at: new Date("2026-01-01T00:00:00.123Z"), last_event_id: "e0" });
    const evt = { id: "e1", user_id: "u1", type: "invoice.paid", entity: "invoice", entity_id: "i1", data: "{}", created_at: new Date("2026-01-01T00:00:01.123Z") };
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM events e")) return [evt];
      if (sql.includes("FROM webhook_subscriptions")) return [{ id: "s1", user_id: "u1", url: "https://x.test", secret: "", event_types: "[]", active: true, failure_count: 0 }];
      return [];
    });
    const out = await fanOutNewEvents(50);
    expect(out).toEqual({ scanned: 1, created: 1 });

    const select = query.mock.calls.find(([sql]) => String(sql).includes("FROM events e"))!;
    expect(select[0]).toContain("webhook_cursors c");
    expect(select[0]).toContain("e.created_at > COALESCE(c.last_event_at");
    expect(select[0]).toContain("e.created_at = c.last_event_at AND e.id > COALESCE(c.last_event_id, '')");
    expect(select[1]).toEqual(["events", 50]);

    const update = query.mock.calls.find(([sql]) => String(sql).startsWith("UPDATE webhook_cursors"))!;
    expect(update[0]).toContain("last_event_at = (SELECT created_at FROM events WHERE id = $2)");
    expect(update[1]).toEqual(["events", "e1"]);
    // No ISO string of the event timestamp is ever handed back as a cursor value
    // (the serialised delivery payload is the only place it legitimately appears).
    for (const call of query.mock.calls) {
      if (String(call[0]).startsWith("INSERT INTO webhook_deliveries")) continue;
      expect(JSON.stringify(call[1] ?? [])).not.toContain("2026-01-01T00:00:01");
    }
  });

  it("initialises the watermark at now on first run without replaying history", async () => {
    queryOne.mockResolvedValueOnce(null);
    query.mockResolvedValue([]);
    expect(await fanOutNewEvents()).toEqual({ scanned: 0, created: 0 });
    expect(query.mock.calls[0][0]).toContain("INSERT INTO webhook_cursors");
  });
});

describe("payload shapes", () => {
  it("sample payloads have the same top-level shape as real deliveries", () => {
    const real = buildPayload("d1", { type: "invoice.paid", entity: "invoice", entity_id: "i1", data: '{"total_minor":1}', created_at: "2026-01-01T00:00:00.000Z" });
    const sample = samplePayload("invoice.paid");
    expect(Object.keys(sample).sort()).toEqual(Object.keys(real).sort());
    expect(sample.entity).toBe("invoice");
    expect(Object.keys(sample.data)).toEqual(expect.arrayContaining(Object.keys(real.data)));
  });

  it("retryDelivery resets attempts and re-queues only non-active deliveries", async () => {
    queryOne.mockResolvedValueOnce(null);
    expect(await retryDelivery("u", "s", "d")).toBeNull();
    const [sql] = queryOne.mock.calls[0];
    expect(sql).toContain("attempts = 0");
    expect(sql).toContain("status IN ('failed', 'dead', 'delivered')");
  });
});
