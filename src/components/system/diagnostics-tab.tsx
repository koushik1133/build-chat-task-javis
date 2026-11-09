"use client";

import { Empty } from "@/components/ui/feedback";
import { Pill } from "@/components/ui/pill";
import { timeAgo } from "@/lib/utils";

export interface DiagnosticsData {
  scope: "platform" | "workspace";
  cronAgeMinutes: number | null;
  recentAlerts: Array<{ id: string; rule_name: string | null; fired_at: string; resolved_at: string | null; message: string | null }>;
}

export function DiagnosticsTab({ diagnostics, queue, errors }: { diagnostics: DiagnosticsData | null; queue: Record<string, number> | null; errors: Array<{ fingerprint: string; route: string; message: string; count: number; last_seen: string }> }) {
  const age = diagnostics?.cronAgeMinutes ?? null;
  const top = [...errors].sort((a, b) => b.count - a.count).slice(0, 5);
  return (
    <div className="space-y-8">
      <p className="text-sm text-muted-foreground">
        {diagnostics?.scope === "platform" ? "Deployment-wide numbers (operator workspace)." : "Numbers for this workspace. Deployment-wide queues are only visible to the operator workspace."}
      </p>
      <section aria-labelledby="diag-cron" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-border bg-card p-4">
          <h2 id="diag-cron" className="text-xs font-medium text-muted-foreground">Cron last tick age</h2>
          <div className="mt-1 flex items-center gap-2"><span className="text-2xl font-semibold tabular-nums">{age === null ? "Never" : `${age} min`}</span>
            {age !== null && <Pill tone={age <= 5 ? "success" : age <= 10 ? "warning" : "danger"}>{age <= 5 ? "Healthy" : age <= 10 ? "Slow" : "Stale"}</Pill>}</div>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <h2 className="text-xs font-medium text-muted-foreground">Job queue by status</h2>
          <dl className="mt-2 grid grid-cols-4 gap-2 text-center">
            {Object.entries(queue ?? {}).map(([k, v]) => (<div key={k}><dt className="text-xs text-muted-foreground">{k}</dt><dd className="text-lg font-semibold tabular-nums">{v}</dd></div>))}
          </dl>
        </div>
      </section>
      <section aria-labelledby="diag-errors">
        <h2 id="diag-errors" className="text-sm font-semibold">Top error fingerprints</h2>
        {top.length === 0 ? <Empty title="No errors captured" text="Nothing has been captured for this workspace." /> : (
          <ul className="mt-3 divide-y divide-border rounded-xl border border-border bg-card">
            {top.map((e) => (<li key={e.fingerprint} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm"><div className="min-w-0"><div className="break-all font-mono text-xs">{e.route}</div><div className="break-words text-xs text-muted-foreground">{e.message}</div></div><div className="text-xs text-muted-foreground">{e.count}× · {timeAgo(e.last_seen)}</div></li>))}
          </ul>
        )}
      </section>
      <section aria-labelledby="diag-alerts">
        <h2 id="diag-alerts" className="text-sm font-semibold">Recent alerts</h2>
        {!diagnostics || diagnostics.recentAlerts.length === 0 ? <Empty title="No alerts" text="Nothing has fired recently." /> : (
          <ul className="mt-3 divide-y divide-border rounded-xl border border-border bg-card">
            {diagnostics.recentAlerts.map((a) => (<li key={a.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm"><span className="min-w-0 break-words">{a.message ?? a.rule_name}</span><Pill tone={a.resolved_at ? "success" : "danger"}>{a.resolved_at ? "Resolved" : "Firing"}</Pill></li>))}
          </ul>
        )}
      </section>
    </div>
  );
}
