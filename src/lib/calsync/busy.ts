import { query } from "@/lib/dsql";
import type { Interval } from "@/lib/calendar/slots";

/** External busy windows (times only) for an org between `lo` and `hi`. Fails soft before the migration. */
export async function externalBusyIntervals(dataId: string, lo: Date, hi: Date): Promise<Interval[]> {
  try {
    const rows = await query<{ starts_at: string; ends_at: string }>(
      `SELECT b.starts_at, b.ends_at FROM external_busy b
         JOIN calendar_connections c ON c.id = b.connection_id
        WHERE b.user_id = $1 AND c.status <> 'disabled' AND b.starts_at < $3 AND b.ends_at > $2`,
      [dataId, lo.toISOString(), hi.toISOString()]
    );
    return rows.map((r) => ({ start: new Date(r.starts_at), end: new Date(r.ends_at) }));
  } catch {
    return [];
  }
}
