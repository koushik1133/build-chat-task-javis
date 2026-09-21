import { query, queryOne, withRetry } from "@/lib/dsql";

/**
 * Per-org sequential document numbers ("Q-000001", "INV-000001").
 *
 * No sequences in DSQL, so we read the counter and do a conditional UPDATE
 * (WHERE next_value = old). A lost race yields zero rows or an OC conflict;
 * either way we retry via withRetry.
 */

export type DocKind = "quote" | "invoice";

const PREFIX: Record<DocKind, string> = { quote: "Q", invoice: "INV" };

export function formatDocNumber(kind: DocKind, n: number): string {
  return `${PREFIX[kind]}-${String(n).padStart(6, "0")}`;
}

class CounterRace extends Error {
  code = "40001";
  constructor() {
    super("doc counter race (OC000)");
  }
}

export async function nextDocNumber(dataId: string, kind: DocKind): Promise<string> {
  return withRetry(async () => {
    const row = await queryOne<{ next_value: number | string }>(
      `SELECT next_value FROM doc_counters WHERE user_id = $1 AND kind = $2`,
      [dataId, kind]
    );
    if (!row) {
      // First document for this org/kind: claim 1, reserve 2.
      const inserted = await query<{ user_id: string }>(
        `INSERT INTO doc_counters (user_id, kind, next_value) VALUES ($1, $2, 2)
         ON CONFLICT (user_id, kind) DO NOTHING RETURNING user_id`,
        [dataId, kind]
      );
      if (inserted.length === 0) throw new CounterRace();
      return formatDocNumber(kind, 1);
    }
    const old = Number(row.next_value);
    const updated = await query<{ user_id: string }>(
      `UPDATE doc_counters SET next_value = $3 WHERE user_id = $1 AND kind = $2 AND next_value = $4 RETURNING user_id`,
      [dataId, kind, old + 1, old]
    );
    if (updated.length === 0) throw new CounterRace();
    return formatDocNumber(kind, old);
  }, 6);
}
