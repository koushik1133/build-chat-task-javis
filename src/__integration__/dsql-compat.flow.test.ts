/**
 * DSQL-compat helpers against real Postgres: batched write helpers cap statements at 1000 rows,
 * catalog probes agree with information_schema, and the ref_key unique index makes payments idempotent.
 */
import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { query } from "@/lib/dsql";
import { deleteInBatches, insertInBatches, updateInBatches } from "@/lib/db/batch";
import { columnsOfVia, tableExistsVia } from "@/lib/db/catalog";
import { describeDb, sql } from "./setup";

describeDb("dsql-compat flow", () => {
  const prefix = `itest-dsql-${randomUUID().slice(0, 8)}`;
  afterAll(async () => {
    await sql(`DELETE FROM rate_limits WHERE key LIKE $1`, [`${prefix}%`]);
  });

  it("inserts, updates and removes 2,500 rows in <= 1000-row statements", async () => {
    const now = new Date().toISOString();
    const rows = Array.from({ length: 2500 }, (_, i) => [`${prefix}-${String(i).padStart(5, "0")}`, 1, now, now]);
    expect(await insertInBatches("rate_limits", ["key", "count", "window_start", "updated_at"], rows, 500)).toBe(2500);

    const statementSizes: number[] = [];
    const run = async (s: string, p: unknown[]) => {
      const out = await query<{ id: string }>(s, p);
      statementSizes.push(out.length);
      return out;
    };
    const updated = await updateInBatches("rate_limits", "count = 2", "key LIKE $1", [`${prefix}%`], [], 1000, { run, idColumn: "key" });
    expect(updated).toBe(2500);
    expect(Math.max(...statementSizes)).toBeLessThanOrEqual(1000);
    const [{ n }] = await sql<{ n: string }>(`SELECT COUNT(*)::text AS n FROM rate_limits WHERE key LIKE $1 AND count = 2`, [`${prefix}%`]);
    expect(Number(n)).toBe(2500);

    statementSizes.length = 0;
    const removed = await deleteInBatches("rate_limits", "key LIKE $1", [`${prefix}%`], 1000, { run, idColumn: "key" });
    expect(removed).toBe(2500);
    expect(statementSizes).toEqual([1000, 1000, 500]);
  });

  it("catalog probes work and agree with information_schema", async () => {
    const q = (s: string, p?: unknown[]) => query(s, p ?? []);
    expect(await tableExistsVia(q, "invoice_payments")).toBe(true);
    expect(await tableExistsVia(q, "definitely_not_a_table")).toBe(false);
    const cols = await columnsOfVia(q, ["invoice_payments"]);
    expect(cols.get("invoice_payments")).toEqual(expect.arrayContaining(["id", "invoice_id", "provider_ref", "ref_key"]));
  });

  it("ref_key unique index rejects a duplicate (invoice, provider, ref) and allows many NULL-ref rows", async () => {
    const inv = `itest-inv-${randomUUID()}`;
    const ins = (ref: string | null) => {
      const id = randomUUID();
      return sql(`INSERT INTO invoice_payments (id, invoice_id, provider, provider_ref, ref_key, amount_minor, currency, status) VALUES ($1, $2, 'simulated', $3, $4, 100, 'USD', 'succeeded')`, [id, inv, ref, ref ?? id]);
    };
    try {
      await ins("ref-1");
      await expect(ins("ref-1")).rejects.toMatchObject({ code: "23505" });
      await ins(null);
      await ins(null);
      const [{ n }] = await sql<{ n: string }>(`SELECT COUNT(*)::text AS n FROM invoice_payments WHERE invoice_id = $1`, [inv]);
      expect(Number(n)).toBe(3);
    } finally {
      await sql(`DELETE FROM invoice_payments WHERE invoice_id = $1`, [inv]);
    }
  });
});
