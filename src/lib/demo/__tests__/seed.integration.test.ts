import { randomUUID } from "crypto";
import { afterAll, describe, expect, it } from "vitest";
import { INTEGRATION } from "@/__integration__/setup";

/**
 * DB-backed round trip for the demo seeder. Run with:
 *   DB_INTEGRATION=1 npx vitest run src/lib/demo/__tests__/seed.integration.test.ts
 * Requires local Postgres with aws/phase5/c.sql applied.
 */
describe.skipIf(!INTEGRATION)("demo seed (integration)", () => {
  const dataId = `test-demo-${randomUUID()}`;

  afterAll(async () => {
    const { clearDemoData } = await import("../seed");
    await clearDemoData(dataId).catch(() => undefined);
  });

  it("seeds, is idempotent, and clears only its rows", async () => {
    const { seedDemoWorkspace, clearDemoData, hasDemoData } = await import("../seed");
    const { query } = await import("@/lib/dsql");

    const first = await seedDemoWorkspace(dataId, { industry: "agency" });
    expect(first.seeded).toBe(true);
    expect(first.created.contacts).toBe(12);
    expect(first.created.quotes).toBe(6);
    expect(first.created.invoices).toBe(2);
    expect(first.created.bookings).toBe(8);
    expect(first.created.tickets).toBe(5);
    expect(first.created.tasks).toBe(10);
    expect(first.created.records).toBe(6);
    expect(first.created.products).toBe(4);
    expect(first.warnings, first.warnings.join("\n")).toEqual([]);
    expect(await hasDemoData(dataId)).toBe(true);

    const again = await seedDemoWorkspace(dataId, { industry: "agency" });
    expect(again.seeded).toBe(false);

    // A non-demo row must survive the clear.
    await query(`INSERT INTO tasks (user_id, title) VALUES ($1, 'keep me')`, [dataId]);

    const cleared = await clearDemoData(dataId);
    expect(cleared.removed.contact).toBe(12);
    expect(await hasDemoData(dataId)).toBe(false);
    const left = await query<{ title: string }>(`SELECT title FROM tasks WHERE user_id = $1`, [dataId]);
    expect(left.map((r) => r.title)).toEqual(["keep me"]);
    const contacts = await query(`SELECT id FROM crm_contacts WHERE user_id = $1`, [dataId]);
    expect(contacts).toHaveLength(0);
    await query(`DELETE FROM tasks WHERE user_id = $1`, [dataId]);
  });
});
