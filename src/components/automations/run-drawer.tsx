"use client";

import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/dialog";
import { Banner } from "@/components/ui/feedback";
import { StatusPill } from "@/components/ui/pill";
import type { AutomationRunDTO } from "@/lib/automations/types";
import { apiJson, fmtDate, RUN_TONE, runDuration } from "./shared";

const STEP_TONE = { ok: "success", failed: "danger", skipped: "neutral", waiting: "warning" } as const;

export function RunDrawer({ run, onClose, onRetried }: { run: AutomationRunDTO; onClose: () => void; onRetried: (r: AutomationRunDTO) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const canRetry = run.status === "done" || run.status === "failed" || run.status === "skipped";

  const retry = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await apiJson<{ run: AutomationRunDTO }>(`/api/automations/runs/${run.id}`, { method: "POST" });
      onRetried(r.run);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Retry failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      labelledBy="run-drawer-title"
      onClose={onClose}
      header={
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="run-drawer-title" className="text-base font-semibold">
            Run {run.id.slice(0, 8)}
          </h2>
          <StatusPill status={run.status} map={RUN_TONE} />
          <span className="text-xs text-muted-foreground">
            {fmtDate(run.created_at)} · {runDuration(run)} · attempt {run.attempt}
          </span>
        </div>
      }
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">{run.automation_name ?? run.automation_id}</span>
          <Button type="button" size="sm" variant="outline" disabled={!canRetry || busy} onClick={retry}>
            <RotateCcw className="h-3.5 w-3.5" aria-hidden /> {busy ? "Retrying…" : "Retry run"}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {err && <Banner tone="error">{err}</Banner>}
        {run.error && <Banner tone={run.status === "failed" ? "error" : "warn"}>{run.error}</Banner>}
        {run.status === "waiting" && (
          <Banner tone="info">{run.resume_at ? `Waiting until ${fmtDate(run.resume_at)}.` : "Waiting for an approval — decide it in the Approvals inbox and the run continues."}</Banner>
        )}
        <section aria-labelledby="run-steps">
          <h3 id="run-steps" className="mb-2 text-sm font-medium">
            Steps
          </h3>
          {run.step_results.length === 0 ? (
            <p className="text-sm text-muted-foreground">No steps have run yet.</p>
          ) : (
            <ol className="space-y-2">
              {run.step_results.map((s, i) => (
                <li key={`${s.step_id}-${i}`} className="rounded-lg border border-border p-3">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium">
                      {i + 1}. {s.name ?? s.step_id}
                    </span>
                    <span className="text-xs text-muted-foreground">{s.kind}</span>
                    <StatusPill status={s.status} map={STEP_TONE} />
                    <span className="ml-auto text-xs text-muted-foreground">{s.ms}ms</span>
                  </div>
                  <p className="mt-1 text-sm">{s.summary}</p>
                  {s.error && <p className="mt-1 text-xs text-destructive">{s.error}</p>}
                  {s.output !== undefined && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs text-muted-foreground">Output</summary>
                      <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-secondary/40 p-2 text-xs">{JSON.stringify(s.output, null, 2)}</pre>
                    </details>
                  )}
                </li>
              ))}
            </ol>
          )}
        </section>
        {run.context && (
          <details>
            <summary className="cursor-pointer text-sm font-medium">Trigger event</summary>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-secondary/40 p-2 text-xs">{JSON.stringify(run.context.event, null, 2)}</pre>
          </details>
        )}
      </div>
    </Drawer>
  );
}
