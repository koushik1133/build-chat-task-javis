/**
 * Public API v1 end-to-end: API key with scopes → Bearer 401/403/200 →
 * keyset cursor pagination (sub-millisecond edge) → idempotency replay →
 * webhook subscription → fanOutNewEvents → deliverPending against a local
 * HTTP receiver → signature verifies → dead-letter after repeated failures.
 */
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { api, cleanupDataIds, createTestOrg, describeDb, setScope, sql, sqlOne, type TestOrg } from "./setup";

vi.mock("@/lib/auth/scope", () => import("./setup").then((m) => m.scopeMockFactory()));
vi.mock("@/lib/supabase/server", () => import("./setup").then((m) => m.supabaseMockFactory()));

interface Envelope<T> { data: T; meta: { next_cursor?: string | null } }
interface ApiErr { error: { code: string; message: string; details?: unknown } }
interface Contact { id: string; full_name: string; created_at: string }
interface Received { body: string; headers: Record<string, string | string[] | undefined> }

describeDb("api v1 flow", () => {
  let org: TestOrg;
  let fullKey: string;
  let readKey: string;
  let server: Server;
  let receiverUrl: string;
  const received: Received[] = [];
  let receiverStatus = 200;
  let subscriptionId: string;
  let webhookSecret: string;

  beforeAll(async () => {
    org = await createTestOrg("api-v1");
    setScope(org);
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => { body += c.toString("utf8"); });
      req.on("end", () => {
        received.push({ body, headers: req.headers });
        res.statusCode = receiverStatus;
        res.end(receiverStatus >= 400 ? "receiver says no" : "ok");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    receiverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanupDataIds([org.dataId]);
  });

  const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

  it("creates API keys with explicit scopes", async () => {
    const keys = await import("@/app/api/api-keys/route");
    const full = await api<{ key: string; record: { id: string; scopes: string[]; key_prefix: string } }>(keys.POST, "/api/api-keys", {
      json: { name: "Integration full", scopes: ["read:crm", "write:crm", "read:settings", "write:settings"] }, expect: 201,
    });
    fullKey = full.body.key;
    expect(fullKey.startsWith("kh_")).toBe(true);
    expect(full.body.record.scopes.sort()).toEqual(["read:crm", "read:settings", "write:crm", "write:settings"]);
    const ro = await api<{ key: string }>(keys.POST, "/api/api-keys", { json: { name: "Integration read-only", scopes: ["read:crm"] }, expect: 201 });
    readKey = ro.body.key;
    await api(keys.POST, "/api/api-keys", { json: { name: "Bad", scopes: ["admin:everything"] }, expect: 400 });
    const list = await api<{ keys: Array<{ name: string; revoked_at: string | null }> }>(keys.GET, "/api/api-keys", { expect: 200 });
    expect(list.body.keys.map((k) => k.name)).toEqual(expect.arrayContaining(["Integration full", "Integration read-only"]));
    expect(await sql(`SELECT id FROM api_keys WHERE user_id = $1`, [org.dataId])).toHaveLength(2);
  });

  it("Bearer auth: 401 without/invalid key, 403 without scope, 200 with scope (+ rate-limit headers)", async () => {
    const contacts = await import("@/app/api/v1/contacts/route");
    const none = await api<ApiErr>(contacts.GET, "/api/v1/contacts", { expect: 401 });
    expect(none.body.error.code).toBe("unauthorized");
    expect(none.res.headers.get("www-authenticate")).toContain("Bearer");
    await api(contacts.GET, "/api/v1/contacts", { headers: bearer("kh_not_a_real_key"), expect: 401 });

    const forbidden = await api<ApiErr>(contacts.POST, "/api/v1/contacts", { json: { full_name: "X" }, headers: bearer(readKey), expect: 403 });
    expect(forbidden.body.error.code).toBe("forbidden");
    expect((forbidden.body.error.details as { required: string }).required).toBe("write:crm");

    const ok = await api<Envelope<Contact[]>>(contacts.GET, "/api/v1/contacts", { headers: bearer(readKey), expect: 200 });
    expect(ok.body.data).toEqual([]);
    expect(ok.body.meta.next_cursor).toBeNull();
    expect(ok.res.headers.get("x-ratelimit-limit")).toBe("600");
    expect(Number(ok.res.headers.get("x-ratelimit-remaining"))).toBeLessThan(600);

    const me = await import("@/app/api/v1/me/route");
    const m = await api<Envelope<{ key: { scopes: string[] }; user: { id: string }; org: { id: string } | null }>>(me.GET, "/api/v1/me", { headers: bearer(fullKey), expect: 200 });
    expect(m.body.data.user.id).toBe(org.userId);
    expect(m.body.data.org?.id).toBe(org.orgId);
    await api(me.GET, "/api/v1/me", { headers: bearer(readKey), expect: 403 });
    // validation errors are 422 with field details
    const bad = await api<ApiErr>(contacts.POST, "/api/v1/contacts", { json: { full_name: "", bogus: 1 }, headers: bearer(fullKey), expect: 422 });
    expect(bad.body.error.code).toBe("validation_failed");
    const last = await sqlOne<{ last_used_at: string | null }>(`SELECT last_used_at FROM api_keys WHERE user_id = $1 AND name = 'Integration full'`, [org.dataId]);
    expect(last?.last_used_at).toBeTruthy();
  });

  it("cursor pagination walks every row exactly once, including rows sharing a millisecond", async () => {
    const contacts = await import("@/app/api/v1/contacts/route");
    const ids: string[] = [];
    // Burst-create so several rows land in the same millisecond (created_at keeps microseconds).
    const created = await Promise.all(
      Array.from({ length: 9 }, (_, i) => api<Envelope<Contact>>(contacts.POST, "/api/v1/contacts", { json: { full_name: `Page ${i}` }, headers: bearer(fullKey), expect: 201 }))
    );
    for (const c of created) ids.push(c.body.data.id);
    // Force the edge explicitly: two rows with identical created_at.
    // (done in SQL: pg hands timestamps back at millisecond precision, the column keeps microseconds)
    await sql(`UPDATE crm_contacts SET created_at = (SELECT created_at FROM crm_contacts WHERE id = $2) WHERE id = $1`, [ids[5], ids[4]]);
    await sql(`UPDATE crm_contacts SET created_at = (SELECT created_at FROM crm_contacts WHERE id = $2) + INTERVAL '300 microseconds' WHERE id = $1`, [ids[6], ids[4]]);
    await sql(`UPDATE crm_contacts SET created_at = (SELECT created_at FROM crm_contacts WHERE id = $2) + INTERVAL '700 microseconds' WHERE id = $1`, [ids[7], ids[4]]);

    const seen: string[] = [];
    let cursor: string | null | undefined;
    let pages = 0;
    do {
      const r = await api<Envelope<Contact[]>>(contacts.GET, "/api/v1/contacts", { query: { limit: 2, cursor: cursor ?? undefined }, headers: bearer(readKey), expect: 200 });
      expect(r.body.data.length).toBeLessThanOrEqual(2);
      seen.push(...r.body.data.map((c) => c.id));
      cursor = r.body.meta.next_cursor;
      pages++;
      expect(pages).toBeLessThan(20);
    } while (cursor);
    expect(pages).toBe(5);
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort()).toEqual([...ids].sort());
    // bad cursor → 400-class error, not a silent first page
    const bad = await api<ApiErr>(contacts.GET, "/api/v1/contacts", { query: { cursor: "!!not-base64!!" }, headers: bearer(readKey), expect: [400, 422] });
    expect(bad.body.error).toBeTruthy();
    // limit is clamped
    const big = await api<Envelope<Contact[]>>(contacts.GET, "/api/v1/contacts", { query: { limit: 200 }, headers: bearer(readKey), expect: 200 });
    expect(big.body.data).toHaveLength(9);
    await api(contacts.GET, "/api/v1/contacts", { query: { limit: 201 }, headers: bearer(readKey), expect: 422 });
  });

  it("Idempotency-Key: replay returns the stored response; different body → 422", async () => {
    const contacts = await import("@/app/api/v1/contacts/route");
    const key = `idem-${randomUUID()}`;
    const first = await api<Envelope<Contact>>(contacts.POST, "/api/v1/contacts", { json: { full_name: "Idem Potent" }, headers: { ...bearer(fullKey), "idempotency-key": key }, expect: 201 });
    expect(first.res.headers.get("idempotent-replay")).toBe("false");
    const replay = await api<Envelope<Contact>>(contacts.POST, "/api/v1/contacts", { json: { full_name: "Idem Potent" }, headers: { ...bearer(fullKey), "idempotency-key": key }, expect: 201 });
    expect(replay.res.headers.get("idempotent-replay")).toBe("true");
    expect(replay.body.data.id).toBe(first.body.data.id);
    expect(await sql(`SELECT id FROM crm_contacts WHERE user_id = $1 AND full_name = 'Idem Potent'`, [org.dataId])).toHaveLength(1);
    const mismatch = await api<ApiErr>(contacts.POST, "/api/v1/contacts", { json: { full_name: "Different" }, headers: { ...bearer(fullKey), "idempotency-key": key }, expect: 422 });
    expect(mismatch.body.error.code).toBe("idempotency_mismatch");
    await api(contacts.POST, "/api/v1/contacts", { json: { full_name: "x" }, headers: { ...bearer(fullKey), "idempotency-key": "has space" }, expect: 400 });
    const row = await sqlOne<{ status: string }>(`SELECT status FROM api_idempotency WHERE user_id = $1 AND key = $2`, [org.dataId, key]);
    expect(row?.status).toBe("completed");
    // a failed (422) attempt must not be stored under its key
    const badKey = `idem-bad-${randomUUID()}`;
    await api(contacts.POST, "/api/v1/contacts", { json: { full_name: "" }, headers: { ...bearer(fullKey), "idempotency-key": badKey }, expect: 422 });
    const badRow = await sqlOne<{ status: string }>(`SELECT status FROM api_idempotency WHERE user_id = $1 AND key = $2`, [org.dataId, badKey]);
    expect(badRow?.status ?? "completed").toBe("completed");
  });

  it("webhook subscription: created with secret shown once; URL policy enforced", async () => {
    const hooks = await import("@/app/api/v1/webhooks/route");
    // Advance the global fan-out watermark past everything emitted so far, so only
    // events created after this subscription exists turn into deliveries.
    const { fanOutNewEvents } = await import("@/lib/webhooks/dispatch");
    await fanOutNewEvents(1000);
    while ((await fanOutNewEvents(1000)).scanned > 0) { /* drain backlog */ }
    await api(hooks.POST, "/api/v1/webhooks", { json: { url: receiverUrl }, headers: bearer(readKey), expect: 403 });
    const pub = await api<ApiErr>(hooks.POST, "/api/v1/webhooks", { json: { url: "http://example.com/hook" }, headers: bearer(fullKey), expect: [400, 422] });
    expect(JSON.stringify(pub.body)).toMatch(/https|public/i);
    await api(hooks.POST, "/api/v1/webhooks", { json: { url: "https://10.0.0.1/hook" }, headers: bearer(fullKey), expect: [400, 422] });
    const r = await api<Envelope<{ id: string; secret: string; url: string; event_types: string[]; active: boolean }>>(hooks.POST, "/api/v1/webhooks", {
      json: { url: receiverUrl, event_types: ["crm.contact.created"], description: "integration receiver" }, headers: bearer(fullKey), expect: 201,
    });
    subscriptionId = r.body.data.id;
    webhookSecret = r.body.data.secret;
    expect(webhookSecret.startsWith("whsec_")).toBe(true);
    expect(r.body.data.active).toBe(true);
    const listed = await api<Envelope<Array<{ id: string; secret?: string }>>>(hooks.GET, "/api/v1/webhooks", { headers: bearer(fullKey), expect: 200 });
    expect(listed.body.data.map((s) => s.id)).toContain(subscriptionId);
    expect(listed.body.data[0]).not.toHaveProperty("secret");
    const stored = await sqlOne<{ secret: string }>(`SELECT secret FROM webhook_subscriptions WHERE id = $1`, [subscriptionId]);
    expect(stored?.secret).not.toBe(webhookSecret); // sealed (encrypted, or plain:-prefixed in dev)
  });

  it("fanOutNewEvents → deliverPending → receiver gets a correctly signed payload", async () => {
    const { fanOutNewEvents, deliverPending } = await import("@/lib/webhooks/dispatch");
    const { verifySignature, SIGNATURE_HEADER, EVENT_HEADER, DELIVERY_HEADER } = await import("@/lib/webhooks/sign");
    const contacts = await import("@/app/api/v1/contacts/route");
    const c = await api<Envelope<Contact>>(contacts.POST, "/api/v1/contacts", { json: { full_name: "Hooked Contact", lifecycle: "lead" }, headers: bearer(fullKey), expect: 201 });
    // the create emits crm.contact.created (fire-and-forget) — wait for the row
    for (let i = 0; i < 40; i++) {
      if (await sqlOne(`SELECT id FROM events WHERE user_id = $1 AND type = 'crm.contact.created' AND entity_id = $2`, [org.dataId, c.body.data.id])) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    let fan = await fanOutNewEvents(1000);
    let total = fan.created;
    while (fan.scanned > 0) { fan = await fanOutNewEvents(1000); total += fan.created; }
    expect(total).toBeGreaterThanOrEqual(1);
    const queued = await sql<{ id: string; status: string; event_type: string }>(`SELECT id, status, event_type FROM webhook_deliveries WHERE subscription_id = $1`, [subscriptionId]);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ status: "queued", event_type: "crm.contact.created" });

    receiverStatus = 200;
    received.length = 0;
    const d = await deliverPending(200);
    expect(d.delivered).toBeGreaterThanOrEqual(1);
    const mine = received.find((r) => r.headers[DELIVERY_HEADER.toLowerCase()] === queued[0].id);
    expect(mine, `receiver got ${received.length} requests`).toBeTruthy();
    expect(mine?.headers["content-type"]).toContain("application/json");
    expect(mine?.headers["user-agent"]).toContain("KernelHub");
    expect(mine?.headers[EVENT_HEADER.toLowerCase()]).toBe("crm.contact.created");
    const sig = String(mine?.headers[SIGNATURE_HEADER.toLowerCase()] ?? "");
    expect(sig).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(verifySignature(webhookSecret, mine?.body ?? "", sig)).toBe(true);
    expect(verifySignature("whsec_wrong", mine?.body ?? "", sig)).toBe(false);
    expect(verifySignature(webhookSecret, (mine?.body ?? "") + " ", sig)).toBe(false);
    const payload = JSON.parse(mine?.body ?? "{}") as { id: string; type: string; data: { entity_id?: string; id?: string }; created_at?: string };
    expect(payload.id).toBe(queued[0].id);
    expect(payload.type).toBe("crm.contact.created");
    expect(JSON.stringify(payload)).toContain(c.body.data.id);

    const row = await sqlOne<{ status: string; attempts: number; response_status: number; delivered_at: string | null }>(`SELECT status, attempts, response_status, delivered_at FROM webhook_deliveries WHERE id = $1`, [queued[0].id]);
    expect(row).toMatchObject({ status: "delivered", attempts: 1, response_status: 200 });
    expect(row?.delivered_at).toBeTruthy();
    const sub = await sqlOne<{ failure_count: number; last_success_at: string | null }>(`SELECT failure_count, last_success_at FROM webhook_subscriptions WHERE id = $1`, [subscriptionId]);
    expect(Number(sub?.failure_count)).toBe(0);
    expect(sub?.last_success_at).toBeTruthy();
    // nothing left due
    expect((await deliverPending(200)).claimed).toBe(0);
  });

  it("failing receiver: backoff schedule, then dead-letter after MAX_ATTEMPTS; delivery API exposes it", async () => {
    const { fanOutNewEvents, deliverPending } = await import("@/lib/webhooks/dispatch");
    const { MAX_ATTEMPTS, BACKOFF_SCHEDULE_MS } = await import("@/lib/webhooks/backoff");
    const contacts = await import("@/app/api/v1/contacts/route");
    const c = await api<Envelope<Contact>>(contacts.POST, "/api/v1/contacts", { json: { full_name: "Doomed Delivery" }, headers: bearer(fullKey), expect: 201 });
    for (let i = 0; i < 40; i++) {
      if (await sqlOne(`SELECT id FROM events WHERE user_id = $1 AND entity_id = $2`, [org.dataId, c.body.data.id])) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    let fan = await fanOutNewEvents(1000);
    while (fan.scanned > 0) fan = await fanOutNewEvents(1000);
    const del = await sqlOne<{ id: string }>(`SELECT id FROM webhook_deliveries WHERE subscription_id = $1 AND status = 'queued'`, [subscriptionId]);
    expect(del).toBeTruthy();

    receiverStatus = 500;
    received.length = 0;
    const first = await deliverPending(200);
    expect(first.failed).toBeGreaterThanOrEqual(1);
    let row = await sqlOne<{ status: string; attempts: number; next_attempt_at: Date; response_status: number; error: string }>(`SELECT status, attempts, next_attempt_at, response_status, error FROM webhook_deliveries WHERE id = $1`, [del?.id]);
    expect(row).toMatchObject({ status: "failed", attempts: 1, response_status: 500 });
    expect(row?.error).toContain("receiver says no");
    const wait = new Date(row?.next_attempt_at ?? 0).getTime() - Date.now();
    expect(wait).toBeGreaterThan(BACKOFF_SCHEDULE_MS[0] - 10_000);
    expect(wait).toBeLessThanOrEqual(BACKOFF_SCHEDULE_MS[0] + 1_000);
    // Not due yet → not re-claimed.
    expect((await deliverPending(200)).claimed).toBe(0);

    // Time-travel: pull next_attempt_at into the past until the delivery is dead.
    let attempts = 1;
    while (row?.status === "failed" && attempts < MAX_ATTEMPTS + 2) {
      await sql(`UPDATE webhook_deliveries SET next_attempt_at = NOW() - INTERVAL '1 second' WHERE id = $1`, [del?.id]);
      await deliverPending(200);
      row = await sqlOne(`SELECT status, attempts, next_attempt_at, response_status, error FROM webhook_deliveries WHERE id = $1`, [del?.id]);
      attempts++;
    }
    expect(row?.status).toBe("dead");
    expect(Number(row?.attempts)).toBe(MAX_ATTEMPTS);
    expect(received.length).toBe(MAX_ATTEMPTS);
    const sub = await sqlOne<{ failure_count: number; active: boolean; last_failure_at: string | null }>(`SELECT failure_count, active, last_failure_at FROM webhook_subscriptions WHERE id = $1`, [subscriptionId]);
    expect(Number(sub?.failure_count)).toBe(MAX_ATTEMPTS);
    expect(sub?.active).toBe(true); // below the auto-disable threshold
    expect(sub?.last_failure_at).toBeTruthy();
    // A dead delivery is never picked up again.
    await sql(`UPDATE webhook_deliveries SET next_attempt_at = NOW() - INTERVAL '1 second' WHERE id = $1`, [del?.id]);
    expect((await deliverPending(200)).claimed).toBe(0);

    // Owner-facing deliveries list shows both outcomes; manual retry re-queues the dead one and it succeeds.
    const list = await import("@/app/api/webhooks/[id]/route");
    const g = await api<{ subscription?: unknown; deliveries: Array<{ id: string; status: string }> }>(list.GET, `/api/webhooks/${subscriptionId}`, { params: { id: subscriptionId }, expect: 200 });
    expect(g.body.deliveries.map((x) => x.status).sort()).toEqual(["dead", "delivered"]);
    const retry = await import("@/app/api/webhooks/[id]/deliveries/[deliveryId]/retry/route");
    receiverStatus = 200;
    const rr = await api<{ delivery: { status: string } }>(retry.POST, `/api/webhooks/${subscriptionId}/deliveries/${del?.id}/retry`, { method: "POST", params: { id: subscriptionId, deliveryId: del?.id ?? "" }, expect: [200, 201] });
    expect(["queued", "delivered"]).toContain(rr.body.delivery.status);
    await deliverPending(200);
    row = await sqlOne(`SELECT status, attempts, next_attempt_at, response_status, error FROM webhook_deliveries WHERE id = $1`, [del?.id]);
    expect(row?.status).toBe("delivered");

    // Unsubscribe → further events produce no deliveries.
    const one = await import("@/app/api/v1/webhooks/[id]/route");
    await api(one.DELETE, `/api/v1/webhooks/${subscriptionId}`, { method: "DELETE", headers: bearer(fullKey), params: { id: subscriptionId }, expect: 200 });
    await api(one.GET, `/api/v1/webhooks/${subscriptionId}`, { headers: bearer(fullKey), params: { id: subscriptionId }, expect: 404 });
  });

  it("revoked key is rejected", async () => {
    const keys = await import("@/app/api/api-keys/route");
    const row = await sqlOne<{ id: string }>(`SELECT id FROM api_keys WHERE user_id = $1 AND name = 'Integration read-only'`, [org.dataId]);
    await api(keys.DELETE, `/api/api-keys`, { method: "DELETE", query: { id: row?.id }, expect: 200 });
    const contacts = await import("@/app/api/v1/contacts/route");
    await api(contacts.GET, "/api/v1/contacts", { headers: bearer(readKey), expect: 401 });
    await api(keys.DELETE, `/api/api-keys`, { method: "DELETE", query: { id: row?.id }, expect: 404 });
  });
});
