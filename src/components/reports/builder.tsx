"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Play, Plus, Save, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { Banner, Empty, Skeleton, SkeletonList } from "@/components/ui/feedback";
import { Dialog, DialogFooter } from "@/components/ui/dialog";
import { isAbortError, useAbortable, useDebouncedValue } from "@/components/ui/hooks";
import { api } from "@/components/finance/shared";
import { ReportChart } from "./report-chart";
import { ReportTable } from "./report-table";
import { CHART_TYPES, type ChartConfig, type ReportFilter, type ReportSpec } from "@/lib/reports/spec";
import type { DatasetDescription } from "@/lib/reports/datasets";
import { EMPTY_CHART, OP_LABELS, PRESET_LABELS, type Catalogue, type RunResult, type SavedReportDTO } from "./types";
import { cn } from "@/lib/utils";

/**
 * Report builder: dataset → group-bys/measures → filters → chart → live preview → save.
 * Selects instead of drag-and-drop so it works on a phone and with a keyboard.
 */

interface Props {
  catalogue: Catalogue | null;
  initial?: SavedReportDTO | null;
  onSaved: (r: SavedReportDTO) => void;
  canEdit: boolean;
}

const FILTER_OPS_BY_KIND: Record<string, string[]> = {
  dimension: ["eq", "neq", "in", "contains", "is_null", "not_null"],
  measure: ["gt", "gte", "lt", "lte", "between", "eq", "is_null"],
  date: ["date_range", "between", "is_null", "not_null"],
};

function pretty(k: string) {
  return k.replace(/_/g, " ");
}

