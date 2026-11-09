/**
 * In-memory metrics registry (per server instance) rendered in Prometheus
 * text exposition format. Counters and histograms only; DB-derived gauges are
 * added at scrape time by collect.ts. Label cardinality is kept low by callers
 * (route *groups*, status classes).
 */

export type Labels = Record<string, string>;

export const LATENCY_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

interface Counter { help: string; values: Map<string, { labels: Labels; v: number }> }
interface Histogram { help: string; buckets: number[]; series: Map<string, { labels: Labels; counts: number[]; sum: number; count: number }> }

interface Store { counters: Map<string, Counter>; histograms: Map<string, Histogram> }
const g = globalThis as unknown as { __khMetrics?: Store };
const store: Store = (g.__khMetrics ??= { counters: new Map(), histograms: new Map() });

function key(labels: Labels): string {
  return Object.keys(labels).sort().map((k) => `${k}=${labels[k]}`).join("\u0001");
}

export function incCounter(name: string, help: string, labels: Labels = {}, by = 1): void {
  let c = store.counters.get(name);
  if (!c) store.counters.set(name, (c = { help, values: new Map() }));
  const k = key(labels);
  const cur = c.values.get(k);
  if (cur) cur.v += by;
  else if (c.values.size < 500) c.values.set(k, { labels, v: by });
}

export function observe(name: string, help: string, value: number, labels: Labels = {}, buckets: number[] = LATENCY_BUCKETS_MS): void {
  let h = store.histograms.get(name);
  if (!h) store.histograms.set(name, (h = { help, buckets, series: new Map() }));
  const k = key(labels);
  let s = h.series.get(k);
  if (!s) {
    if (h.series.size >= 200) return;
    s = { labels, counts: new Array(h.buckets.length).fill(0) as number[], sum: 0, count: 0 };
    h.series.set(k, s);
  }
  for (let i = 0; i < h.buckets.length; i++) if (value <= h.buckets[i]) s.counts[i]++;
  s.sum += value;
  s.count++;
}

export function statusClass(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}

export function recordRequest(group: string, status: number, ms: number): void {
  const labels = { group, status: statusClass(status) };
  incCounter("kh_http_requests_total", "HTTP requests handled, by route group and status class.", labels);
  observe("kh_http_request_duration_ms", "HTTP request latency in milliseconds, by route group.", ms, { group });
}

export function recordRateLimitBlock(name: string): void {
  incCounter("kh_rate_limit_blocks_total", "Requests rejected by a rate limiter.", { limiter: name.slice(0, 40) });
}

export function recordErrorCapture(): void {
  incCounter("kh_errors_captured_total", "Errors captured into app_errors.");
}

export function recordCronMetrics(durationMs: number, counts: Record<string, number>): void {
  observe("kh_cron_tick_duration_ms", "Cron tick duration in milliseconds.", durationMs, {}, [500, 1000, 2500, 5000, 10000, 20000, 45000, 60000]);
  incCounter("kh_cron_ticks_total", "Cron ticks completed.");
  for (const [k, v] of Object.entries(counts)) if (k !== "ms" && Number.isFinite(v) && v > 0) incCounter("kh_cron_items_total", "Items processed by cron tick, by kind.", { kind: k }, v);
}

// ── rendering ────────────────────────────────────────────────────────────────

export function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}
function escapeHelp(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}
function fmtLabels(labels: Labels, extra: Labels = {}): string {
  const all = { ...labels, ...extra };
  const parts = Object.keys(all).map((k) => `${k}="${escapeLabelValue(all[k])}"`);
  return parts.length ? `{${parts.join(",")}}` : "";
}
function num(n: number): string {
  return Number.isFinite(n) ? String(n) : n > 0 ? "+Inf" : "-Inf";
}

export interface Gauge { name: string; help: string; value: number; labels?: Labels }

export function renderPrometheus(gauges: Gauge[] = []): string {
  const out: string[] = [];
  for (const [name, c] of [...store.counters.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    out.push(`# HELP ${name} ${escapeHelp(c.help)}`, `# TYPE ${name} counter`);
    for (const { labels, v } of c.values.values()) out.push(`${name}${fmtLabels(labels)} ${num(v)}`);
  }
  for (const [name, h] of [...store.histograms.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    out.push(`# HELP ${name} ${escapeHelp(h.help)}`, `# TYPE ${name} histogram`);
    for (const s of h.series.values()) {
      h.buckets.forEach((b, i) => out.push(`${name}_bucket${fmtLabels(s.labels, { le: String(b) })} ${s.counts[i]}`));
      out.push(`${name}_bucket${fmtLabels(s.labels, { le: "+Inf" })} ${s.count}`);
      out.push(`${name}_sum${fmtLabels(s.labels)} ${num(s.sum)}`, `${name}_count${fmtLabels(s.labels)} ${s.count}`);
    }
  }
  const seen = new Set<string>();
  for (const gg of gauges) {
    if (!seen.has(gg.name)) {
      out.push(`# HELP ${gg.name} ${escapeHelp(gg.help)}`, `# TYPE ${gg.name} gauge`);
      seen.add(gg.name);
    }
    out.push(`${gg.name}${fmtLabels(gg.labels ?? {})} ${num(gg.value)}`);
  }
  return out.join("\n") + "\n";
}

export function resetMetrics(): void {
  store.counters.clear();
  store.histograms.clear();
}
