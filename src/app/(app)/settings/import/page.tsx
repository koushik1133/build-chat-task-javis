"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { UpgradePrompt } from "@/components/plans/upgrade-prompt";
import { CheckCircle2, Download, FileSpreadsheet, FlaskConical, Loader2, RefreshCw, Sparkles, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { Banner, Skeleton } from "@/components/ui/feedback";
import { Pill, type Tone } from "@/components/ui/pill";
import { TableScroller } from "@/components/ui/table-scroller";
import { PageContainer } from "@/components/page-container";
import { cn, timeAgo } from "@/lib/utils";
import type { ImportField, ImportTargetKey } from "@/lib/import/targets";
import type { MappingSuggestion } from "@/lib/import/mapping";
import type { ImportJobRow, ImportResult } from "@/lib/import/run";

interface TargetInfo {
  key: ImportTargetKey;
  label: string;
  description: string;
  fields: ImportField[];
  dedupeKey: string[];
}

interface Preview {
  target: { key: ImportTargetKey; label: string; fields: ImportField[]; dedupeKey: string[] };
  headers: string[];
  delimiter: string;
  rowCount: number;
  sample: string[][];
  suggestion: MappingSuggestion;
}

const EXPORTS: Array<{ key: string; label: string; hint: string }> = [
  { key: "contacts", label: "Contacts", hint: "CRM people and companies" },
  { key: "leads", label: "Leads", hint: "Lead inbox submissions" },
  { key: "tasks", label: "Tasks", hint: "To-dos" },
  { key: "bookings", label: "Bookings", hint: "Calendar appointments" },
  { key: "quotes", label: "Quotes", hint: "Sent and accepted quotes" },
  { key: "invoices", label: "Invoices", hint: "Invoices with line items" },
  { key: "tickets", label: "Tickets", hint: "Helpdesk tickets" },
  { key: "records", label: "Records", hint: "Custom record types (filter by type slug)" },
];

const TYPE_LABEL: Record<ImportField["type"], string> = {
  string: "text",
  email: "email",
  phone: "phone",
  number: "number",
  money: "amount",
  date: "date",
  datetime: "date & time",
  boolean: "yes / no",
  enum: "choice",
  tags: "tags",
};

const JOB_TONE: Record<string, Tone> = { dry_run: "neutral", failed: "danger", done: "success", completed: "success" };

const STEP_HEADING = "flex items-center gap-2 text-sm font-semibold";
const STEP_BADGE = "flex h-6 w-6 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground";
const spinner = <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />;
const EXPORT_LINK =
  "inline-flex min-h-11 items-center rounded-md border border-border px-3 text-xs font-medium hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-9";

export default function ImportExportSettingsPage() {
  const [targets, setTargets] = useState<TargetInfo[]>([]);
  const [target, setTarget] = useState<ImportTargetKey>("crm_contacts");
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  const [result, setResult] = useState<ImportResult | null>(null);
  const [jobs, setJobs] = useState<ImportJobRow[]>([]);
  const [busy, setBusy] = useState<"preview" | "dry" | "run" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exportFrom, setExportFrom] = useState("");
  const [exportTo, setExportTo] = useState("");
  const [recordType, setRecordType] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLElement>(null);

  const loadJobs = useCallback(async () => {
    try {
      const res = await fetch("/api/import/jobs", { cache: "no-store" });
      const data = (await res.json().catch(() => null)) as { jobs?: ImportJobRow[] } | null;
      if (res.ok) setJobs(data?.jobs ?? []);
    } catch {
      /* non-fatal */
    }
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    void (async () => {
      try {
        const res = await fetch("/api/import/preview", { cache: "no-store", signal: ctrl.signal });
        const data = (await res.json().catch(() => null)) as { targets?: TargetInfo[]; error?: string } | null;
        if (!res.ok) throw new Error(data?.error === "forbidden" ? "Your role cannot import data." : "Could not load import targets.");
        setTargets(data?.targets ?? []);
      } catch (err) {
        if (ctrl.signal.aborted) return;
        setError(err instanceof Error ? err.message : "Could not load import targets.");
      }
    })();
    void loadJobs();
    return () => ctrl.abort();
  }, [loadJobs]);

  const currentTarget = useMemo(() => targets.find((t) => t.key === target) ?? null, [targets, target]);

  function reset() {
    setPreview(null);
    setMapping({});
    setResult(null);
  }

  function onFile(file: File | null) {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setError("That file is larger than 5 MB. Split it and import in parts.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setCsv(String(reader.result ?? ""));
      setFileName(file.name);
      reset();
    };
    reader.onerror = () => setError("Could not read that file.");
    reader.readAsText(file);
  }

  async function runPreview() {
    if (!csv.trim()) {
      setError("Paste or upload a CSV first.");
      return;
    }
    setBusy("preview");
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/import/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ csv, target }) });
      const data = (await res.json().catch(() => null)) as (Preview & { error?: string; detail?: string }) | null;
      if (!res.ok || !data) throw new Error(data?.detail ?? data?.error ?? "Could not read the CSV.");
      setPreview(data);
      setMapping(data.suggestion.mapping);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read the CSV.");
    } finally {
      setBusy(null);
    }
  }

  async function runImport(dryRun: boolean) {
    if (!preview) return;
    const missing = preview.target.fields.filter((f) => f.required && !mapping[f.key]);
    if (missing.length) {
      setError(`Map the required field${missing.length === 1 ? "" : "s"}: ${missing.map((f) => f.label).join(", ")}.`);
      return;
    }
    if (!dryRun && !window.confirm(`Import ${preview.rowCount} row${preview.rowCount === 1 ? "" : "s"} into ${preview.target.label}? Duplicates are skipped; this cannot be undone.`)) return;
    setBusy(dryRun ? "dry" : "run");
    setError(null);
    try {
      const res = await fetch("/api/import/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv, target, mapping, dryRun, fileName: fileName ?? undefined }),
      });
      const data = (await res.json().catch(() => null)) as (ImportResult & { error?: string; detail?: string }) | null;
      if (!res.ok || !data) throw new Error(data?.detail ?? data?.error ?? "Import failed.");
      setResult(data);
      void loadJobs();
      requestAnimationFrame(() => {
        resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
        resultsRef.current?.focus();
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed.");
    } finally {
      setBusy(null);
    }
  }

  const sampleFor = (header: string | null) => {
    if (!preview || !header) return "";
    const i = preview.headers.indexOf(header);
    return preview.sample
      .map((r) => r[i])
      .filter(Boolean)
      .slice(0, 2)
      .join(" · ");
  };

  const usedHeaders = new Set(Object.values(mapping).filter(Boolean));
  const ignored = preview ? preview.headers.filter((h) => !usedHeaders.has(h)) : [];
  const exportQuery = (key: string, format: "csv" | "json") => {
    const p = new URLSearchParams({ format });
    if (exportFrom) p.set("from", exportFrom);
    if (exportTo) p.set("to", exportTo);
    if (key === "records" && recordType.trim()) p.set("type", recordType.trim());
    return `/api/export/${key}?${p.toString()}`;
  };

  return (
    <PageContainer
      wide
      title="Import & export"
      description="Bring data in from a spreadsheet, or take any list out as CSV or JSON."
      tooltip="Imports de-duplicate against existing records and never overwrite them. Run a dry run first: it checks every row without writing anything."
    >
      {error && (
        <Banner tone="error" onDismiss={() => setError(null)}>
          {error}
        </Banner>
      )}

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]">
        {/* ── Import ─────────────────────────────────────────────── */}
        <div className="min-w-0 space-y-6">
          <section aria-labelledby="step-target" className="rounded-xl border border-border bg-card p-4 sm:p-5">
            <h2 id="step-target" className={STEP_HEADING}>
              <span className={STEP_BADGE} aria-hidden>
                1
              </span>{" "}
              What are you importing?
            </h2>
            {targets.length === 0 ? (
              <div className="mt-3 grid gap-2 sm:grid-cols-2" role="status" aria-busy="true" aria-label="Loading import targets">
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-16 rounded-lg" />
                ))}
              </div>
            ) : (
              <div role="radiogroup" aria-labelledby="step-target" className="mt-3 grid gap-2 sm:grid-cols-2">
                {targets.map((t) => (
                  <label
                    key={t.key}
                    className={cn(
                      "flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm transition-colors focus-within:ring-2 focus-within:ring-ring motion-reduce:transition-none",
                      target === t.key ? "border-primary bg-accent/60" : "border-border hover:bg-secondary/60"
                    )}
                  >
                    <input
                      type="radio"
                      name="target"
                      value={t.key}
                      checked={target === t.key}
                      onChange={() => {
                        setTarget(t.key);
                        reset();
                      }}
                      className="mt-1 h-4 w-4 shrink-0 accent-primary focus-visible:outline-none"
                    />
                    <span className="min-w-0">
                      <span className="block font-medium">{t.label}</span>
                      <span className="block text-xs text-muted-foreground">{t.description}</span>
                    </span>
                  </label>
                ))}
              </div>
            )}
          </section>

          <section aria-labelledby="step-csv" className="rounded-xl border border-border bg-card p-4 sm:p-5">
            <h2 id="step-csv" className={STEP_HEADING}>
              <span className={STEP_BADGE} aria-hidden>
                2
              </span>{" "}
              Add your CSV
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">Export from your old tool as CSV (comma, semicolon or tab separated), then upload it or paste the contents.</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <input ref={fileInput} type="file" accept=".csv,text/csv,text/plain,.tsv,.txt" className="sr-only" id="csv-file" aria-label="Choose a CSV file" onChange={(e) => onFile(e.target.files?.[0] ?? null)} />
              <Button type="button" variant="outline" touch onClick={() => fileInput.current?.click()}>
                <Upload className="h-4 w-4" aria-hidden /> Upload file
              </Button>
              {fileName && (
                <span className="min-w-0 truncate text-sm text-muted-foreground" aria-live="polite">
                  {fileName}
                </span>
              )}
            </div>
            <Field label="Or paste CSV" className="mt-3">
              <Textarea
                value={csv}
                onChange={(e) => {
                  setCsv(e.target.value);
                  setFileName(null);
                  reset();
                }}
                rows={6}
                spellCheck={false}
                autoComplete="off"
                placeholder={"name,email,phone\nAda Lovelace,ada@example.com,+1 555 0100"}
                className="font-mono sm:text-xs"
              />
            </Field>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button type="button" touch onClick={() => void runPreview()} disabled={busy !== null || !csv.trim() || !currentTarget}>
                {busy === "preview" ? spinner : <Sparkles className="h-4 w-4" aria-hidden />}
                Read file and suggest mapping
              </Button>
              {csv && (
                <Button
                  type="button"
                  variant="ghost"
                  touch
                  onClick={() => {
                    setCsv("");
                    setFileName(null);
                    reset();
                  }}
                >
                  Clear
                </Button>
              )}
            </div>
          </section>

          {preview && (
            <section aria-labelledby="step-map" className="rounded-xl border border-border bg-card p-4 sm:p-5">
              <h2 id="step-map" className={STEP_HEADING}>
                <span className={STEP_BADGE} aria-hidden>
                  3
                </span>{" "}
                Match columns
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {preview.rowCount.toLocaleString()} row{preview.rowCount === 1 ? "" : "s"}, {preview.headers.length} columns.{" "}
                {preview.suggestion.source === "ai" ? "Mapping refined by AI." : "Mapping suggested from column names and sample values."} Check anything marked unsure.
              </p>
              <ul className="mt-4 divide-y divide-border">
                {preview.target.fields.map((f) => {
                  const conf = preview.suggestion.confidence[f.key];
                  const unsure = Boolean(mapping[f.key]) && conf !== undefined && conf < 0.7;
                  const sampleId = `map-${f.key}-sample`;
                  return (
                    <li key={f.key} className="grid gap-2 py-3 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] sm:items-center sm:gap-4">
                      <div className="min-w-0">
                        <label htmlFor={`map-${f.key}`} className="block text-sm font-medium">
                          {f.label}
                          {f.required && (
                            <span className="ml-1 text-destructive" aria-hidden>
                              *
                            </span>
                          )}
                          {f.required && <span className="sr-only"> (required)</span>}
                        </label>
                        <span className="text-xs text-muted-foreground">
                          {TYPE_LABEL[f.type]}
                          {f.values ? `: ${f.values.join(", ")}` : ""}
                          {preview.target.dedupeKey.includes(f.key) ? " · used to detect duplicates" : ""}
                        </span>
                      </div>
                      <div className="min-w-0">
                        <Select
                          id={`map-${f.key}`}
                          value={mapping[f.key] ?? ""}
                          onChange={(e) => setMapping((m) => ({ ...m, [f.key]: e.target.value || null }))}
                          aria-describedby={sampleId}
                          className={cn(unsure && "border-amber-500/70")}
                        >
                          <option value="">Skip this field</option>
                          {preview.headers.map((h) => (
                            <option key={h} value={h} disabled={usedHeaders.has(h) && mapping[f.key] !== h}>
                              {h}
                            </option>
                          ))}
                        </Select>
                        <p id={sampleId} className="mt-1 flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                          {unsure && <Pill tone="warning">Unsure</Pill>}
                          <span className="truncate">{mapping[f.key] ? `e.g. ${sampleFor(mapping[f.key]) || "(empty)"}` : "Not imported"}</span>
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ul>
              <UpgradePrompt metric="contacts" increment={preview.rowCount} className="mt-3" />
              {ignored.length > 0 && <p className="mt-2 text-xs text-muted-foreground">Ignored columns: {ignored.join(", ")}</p>}
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Button type="button" variant="outline" touch onClick={() => void runImport(true)} disabled={busy !== null}>
                  {busy === "dry" ? spinner : <FlaskConical className="h-4 w-4" aria-hidden />}
                  Dry run
                </Button>
                <Button type="button" touch onClick={() => void runImport(false)} disabled={busy !== null || !result?.dryRun}>
                  {busy === "run" ? spinner : <FileSpreadsheet className="h-4 w-4" aria-hidden />}
                  Import {preview.rowCount.toLocaleString()} rows
                </Button>
                {!result?.dryRun && <span className="text-xs text-muted-foreground">Run a dry run first.</span>}
              </div>
            </section>
          )}

          {result && (
            <section ref={resultsRef} tabIndex={-1} aria-labelledby="step-result" aria-live="polite" className="rounded-xl border border-border bg-card p-4 outline-none focus-visible:ring-2 focus-visible:ring-ring sm:p-5">
              <h2 id="step-result" className={STEP_HEADING}>
                <span className={STEP_BADGE} aria-hidden>
                  4
                </span>{" "}
                {result.dryRun ? "Dry run" : "Import"} results
              </h2>
              <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
                <div className="rounded-lg bg-emerald-500/10 p-3">
                  <dd className="text-2xl font-semibold tabular-nums text-emerald-800 dark:text-emerald-300">{result.inserted.toLocaleString()}</dd>
                  <dt className="text-xs text-emerald-800/80 dark:text-emerald-300/80">{result.dryRun ? "would import" : "imported"}</dt>
                </div>
                <div className="rounded-lg bg-amber-500/10 p-3">
                  <dd className="text-2xl font-semibold tabular-nums text-amber-800 dark:text-amber-300">{result.skipped.toLocaleString()}</dd>
                  <dt className="text-xs text-amber-800/80 dark:text-amber-300/80">skipped</dt>
                </div>
                <div className="rounded-lg bg-secondary p-3">
                  <dd className="text-2xl font-semibold tabular-nums">{result.errors.length.toLocaleString()}</dd>
                  <dt className="text-xs text-muted-foreground">issues</dt>
                </div>
              </dl>
              {!result.dryRun && result.inserted > 0 && (
                <p className="mt-3 flex items-center gap-2 text-sm text-emerald-800 dark:text-emerald-300">
                  <CheckCircle2 className="h-4 w-4" aria-hidden /> Done. Your {preview?.target.label.toLowerCase()} are ready.
                </p>
              )}
              {result.errors.length > 0 && (
                <div className="mt-4">
                  <TableScroller label="Import issues">
                    <div className="max-h-64 overflow-y-auto">
                      <table className="w-full text-left text-xs">
                        <thead className="sticky top-0 bg-secondary text-muted-foreground">
                          <tr>
                            <th scope="col" className="px-3 py-2 font-medium">
                              Row
                            </th>
                            <th scope="col" className="px-3 py-2 font-medium">
                              Field
                            </th>
                            <th scope="col" className="px-3 py-2 font-medium">
                              Issue
                            </th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {result.errors.map((e, i) => (
                            <tr key={i}>
                              <td className="px-3 py-1.5 tabular-nums">{e.row || "—"}</td>
                              <td className="px-3 py-1.5">{e.field ?? ""}</td>
                              <td className="px-3 py-1.5">{e.message}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </TableScroller>
                </div>
              )}
            </section>
          )}

          <section aria-labelledby="jobs-heading">
            <div className="mb-2 flex items-center justify-between">
              <h2 id="jobs-heading" className="text-sm font-semibold">
                Recent imports
              </h2>
              <Button type="button" variant="ghost" size="sm" touch onClick={() => void loadJobs()}>
                <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Refresh
              </Button>
            </div>
            {jobs.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">No imports yet.</p>
            ) : (
              <ul className="divide-y divide-border rounded-lg border border-border bg-card">
                {jobs.map((j) => (
                  <li key={j.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
                    <div className="min-w-0">
                      <span className="font-medium">{targets.find((t) => t.key === j.target)?.label ?? j.target}</span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        {j.file_name ?? "pasted"} · {timeAgo(j.created_at)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-xs">
                      <Pill tone={JOB_TONE[j.status] ?? "neutral"} className="capitalize">
                        {j.status === "dry_run" ? "Dry run" : j.status}
                      </Pill>
                      <span className="tabular-nums text-muted-foreground">
                        {j.inserted}/{j.row_count} rows
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        {/* ── Export ─────────────────────────────────────────────── */}
        <aside aria-labelledby="export-heading" className="min-w-0 space-y-3 lg:sticky lg:top-4 lg:self-start">
          <h2 id="export-heading" className="flex items-center gap-2 text-sm font-semibold">
            <Download className="h-4 w-4 text-primary" aria-hidden /> Export
          </h2>
          <p className="text-sm text-muted-foreground">Download a list as a spreadsheet (CSV) or for developers (JSON). Dates are optional.</p>
          <div className="grid grid-cols-2 gap-2">
            <Field label="From">
              <Input type="date" value={exportFrom} max={exportTo || undefined} onChange={(e) => setExportFrom(e.target.value)} />
            </Field>
            <Field label="To">
              <Input type="date" value={exportTo} min={exportFrom || undefined} onChange={(e) => setExportTo(e.target.value)} />
            </Field>
          </div>
          <ul className="divide-y divide-border rounded-lg border border-border bg-card">
            {EXPORTS.map((e) => (
              <li key={e.key} className="px-3 py-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{e.label}</p>
                    <p className="truncate text-xs text-muted-foreground">{e.hint}</p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <a href={exportQuery(e.key, "csv")} download className={EXPORT_LINK} aria-label={`Download ${e.label} as CSV`}>
                      CSV
                    </a>
                    <a href={exportQuery(e.key, "json")} download className={EXPORT_LINK} aria-label={`Download ${e.label} as JSON`}>
                      JSON
                    </a>
                  </div>
                </div>
                {e.key === "records" && (
                  <Field label="Record type (slug), optional" className="mt-2">
                    <Input value={recordType} onChange={(e2) => setRecordType(e2.target.value)} placeholder="e.g. deals" spellCheck={false} autoComplete="off" className="sm:h-8" />
                  </Field>
                )}
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">Exports are logged in the audit trail. Lists not enabled for your workspace download as “not found”.</p>
        </aside>
      </div>
    </PageContainer>
  );
}
