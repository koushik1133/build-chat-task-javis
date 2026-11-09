"use client";

import { useState } from "react";
import { DatabaseBackup, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Banner } from "@/components/ui/feedback";

interface Resume {
  table: string;
  after: string | null;
}

/** Last line of an NDJSON blob (the manifest), parsed leniently. */
async function readManifest(blob: Blob): Promise<{ complete?: boolean; rows?: number; resume?: Resume | null } | null> {
  const tail = await blob.slice(Math.max(0, blob.size - 8192)).text();
  const lines = tail.trim().split("\n");
  try {
    const last = JSON.parse(lines[lines.length - 1]) as { type?: string };
    return last.type === "manifest" ? (last as { complete?: boolean; rows?: number; resume?: Resume | null }) : null;
  } catch {
    return null;
  }
}

/** "Export everything": streams the full workspace backup (NDJSON) to a download. Owner only; 3 per day. */
export function ExportEverythingCard() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "success" | "error" | "info"; text: string } | null>(null);
  const [resume, setResume] = useState<Resume | null>(null);
  const [part, setPart] = useState(1);

  async function run(from: Resume | null) {
    setBusy(true);
    setMsg(null);
    try {
      const qs = from ? `?table=${encodeURIComponent(from.table)}${from.after ? `&after=${encodeURIComponent(from.after)}` : ""}` : "";
      const res = await fetch(`/api/workspace/export${qs}`, { method: "POST" });
      if (!res.ok) {
        const d = (await res.json().catch(() => null)) as { detail?: string; error?: string } | null;
        throw new Error(d?.detail ?? d?.error ?? `Export failed (${res.status})`);
      }
      const blob = await res.blob();
      const manifest = await readManifest(blob);
      const n = from ? part + 1 : 1;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `workspace-export-${new Date().toISOString().slice(0, 10)}${n > 1 || manifest?.resume ? `-part${n}` : ""}.ndjson`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      setPart(n);
      if (manifest && manifest.complete === false && manifest.resume) {
        setResume(manifest.resume);
        setMsg({ tone: "info", text: `Part ${n} downloaded (${manifest.rows ?? 0} rows). The export is large: continue to get the rest.` });
      } else {
        setResume(null);
        setMsg({ tone: "success", text: `Export complete (${manifest?.rows ?? 0} rows). Secrets, tokens and API keys are never included.` });
      }
    } catch (err) {
      setMsg({ tone: "error", text: err instanceof Error ? err.message : "Export failed" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="export-everything-title" className="rounded-xl border border-border bg-card p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 id="export-everything-title" className="flex items-center gap-2 text-sm font-semibold">
            <DatabaseBackup className="h-4 w-4" aria-hidden /> Export everything
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Download all of this workspace&apos;s data as newline-delimited JSON for backup or migration. Credentials, API keys, tokens and OAuth connections are never included. Owner only, 3 per day.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          {resume && (
            <Button variant="outline" touch disabled={busy} onClick={() => run(resume)}>
              Continue export
            </Button>
          )}
          <Button touch disabled={busy} onClick={() => { setPart(1); setResume(null); void run(null); }}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <DatabaseBackup className="h-4 w-4" aria-hidden />}
            {busy ? "Preparing…" : "Export everything"}
          </Button>
        </div>
      </div>
      {msg && (
        <Banner tone={msg.tone} onDismiss={() => setMsg(null)} className="mt-3">
          {msg.text}
        </Banner>
      )}
    </section>
  );
}
