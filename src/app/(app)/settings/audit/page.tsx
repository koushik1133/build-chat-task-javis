"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Loader2, RefreshCw, ScrollText, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageContainer } from "@/components/page-container";
import { cn, timeAgo } from "@/lib/utils";

interface AuditEntry {
  id: string;
  actor_id: string | null;
  actor_email: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  diff: Record<string, [unknown, unknown]> | null;
  ip: string | null;
  created_at: string;
}

const ACTION_STYLES: Record<string, string> = {
  create: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  update: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  delete: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  restore: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
};

function fmt(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v.length > 120 ? `${v.slice(0, 117)}…` : v;
  try {
    const s = JSON.stringify(v);
    return s.length > 120 ? `${s.slice(0, 117)}…` : s;
  } catch {
    return String(v);
  }
}

export default function AuditSettingsPage() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [entity, setEntity] = useState("");
  const [entityId, setEntityId] = useState("");

  const load = useCallback(async (before?: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: "50" });
      if (entity.trim()) params.set("entity", entity.trim());
      if (entityId.trim()) params.set("entityId", entityId.trim());
      if (before) params.set("before", before);
      const res = await fetch(`/api/audit?${params.toString()}`, { cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.detail ?? data?.error ?? "Could not load the audit log.");
      setEntries((prev) => (before ? [...prev, ...data.entries] : data.entries));
      setNextBefore(data.entries.length === 50 ? data.nextBefore : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the audit log.");
    } finally {
      setLoading(false);
    }
  }, [entity, entityId]);

  useEffect(() => { void load(); }, [load]);

  const entities = Array.from(new Set(entries.map((e) => e.entity))).sort();

  return (
    <PageContainer
      wide
      title="Audit Log"
      description="Every change made in this workspace: who did it, what changed, and when."
      tooltip="Rows are written automatically when records are created, edited, deleted or restored."
    >
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="block text-sm">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Entity</span>
            <input list="audit-entities" value={entity} onChange={(e) => setEntity(e.target.value)}
              placeholder="All entities"
              className="w-44 rounded-md border border-border bg-background px-3 py-2 text-sm" />
            <datalist id="audit-entities">
              {entities.map((e) => <option key={e} value={e} />)}
            </datalist>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Entity id</span>
            <input value={entityId} onChange={(e) => setEntityId(e.target.value)} placeholder="Any"
              className="w-56 rounded-md border border-border bg-background px-3 py-2 text-sm font-mono" />
          </label>
        </div>
        <Button variant="outline" onClick={() => void load()} disabled={loading} aria-label="Refresh audit log">
          {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="mr-2 h-4 w-4" aria-hidden />}
          Refresh
        </Button>
      </div>

      {error && (
        <div role="alert" className="mb-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <div className="min-w-0 flex-1">{error}</div>
          <button onClick={() => setError(null)} aria-label="Dismiss" className="shrink-0 opacity-70 hover:opacity-100">
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
      )}

      {loading && entries.length === 0 && (
        <div className="flex items-center justify-center py-16 text-muted-foreground" role="status" aria-live="polite">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" aria-hidden /> Loading audit log…
        </div>
      )}

      {!loading && entries.length === 0 && !error && (
        <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          <ScrollText className="mx-auto mb-3 h-6 w-6" aria-hidden />
          No audit entries yet. Changes will show up here as your team works.
        </div>
      )}

      {entries.length > 0 && (
        <ol className="relative ml-2 border-l border-border pl-6" aria-label="Audit timeline">
          {entries.map((e) => {
            const diffKeys = e.diff ? Object.keys(e.diff) : [];
            return (
              <li key={e.id} className="relative mb-6">
                <span className="absolute -left-[31px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-background bg-foreground/70" aria-hidden />
                <div className="rounded-xl border border-border bg-card p-4">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium",
                      ACTION_STYLES[e.action] ?? "bg-secondary text-secondary-foreground")}>
                      {e.action}
                    </span>
                    <span className="font-medium">{e.entity}</span>
                    {e.entity_id && <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{e.entity_id}</code>}
                    <span className="ml-auto text-xs text-muted-foreground" title={new Date(e.created_at).toLocaleString()}>
                      {timeAgo(e.created_at)}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    by {e.actor_email ?? e.actor_id ?? "system"}{e.ip ? ` · ${e.ip}` : ""}
                  </p>
                  {diffKeys.length > 0 && (
                    <table className="mt-3 w-full text-xs">
                      <tbody>
                        {diffKeys.map((k) => (
                          <tr key={k} className="border-t border-border/60">
                            <td className="py-1 pr-3 align-top font-mono text-muted-foreground">{k}</td>
                            <td className="py-1 pr-3 align-top text-red-700 line-through dark:text-red-400">{fmt(e.diff?.[k]?.[0])}</td>
                            <td className="py-1 align-top text-emerald-700 dark:text-emerald-400">{fmt(e.diff?.[k]?.[1])}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {nextBefore && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => void load(nextBefore)} disabled={loading}>
            Load older
          </Button>
        </div>
      )}
    </PageContainer>
  );
}
