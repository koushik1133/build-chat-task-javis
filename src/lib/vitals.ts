import { randomUUID } from "crypto";
import { z } from "zod";
import { query } from "@/lib/dsql";
import { tableExists } from "@/lib/table-exists";
import { deleteInBatches } from "@/lib/db/batch";

/**
 * Core Web Vitals storage (table `web_vitals`, aws/phase6/d.sql).
 *
 * Samples are anonymous — no user id, org id, IP, user agent or full URL is
 * stored. `path` is the *route pattern* when the client knows it
 * (`/r/[type]`), otherwise the pathname with ids collapsed by
 * `normalisePath()`. Aggregates are therefore global to the deployment, not
 * tenant-scoped; the System health page labels them as such.
 */

export const VITAL_NAMES = ["LCP", "CLS", "INP", "TTFB", "FCP"] as const;
export type VitalName = (typeof VITAL_NAMES)[number];
export const VITAL_RATINGS = ["good", "needs-improvement", "poor"] as const;

export const VitalSchema = z
  .object({
    name: z.enum(VITAL_NAMES),
    value: z.number().finite().min(0).max(600_000),
    rating: z.enum(VITAL_RATINGS),
    path: z.string().trim().min(1).max(200),
    navigation_type: z.string().trim().max(40).optional(),
  })
  .strict();
export type VitalSample = z.infer<typeof VitalSchema>;

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const LONG_ID_RE = /\/[A-Za-z0-9_-]{20,}(?=\/|$)/g;
const NUMERIC_RE = /\/\d+(?=\/|$)/g;

/** Collapse ids so `/crm/abc-123` and `/crm/def-456` land in one bucket; strips query/hash. */
export function normalisePath(raw: string): string {
  let p = raw.split(/[?#]/)[0] || "/";
  if (!p.startsWith("/")) p = `/${p}`;
  p = p.replace(UUID_RE, "[id]").replace(LONG_ID_RE, "/[id]").replace(NUMERIC_RE, "/[id]");
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p.slice(0, 200) || "/";
}

export async function recordVital(sample: VitalSample): Promise<boolean> {
  if (!(await tableExists("web_vitals"))) return false;
  await query(
    `INSERT INTO web_vitals (id, path, name, value, rating, navigation_type, created_at) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
    [randomUUID(), normalisePath(sample.path), sample.name, sample.value, sample.rating, sample.navigation_type ?? null]
  );
  return true;
}

export interface VitalsRouteRow {
  path: string;
  name: VitalName;
  /** 75th percentile of `value` over the window. */
  p75: number;
  samples: number;
  /** Share of samples rated "good" (0..1). */
  good_share: number;
}

export interface VitalsSummary {
  /** Always true: aggregates span every workspace on this deployment. */
  global: true;
  windowHours: number;
  rows: VitalsRouteRow[];
}

interface AggRow { path: string; name: string; p75: number | string | null; samples: number | string; good: number | string }

/** percentile_cont-compatible (linear interpolation) percentile over unsorted values; `q` in [0,1]. */
export function percentileCont(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const v = [...values].sort((a, b) => a - b);
  const pos = (v.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}

/** JS fallback for the SQL p75 aggregate: group by (path, name), busiest first. */
export function aggregateVitalsInJs(raw: Array<{ path: string; name: string; value: number | string; rating: string | null }>): AggRow[] {
  const groups = new Map<string, { path: string; name: string; values: number[]; good: number }>();
  for (const r of raw) {
    const v = Number(r.value);
    if (!Number.isFinite(v)) continue;
    const k = `${r.path}\u0000${r.name}`;
    const g = groups.get(k) ?? { path: r.path, name: r.name, values: [], good: 0 };
    g.values.push(v);
    if (r.rating === "good") g.good++;
    groups.set(k, g);
  }
  return [...groups.values()]
    .map((g) => ({ path: g.path, name: g.name, p75: percentileCont(g.values, 0.75), samples: g.values.length, good: g.good }))
    .sort((a, b) => b.samples - a.samples || a.path.localeCompare(b.path) || a.name.localeCompare(b.name));
}

/** p75 by (path, metric) over the last `windowHours`, busiest routes first. */
export async function summariseVitals(windowHours = 24, maxRoutes = 30): Promise<VitalsSummary | null> {
  if (!(await tableExists("web_vitals"))) return null;
  const hours = Math.min(Math.max(Math.floor(windowHours), 1), 24 * 30);
  let rows: AggRow[];
  try {
    rows = await query<AggRow>(
      `SELECT path, name,
              percentile_cont(0.75) WITHIN GROUP (ORDER BY value) AS p75,
              COUNT(*) AS samples,
              SUM(CASE WHEN rating = 'good' THEN 1 ELSE 0 END) AS good
         FROM web_vitals
        WHERE created_at > NOW() - ($1::int * INTERVAL '1 hour')
        GROUP BY path, name
        ORDER BY COUNT(*) DESC, path ASC, name ASC
        LIMIT $2`,
      [hours, maxRoutes * VITAL_NAMES.length]
    );
  } catch (err) {
    // Ordered-set aggregates may be unavailable on Aurora DSQL: aggregate in JS from bounded raw rows.
    console.warn("[vitals] percentile_cont unavailable, aggregating in JS:", err instanceof Error ? err.message : err);
    const raw = await query<{ path: string; name: string; value: number | string; rating: string | null }>(
      `SELECT path, name, value, rating FROM web_vitals WHERE created_at > NOW() - ($1::int * INTERVAL '1 hour') ORDER BY created_at DESC LIMIT 20000`,
      [hours]
    );
    rows = aggregateVitalsInJs(raw).slice(0, maxRoutes * VITAL_NAMES.length);
  }
  return {
    global: true,
    windowHours: hours,
    rows: rows
      .filter((r): r is AggRow & { name: VitalName } => (VITAL_NAMES as readonly string[]).includes(r.name))
      .map((r) => {
        const samples = Number(r.samples) || 0;
        return {
          path: r.path,
          name: r.name,
          p75: Math.round((Number(r.p75) || 0) * 1000) / 1000,
          samples,
          good_share: samples ? Math.round((Number(r.good) / samples) * 1000) / 1000 : 0,
        };
      }),
  };
}

/** Delete samples older than `days` (cron-friendly; returns rows removed). */
export async function pruneVitals(days = 30): Promise<number> {
  if (!(await tableExists("web_vitals"))) return 0;
  return deleteInBatches("web_vitals", "created_at < NOW() - ($1::int * INTERVAL '1 day')", [Math.max(1, Math.floor(days))]);
}
