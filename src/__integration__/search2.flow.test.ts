/**
 * Search 2.0 / power-user UX end-to-end: cross-module search with scope gating,
 * operators, partial results on timeout, deep-link shape; recent items,
 * favourites and inbox routes with member isolation.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { api, call, cleanupDataIds, createTestOrg, describeDb, req, setScope, sql, type TestOrg } from "./setup";

vi.mock("@/lib/auth/scope", () => import("./setup").then((m) => m.scopeMockFactory()));
vi.mock("@/lib/supabase/server", () => import("./setup").then((m) => m.supabaseMockFactory()));

interface Group { kind: string; items: Array<{ kind: string; id: string; title: string; href: string }> }

describeDb("search 2.0 + recent/favourites/inbox", () => {
  let org: TestOrg;
  const ids = { order: randomUUID(), project: randomUUID(), supplier: randomUUID(), po: randomUUID(), doc: randomUUID(), campaign: randomUUID() };

  beforeAll(async () => {
    org = await createTestOrg("search2");
    setScope(org);
    const d = org.dataId;
    await sql(`INSERT INTO orders (id, user_id, number, customer_name, customer_email) VALUES ($1, $2, 'ORD-900001', 'Zelda Zanzibar', 'zelda@example.test')`, [ids.order, d]);
    await sql(`INSERT INTO projects (id, user_id, name, code) VALUES ($1, $2, 'Zanzibar rollout', 'PRJ-ZZ')`, [ids.project, d]);
    await sql(`INSERT INTO suppliers (id, user_id, name) VALUES ($1, $2, 'Zanzibar Supplies')`, [ids.supplier, d]);
    await sql(`INSERT INTO purchase_orders (id, user_id, supplier_id, number) VALUES ($1, $2, $3, 'PO-900001')`, [ids.po, d, ids.supplier]);
    await sql(`INSERT INTO documents (id, user_id, title) VALUES ($1, $2, 'Zanzibar services agreement')`, [ids.doc, d]);
    await sql(`INSERT INTO campaigns (id, user_id, name) VALUES ($1, $2, 'Zanzibar launch')`, [ids.campaign, d]);
    await sql(`INSERT INTO products (id, user_id, name, sku) VALUES ($1, $2, 'Zanzibar widget', 'ZZ-1')`, [randomUUID(), d]);
    await sql(`INSERT INTO expenses (id, user_id, vendor, description) VALUES ($1, $2, 'Zanzibar Cafe', 'team lunch')`, [randomUUID(), d]);
    await sql(`INSERT INTO crm_contacts (id, user_id, full_name) VALUES ($1, $2, 'Zed Zanzibar')`, [randomUUID(), d]);
  });
  afterAll(async () => {
    await cleanupDataIds([org.dataId]);
  });

  async function search(q: string) {
    const route = await import("@/app/api/search/route");
    const r = await api<{ groups: Group[]; partial: boolean }>(route.GET, `/api/search?q=${encodeURIComponent(q)}`, { expect: 200 });
    return r.body;
  }
  const kinds = (g: Group[]) => g.map((x) => x.kind);

  it("finds entities across modules with deep links that open the item", async () => {
    setScope(org);
    const body = await search("zanzibar");
    expect(kinds(body.groups)).toEqual(expect.arrayContaining(["order", "project", "supplier", "purchase_order", "document", "campaign", "product", "expense", "contact"]));
    const hrefOf = (k: string) => body.groups.find((g) => g.kind === k)?.items[0].href;
    expect(hrefOf("order")).toBe(`/orders?order=${ids.order}`);
    expect(hrefOf("project")).toBe(`/projects/${ids.project}`);
    expect(hrefOf("campaign")).toBe(`/marketing?campaign=${ids.campaign}`);
    expect(hrefOf("document")).toContain(`/documents?doc=${ids.doc}`);
    expect(hrefOf("purchase_order")).toMatch(/^\/procurement\?tab=orders&q=PO-900001/);
    for (const g of body.groups) for (const it of g.items) expect(it.href.startsWith("/")).toBe(true);
    expect(body.partial).toBe(false);
  });

  it("matches order by customer email and supports kind: operator", async () => {
    setScope(org);
    const body = await search("kind:orders zelda@example");
    expect(kinds(body.groups)).toEqual(["order"]);
    const typo = await search("in:billing zanzbar");
    expect(typo.groups.length).toBeGreaterThan(0);
  });

  it("scope gating: a caller without billing sees no orders, suppliers or products", async () => {
    setScope(org, { role: "viewer", can: (area) => area !== "billing" });
    const body = await search("zanzibar");
    const k = kinds(body.groups);
    expect(k).not.toContain("order");
    expect(k).not.toContain("supplier");
    expect(k).not.toContain("purchase_order");
    expect(k).not.toContain("product");
    expect(k).toContain("project");
    setScope(org);
  });

  it("returns partial results when a kind exceeds the time budget", async () => {
    const { runSearch, KIND_DEFS } = await import("@/lib/search/engine");
    const slow = { kind: "snapshot" as const, area: null, table: null, icon: "x", run: () => new Promise<never[]>((r) => setTimeout(() => r([]), 2000)) };
    const t0 = Date.now();
    const out = await runSearch({ dataId: org.dataId, actorId: org.userId, q: "zanzibar", can: () => true, locale: "en-US", budgetMs: 300, defs: [...KIND_DEFS, slow] });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(out.partial).toBe(true);
    expect(out.skipped).toContain("snapshot");
    expect(out.items.length).toBeGreaterThan(0);
  });

  it("recent items: auth, upsert, cap and member isolation", async () => {
    const route = await import("@/app/api/recent/route");
    setScope(null);
    await api(route.GET, "/api/recent", { expect: 401 });
    setScope(org);
    await api(route.POST, "/api/recent", { json: { kind: "order", entity_id: "o1", title: "ORD-1", href: "https://evil.test" }, expect: 400 });
    for (let i = 0; i < 33; i++) {
      await api(route.POST, "/api/recent", { json: { kind: "order", entity_id: `o${i}`, title: `ORD-${i}`, href: `/orders?order=o${i}` }, expect: 200 });
    }
    await api(route.POST, "/api/recent", { json: { kind: "order", entity_id: "o5", title: "ORD-5 again", href: "/orders?order=o5" }, expect: 200 });
    const rows = await sql<{ n: string }>(`SELECT COUNT(*)::text AS n FROM recent_items WHERE member_user_id = $1`, [org.userId]);
    expect(Number(rows[0].n)).toBe(30);
    const list = await api<{ items: Array<{ entity_id: string }> }>(route.GET, "/api/recent?limit=8", { expect: 200 });
    expect(list.body.items).toHaveLength(8);
    expect(list.body.items[0].entity_id).toBe("o5");
    setScope(org, { userId: "other-member" });
    const other = await api<{ items: unknown[] }>(route.GET, "/api/recent", { expect: 200 });
    expect(other.body.items).toHaveLength(0);
    setScope(org);
  });

  it("favourites: unique, idempotent, member isolated, deletable only by owner", async () => {
    const route = await import("@/app/api/favorites/route");
    setScope(null);
    await api(route.GET, "/api/favorites", { expect: 401 });
    setScope(org);
    const a = await api<{ favorite: { id: string } }>(route.POST, "/api/favorites", { json: { kind: "page", label: "CRM", href: "/crm" }, expect: 201 });
    const dup = await api<{ favorite: { id: string } }>(route.POST, "/api/favorites", { json: { kind: "page", label: "CRM", href: "/crm" }, expect: 200 });
    expect(dup.body.favorite.id).toBe(a.body.favorite.id);
    await api(route.POST, "/api/favorites", { json: { kind: "page", label: "x", href: "//evil" }, expect: 400 });
    setScope(org, { userId: "other-member" });
    const theirs = await api<{ favorites: unknown[] }>(route.GET, "/api/favorites", { expect: 200 });
    expect(theirs.body.favorites).toHaveLength(0);
    await call(route.DELETE, req(`/api/favorites?id=${a.body.favorite.id}`, { method: "DELETE" }), {}, 404);
    setScope(org);
    const mine = await api<{ favorites: unknown[] }>(route.GET, "/api/favorites", { expect: 200 });
    expect(mine.body.favorites).toHaveLength(1);
    await call(route.DELETE, req(`/api/favorites?id=${a.body.favorite.id}`, { method: "DELETE" }), {}, 200);
  });

  it("inbox: category filter, snooze hides, read, and member isolation", async () => {
    const route = await import("@/app/api/notifications/inbox/route");
    setScope(null);
    await api(route.GET, "/api/notifications/inbox", { expect: 401 });
    setScope(org);
    const mk = async (subject: string, data: Record<string, unknown>) => {
      const id = randomUUID();
      await sql(
        `INSERT INTO notification_outbox (id, user_id, channel, recipient, subject, data, status, sent_at) VALUES ($1, $2, 'in_app', 'x', $3, $4, 'sent', NOW())`,
        [id, org.dataId, subject, JSON.stringify(data)]
      );
      return id;
    };
    const mine = await mk("Mine billing", { category: "billing", member_user_id: org.userId, href: "/billing" });
    const theirs = await mk("Theirs", { category: "billing", member_user_id: "other-member" });
    const org1 = await mk("Org wide helpdesk", { category: "helpdesk" });

    const all = await api<{ items: Array<{ id: string; category: string }>; unread: number }>(route.GET, "/api/notifications/inbox", { expect: 200 });
    const got = all.body.items.map((i) => i.id);
    expect(got).toContain(mine);
    expect(got).toContain(org1);
    expect(got).not.toContain(theirs);
    expect(all.body.unread).toBe(2);

    const billing = await api<{ items: Array<{ id: string }> }>(route.GET, "/api/notifications/inbox?category=billing", { expect: 200 });
    expect(billing.body.items.map((i) => i.id)).toEqual([mine]);

    // Member isolation on writes: other member cannot snooze or read my item, nor can they touch rows addressed to them only.
    setScope(org, { userId: "other-member" });
    const bad = await api<{ count: number }>(route.PATCH, "/api/notifications/inbox", { method: "PATCH", json: { action: "snooze", ids: [mine], snooze: "1h" }, expect: 200 });
    expect(bad.body.count).toBe(0);
    setScope(org);

    const sn = await api<{ count: number; until: string }>(route.PATCH, "/api/notifications/inbox", { method: "PATCH", json: { action: "snooze", ids: [mine], snooze: "1h", tz_offset: 0 }, expect: 200 });
    expect(sn.body.count).toBe(1);
    const after = await api<{ items: Array<{ id: string }>; unread: number }>(route.GET, "/api/notifications/inbox", { expect: 200 });
    expect(after.body.items.map((i) => i.id)).not.toContain(mine);
    expect(after.body.unread).toBe(1);
    // Snooze elapses -> returns as unread.
    await sql(`UPDATE notification_outbox SET snoozed_until = NOW() - INTERVAL '1 minute' WHERE id = $1`, [mine]);
    const back = await api<{ unread: number }>(route.GET, "/api/notifications/inbox", { expect: 200 });
    expect(back.body.unread).toBe(2);

    await api(route.PATCH, "/api/notifications/inbox", { method: "PATCH", json: { action: "read", all: true }, expect: 200 });
    const read = await api<{ unread: number }>(route.GET, "/api/notifications/inbox?unread=1", { expect: 200 });
    expect(read.body.unread).toBe(0);
    await api(route.PATCH, "/api/notifications/inbox", { method: "PATCH", json: { action: "bogus" }, expect: 400 });
    // The row addressed to the other member stays untouched.
    const row = await sql<{ read_at: string | null }>(`SELECT read_at FROM notification_outbox WHERE id = $1`, [theirs]);
    expect(row[0].read_at).toBeNull();
  });
});
