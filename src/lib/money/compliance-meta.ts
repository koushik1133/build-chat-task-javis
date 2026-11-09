import { query } from "@/lib/dsql";
import type { DocumentTotals } from "./tax-rates";

/**
 * Persist regime metadata on a quote/invoice row (no-op when the totals carry none,
 * i.e. the org has no tax profile). Columns come from aws/phase11/d.sql.
 */
export async function saveComplianceMeta(table: "quotes" | "invoices", dataId: string, id: string, totals: DocumentTotals): Promise<void> {
  const m = totals.compliance;
  if (!m) return;
  await query(`UPDATE ${table} SET place_of_supply = $3, reverse_charge = $4, tax_regime = $5 WHERE id = $1 AND user_id = $2`, [id, dataId, m.place_of_supply, m.reverse_charge, m.regime]).catch(() => undefined);
}