export function ReportBuilder({ catalogue, initial, onSaved, canEdit }: Props) {
  const [spec, setSpec] = useState<ReportSpec>(() => initial?.spec ?? { dataset: catalogue?.datasets[0]?.key ?? "", filters: [{ field: catalogue?.datasets[0]?.default_date ?? "created_at", op: "date_range", value: { preset: "last_30_days" } }], group_by: [], measures: [{ agg: "count" }] });
  const [chart, setChart] = useState<ChartConfig>(initial?.chart ?? EMPTY_CHART);
  const [result, setResult] = useState<RunResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const nextSignal = useAbortable();

  useEffect(() => {
    if (!spec.dataset && catalogue?.datasets[0]) setSpec((s) => ({ ...s, dataset: catalogue.datasets[0].key, filters: [{ field: catalogue.datasets[0].default_date, op: "date_range", value: { preset: "last_30_days" } }] }));
  }, [catalogue, spec.dataset]);

  const ds: DatasetDescription | null = useMemo(() => catalogue?.datasets.find((d) => d.key === spec.dataset) ?? null, [catalogue, spec.dataset]);
  const dims = ds?.fields.filter((f) => f.kind !== "measure") ?? [];
  const measures = ds?.fields.filter((f) => f.kind === "measure") ?? [];
  const debounced = useDebouncedValue(JSON.stringify(spec), 400);

  const run = useCallback(async () => {
    if (!spec.dataset) return;
    const signal = nextSignal();
    setRunning(true);
    setError(null);
    try {
      const r = await api<{ result: RunResult }>("/api/reports/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...spec, limit: 500 }), signal });
      setResult(r.result);
    } catch (e) {
      if (isAbortError(e)) return;
      setError(e instanceof Error ? e.message : "Could not run the report.");
    } finally {
      if (!signal.aborted) setRunning(false);
    }
  }, [spec, nextSignal]);

  useEffect(() => {
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  function pickDataset(key: string) {
    const d = catalogue?.datasets.find((x) => x.key === key);
    setSpec({ dataset: key, filters: d ? [{ field: d.default_date, op: "date_range", value: { preset: "last_30_days" } }] : [], group_by: [], measures: [{ agg: "count" }] });
    setChart(EMPTY_CHART);
    setResult(null);
  }

  const update = (patch: Partial<ReportSpec>) => setSpec((s) => ({ ...s, ...patch }));
  const setFilter = (i: number, f: ReportFilter) => update({ filters: spec.filters.map((x, j) => (j === i ? f : x)) });

  if (!catalogue) return <SkeletonList count={4} itemClassName="h-12" label="Loading datasets…" />;
  if (catalogue.datasets.length === 0) return <Empty title="No datasets available" text="Your role cannot view any reportable module yet. Ask an admin to grant view access to a module." />;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
      <aside className="space-y-5" aria-label="Report definition">
        <Field label="Dataset" hint={ds?.description}>
          <Select value={spec.dataset} onChange={(e) => pickDataset(e.target.value)}>
            {catalogue.datasets.map((d) => (
              <option key={d.key} value={d.key}>{d.label}</option>
            ))}
          </Select>
        </Field>

        <Section title="Group by" onAdd={spec.group_by.length < 4 && dims.length > 0 ? () => update({ group_by: [...spec.group_by, { field: dims[0].key }] }) : undefined} addLabel="Add dimension">
          {spec.group_by.length === 0 && <p className="text-xs text-muted-foreground">No grouping: measures are totals across the dataset.</p>}
          {spec.group_by.map((g, i) => {
            const f = ds?.fields.find((x) => x.key === g.field);
            return (
              <Row key={i} onRemove={() => update({ group_by: spec.group_by.filter((_, j) => j !== i) })} label={`Remove group ${i + 1}`}>
                <Select aria-label={`Group ${i + 1} field`} value={g.field} onChange={(e) => update({ group_by: spec.group_by.map((x, j) => (j === i ? { field: e.target.value, bucket: ds?.fields.find((y) => y.key === e.target.value)?.kind === "date" ? "month" : undefined } : x)) })}>
                  {dims.map((d) => (
                    <option key={d.key} value={d.key}>{d.label}</option>
                  ))}
                </Select>
                {f?.kind === "date" && (
                  <Select aria-label={`Group ${i + 1} bucket`} value={g.bucket ?? "month"} onChange={(e) => update({ group_by: spec.group_by.map((x, j) => (j === i ? { ...x, bucket: e.target.value as ReportSpec["group_by"][number]["bucket"] } : x)) })}>
                    {catalogue.buckets.map((b) => (
                      <option key={b} value={b}>{pretty(b)}</option>
                    ))}
                  </Select>
                )}
              </Row>
            );
          })}
        </Section>

        <Section title="Measures" onAdd={spec.measures.length < 8 ? () => update({ measures: [...spec.measures, measures[0] ? { field: measures[0].key, agg: "sum" } : { agg: "count" }] }) : undefined} addLabel="Add measure">
          {spec.measures.map((m, i) => {
            const f = ds?.fields.find((x) => x.key === m.field);
            const aggs = m.field ? (f?.aggregations ?? catalogue.aggregations) : ["count"];
            return (
              <Row key={i} onRemove={spec.measures.length > 1 ? () => update({ measures: spec.measures.filter((_, j) => j !== i) }) : undefined} label={`Remove measure ${i + 1}`}>
                <Select aria-label={`Measure ${i + 1} aggregation`} value={m.agg} onChange={(e) => update({ measures: spec.measures.map((x, j) => (j === i ? { ...x, agg: e.target.value as ReportSpec["measures"][number]["agg"] } : x)) })}>
                  {aggs.map((a) => (
                    <option key={a} value={a}>{pretty(a)}</option>
                  ))}
                </Select>
                <Select aria-label={`Measure ${i + 1} field`} value={m.field ?? ""} onChange={(e) => update({ measures: spec.measures.map((x, j) => (j === i ? { agg: e.target.value ? (x.agg === "count" ? "sum" : x.agg) : "count", field: e.target.value || undefined } : x)) })}>
                  <option value="">rows</option>
                  {(ds?.fields ?? []).map((d) => (
                    <option key={d.key} value={d.key}>{d.label}</option>
                  ))}
                </Select>
              </Row>
            );
          })}
        </Section>

        <Section title="Filters" onAdd={spec.filters.length < 20 && ds ? () => update({ filters: [...spec.filters, { field: ds.fields[0].key, op: ds.fields[0].kind === "date" ? "date_range" : "eq", value: ds.fields[0].kind === "date" ? { preset: "this_month" } : "" }] }) : undefined} addLabel="Add filter">
          {spec.filters.length === 0 && <p className="text-xs text-muted-foreground">No filters: all rows.</p>}
          {spec.filters.map((flt, i) => {
            const f = ds?.fields.find((x) => x.key === flt.field);
            const kind = f?.kind ?? "dimension";
            const ops = FILTER_OPS_BY_KIND[kind];
            const v = flt.value;
            const preset = v && typeof v === "object" && !Array.isArray(v) && "preset" in v ? String(v.preset) : null;
            return (
              <Row key={i} onRemove={() => update({ filters: spec.filters.filter((_, j) => j !== i) })} label={`Remove filter ${i + 1}`}>
                <Select aria-label={`Filter ${i + 1} field`} value={flt.field} onChange={(e) => { const nf = ds?.fields.find((x) => x.key === e.target.value); const k = nf?.kind ?? "dimension"; setFilter(i, { field: e.target.value, op: k === "date" ? "date_range" : k === "measure" ? "gt" : "eq", value: k === "date" ? { preset: "this_month" } : k === "measure" ? 0 : "" }); }}>
                  {(ds?.fields ?? []).map((d) => (
                    <option key={d.key} value={d.key}>{d.label}</option>
                  ))}
                </Select>
                <Select aria-label={`Filter ${i + 1} operator`} value={flt.op} onChange={(e) => { const op = e.target.value as ReportFilter["op"]; setFilter(i, { field: flt.field, op, value: op === "date_range" ? { preset: "this_month" } : op === "between" ? ["", ""] : op === "in" || op === "not_in" ? [] : op === "is_null" || op === "not_null" ? undefined : "" }); }}>
                  {ops.map((o) => (
                    <option key={o} value={o}>{OP_LABELS[o] ?? o}</option>
                  ))}
                </Select>
                {flt.op === "date_range" && (
                  <Select aria-label={`Filter ${i + 1} range`} value={preset ?? "custom"} onChange={(e) => setFilter(i, { ...flt, value: e.target.value === "custom" ? { from: "", to: "" } : { preset: e.target.value as "today" } })}>
                    {catalogue.presets.map((p) => (
                      <option key={p} value={p}>{PRESET_LABELS[p] ?? pretty(p)}</option>
                    ))}
                    <option value="custom">Custom dates…</option>
                  </Select>
                )}
                {flt.op === "date_range" && !preset && v && typeof v === "object" && !Array.isArray(v) && (
                  <div className="grid grid-cols-2 gap-2">
                    <Input type="date" aria-label={`Filter ${i + 1} from date`} className="min-w-0" value={"from" in v ? (v.from ?? "") : ""} onChange={(e) => setFilter(i, { ...flt, value: { from: e.target.value, to: "to" in v ? (v.to ?? "") : "" } })} />
                    <Input type="date" aria-label={`Filter ${i + 1} to date`} className="min-w-0" value={"to" in v ? (v.to ?? "") : ""} onChange={(e) => setFilter(i, { ...flt, value: { from: "from" in v ? (v.from ?? "") : "", to: e.target.value } })} />
                  </div>
                )}
                {flt.op === "between" && Array.isArray(v) && (
                  <div className="grid grid-cols-2 gap-2">
                    <Input type={kind === "date" ? "date" : "number"} aria-label={`Filter ${i + 1} lower bound`} className="min-w-0" value={String(v[0] ?? "")} onChange={(e) => setFilter(i, { ...flt, value: [kind === "measure" ? Number(e.target.value) : e.target.value, v[1] ?? ""] })} />
                    <Input type={kind === "date" ? "date" : "number"} aria-label={`Filter ${i + 1} upper bound`} className="min-w-0" value={String(v[1] ?? "")} onChange={(e) => setFilter(i, { ...flt, value: [v[0] ?? "", kind === "measure" ? Number(e.target.value) : e.target.value] })} />
                  </div>
                )}
                {(flt.op === "in" || flt.op === "not_in") && (
                  <Input aria-label={`Filter ${i + 1} values (comma separated)`} placeholder="a, b, c" value={Array.isArray(v) ? v.join(", ") : ""} onChange={(e) => setFilter(i, { ...flt, value: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} />
                )}
                {["eq", "neq", "contains", "gt", "gte", "lt", "lte"].includes(flt.op) && (
                  <Input type={kind === "measure" ? "number" : "text"} aria-label={`Filter ${i + 1} value`} value={typeof v === "string" || typeof v === "number" ? String(v) : ""} onChange={(e) => setFilter(i, { ...flt, value: kind === "measure" ? Number(e.target.value) : e.target.value })} />
                )}
              </Row>
            );
          })}
        </Section>

        <Section title="Chart">
          <div role="group" aria-label="Chart type" className="grid grid-cols-3 gap-1 rounded-lg border border-border bg-card p-1 sm:flex sm:flex-wrap">
            {CHART_TYPES.map((t) => (
              <button key={t} type="button" aria-pressed={chart.type === t} onClick={() => setChart((c) => ({ ...c, type: t }))} className={cn("inline-flex min-h-11 flex-1 items-center justify-center rounded-md px-2 text-sm font-medium capitalize focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8", chart.type === t ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground")}>
                {t}
              </button>
            ))}
          </div>
          {result && chart.type !== "table" && chart.type !== "kpi" && (
            <div className="grid grid-cols-2 gap-2">
              <Field label="X axis">
                <Select value={chart.x ?? ""} onChange={(e) => setChart((c) => ({ ...c, x: e.target.value || null }))}>
                  <option value="">Auto</option>
                  {result.columns.filter((c) => c.kind !== "measure").map((c) => (
                    <option key={c.key} value={c.key}>{c.label}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Series">
                <Select value={chart.series ?? ""} onChange={(e) => setChart((c) => ({ ...c, series: e.target.value || null }))}>
                  <option value="">None</option>
                  {result.columns.filter((c) => c.kind !== "measure").map((c) => (
                    <option key={c.key} value={c.key}>{c.label}</option>
                  ))}
                </Select>
              </Field>
            </div>
          )}
        </Section>

        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" touch onClick={() => void run()} disabled={running}>
            <Play className="h-4 w-4" aria-hidden /> Run
          </Button>
          {canEdit && (
            <Button type="button" touch onClick={() => setSaveOpen(true)} disabled={!result}>
              <Save className="h-4 w-4" aria-hidden /> {initial ? "Save changes" : "Save report"}
            </Button>
          )}
        </div>
      </aside>

      <section aria-labelledby="preview-heading" aria-busy={running || undefined} className="min-w-0 space-y-4">
        <h2 id="preview-heading" className="sr-only">Preview</h2>
        {error && <Banner tone="error" onDismiss={() => setError(null)}>{error}</Banner>}
        <p className="sr-only" role="status" aria-live="polite">
          {running ? "Running the report…" : result ? `Report ready: ${result.row_count} row${result.row_count === 1 ? "" : "s"}${result.truncated ? ", limited to the first 500" : ""}.` : ""}
        </p>
        {!result && running && (
          <div className="space-y-4" aria-hidden>
            <Skeleton className="h-4 w-40" />
            {chart.type !== "table" && <Skeleton className="h-64 rounded-xl" />}
            <div className="space-y-2">
              <Skeleton className="h-9 rounded-lg" />
              <Skeleton className="h-9 rounded-lg" />
              <Skeleton className="h-9 rounded-lg" />
              <Skeleton className="h-9 rounded-lg" />
            </div>
          </div>
        )}
        {!result && !running && !error && <Empty title="Preview appears here" text="Pick a dataset, then add groups, measures and filters. The preview re-runs as you change them." />}
        {result && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span className="tabular-nums">{result.row_count} row{result.row_count === 1 ? "" : "s"}{result.truncated ? " (limited to 500)" : ""} · {result.timezone}</span>
              {running && <span className="inline-flex items-center gap-1"><Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden /> Refreshing…</span>}
            </div>
            {chart.type !== "table" && (
              <div className={cn("rounded-xl border border-border bg-card p-4 transition-opacity motion-reduce:transition-none", running && "opacity-60")}>
                <ReportChart rows={result.rows} columns={result.columns} chart={chart} currency={result.currency} />
              </div>
            )}
            {result.rows.length === 0 ? (
              <Empty
                title="No rows match"
                text="Loosen the filters or widen the date range."
                action={spec.filters.length > 0 ? <Button type="button" variant="outline" touch onClick={() => update({ filters: [] })}>Clear filters</Button> : undefined}
              />
            ) : (
              <ReportTable rows={result.rows} columns={result.columns} totals={result.totals} currency={result.currency} label="Report preview" max={100} className={cn("transition-opacity motion-reduce:transition-none", running && "opacity-60")} />
            )}
          </>
        )}
      </section>

      {saveOpen && <SaveDialog initial={initial ?? null} spec={spec} chart={chart} onClose={() => setSaveOpen(false)} onSaved={(r) => { setSaveOpen(false); onSaved(r); }} />}
    </div>
  );
}

function Section({ title, children, onAdd, addLabel }: { title: string; children: React.ReactNode; onAdd?: () => void; addLabel?: string }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
        {onAdd && (
          <Button type="button" size="sm" variant="ghost" touch onClick={onAdd} aria-label={addLabel}>
            <Plus className="h-4 w-4" aria-hidden /> Add
          </Button>
        )}
      </div>
      {children}
    </div>
  );
}

function Row({ children, onRemove, label }: { children: React.ReactNode; onRemove?: () => void; label: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-border bg-card p-2">
      <div className="grid min-w-0 flex-1 gap-2">{children}</div>
      {onRemove && (
        <Button type="button" size="icon" variant="ghost" touch onClick={onRemove} aria-label={label} className="shrink-0">
          <X className="h-4 w-4" aria-hidden />
        </Button>
      )}
    </div>
  );
}

function SaveDialog({ initial, spec, chart, onClose, onSaved }: { initial: SavedReportDTO | null; spec: ReportSpec; chart: ChartConfig; onClose: () => void; onSaved: (r: SavedReportDTO) => void }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [visibility, setVisibility] = useState<"private" | "org">(initial?.visibility ?? "org");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const body = JSON.stringify({ name, description: description || null, spec, chart, visibility });
      const r = initial
        ? await api<{ report: SavedReportDTO }>(`/api/reports/saved/${initial.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body })
        : await api<{ report: SavedReportDTO }>("/api/reports/saved", { method: "POST", headers: { "content-type": "application/json" }, body });
      onSaved(r.report);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <Dialog title={initial ? "Save changes" : "Save report"} onClose={onClose} size="sm">
      <form onSubmit={submit} className="space-y-4">
        {error && <Banner tone="error">{error}</Banner>}
        <Field label="Name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} autoFocus />
        </Field>
        <Field label="Description">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={1000} />
        </Field>
        <Field label="Visibility" hint="Org reports are visible to everyone who can view Reports.">
          <Select value={visibility} onChange={(e) => setVisibility(e.target.value as "private" | "org")}>
            <option value="org">Whole workspace</option>
            <option value="private">Only me</option>
          </Select>
        </Field>
        <DialogFooter>
          <Button type="button" variant="outline" touch onClick={onClose}>Cancel</Button>
          <Button type="submit" touch disabled={saving || !name.trim()}>{saving ? "Saving…" : "Save"}</Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

