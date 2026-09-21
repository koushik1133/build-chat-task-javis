"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Inbox, Loader2, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageContainer } from "@/components/page-container";
import { cn, timeAgo } from "@/lib/utils";

type Channel = "email" | "sms" | "whatsapp" | "in_app" | "webhook";
type Status = "queued" | "sent" | "simulated" | "failed" | "read";

interface OutboxRow {
  id: string;
  channel: Channel;
  recipient: string;
  subject: string | null;
  body: string | null;
  data: Record<string, unknown> | null;
  status: Status;
  attempts: number | null;
  error: string | null;
  scheduled_at: string;
  sent_at: string | null;
  read_at: string | null;
  created_at: string;
}

const CHANNELS: Channel[] = ["email", "sms", "whatsapp", "in_app", "webhook"];
const STATUSES: Status[] = ["queued", "sent", "simulated", "failed", "read"];

const STATUS_STYLES: Record<Status, string> = {
  queued: "bg-secondary text-secondary-foreground",
  sent: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  simulated: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  failed: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  read: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
};

export default function OutboxSettingsPage() {
  const [rows, setRows] = useState<OutboxRow[]>([]);
  const [channels, setChannels] = useState<Record<Channel, "live" | "simulated"> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [channel, setChannel] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [open, setOpen] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (channel) params.set("channel", channel);
      if (status) params.set("status", status);
      const res = await fetch(`/api/notifications/outbox?${params.toString()}`, { cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.detail ?? data?.error ?? "Could not load the outbox.");
      setRows(data.rows ?? []);
      setChannels(data.channels ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the outbox.");
    } finally {
      setLoading(false);
    }
  }, [channel, status]);

  useEffect(() => { void load(); }, [load]);

  function toggle(id: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const anySimulated = channels ? Object.values(channels).some((m) => m === "simulated") : false;

  return (
    <PageContainer
      wide
      title="Outbox"
      description="Every email, text, in-app alert and webhook the platform sends, with delivery status."
      tooltip="Channels without a configured provider are simulated: nothing leaves the server, but the full message is kept here so you can read verification codes and invite links."
    >
      {channels && (
        <section className="mb-6 flex flex-wrap gap-2" aria-label="Channel status">
          {CHANNELS.map((c) => (
            <span key={c} className={cn("inline-flex items-center gap-2 rounded-full border border-border px-3 py-1 text-xs")}>
              <span className={cn("h-2 w-2 rounded-full", channels[c] === "live" ? "bg-emerald-500" : "bg-amber-500")} aria-hidden />
              <span className="font-medium">{c}</span>
              <span className="text-muted-foreground">{channels[c]}</span>
            </span>
          ))}
        </section>
      )}

      {anySimulated && (
        <div role="status" className="mb-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <div>
            Some channels are simulated. Set <code className="font-mono">RESEND_API_KEY</code> for email and{" "}
            <code className="font-mono">TWILIO_ACCOUNT_SID</code>, <code className="font-mono">TWILIO_AUTH_TOKEN</code>,{" "}
            <code className="font-mono">TWILIO_FROM_NUMBER</code> for SMS / WhatsApp to send for real.
          </div>
        </div>
      )}

      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="block text-sm">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Channel</span>
            <select value={channel} onChange={(e) => setChannel(e.target.value)}
              className="rounded-md border border-border bg-background px-3 py-2 text-sm">
              <option value="">All channels</option>
              {CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Status</span>
            <select value={status} onChange={(e) => setStatus(e.target.value)}
              className="rounded-md border border-border bg-background px-3 py-2 text-sm">
              <option value="">All statuses</option>
              {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
        </div>
        <Button variant="outline" onClick={() => void load()} disabled={loading} aria-label="Refresh outbox">
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

      {loading && rows.length === 0 && (
        <div className="flex items-center justify-center py-16 text-muted-foreground" role="status" aria-live="polite">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" aria-hidden /> Loading outbox…
        </div>
      )}

      {!loading && rows.length === 0 && !error && (
        <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          <Inbox className="mx-auto mb-3 h-6 w-6" aria-hidden />
          Nothing has been sent yet.
        </div>
      )}

      {rows.length > 0 && (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          {rows.map((r) => {
            const expanded = open.has(r.id) || r.status === "simulated";
            return (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => toggle(r.id)}
                  aria-expanded={expanded}
                  className="flex w-full flex-wrap items-center gap-2 px-4 py-3 text-left text-sm hover:bg-secondary/40"
                >
                  {expanded ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />}
                  <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{r.channel}</span>
                  <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", STATUS_STYLES[r.status])}>{r.status}</span>
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{r.subject ?? "(no subject)"}</span>
                    <span className="text-muted-foreground"> → {r.recipient}</span>
                  </span>
                  <span className="text-xs text-muted-foreground" title={new Date(r.created_at).toLocaleString()}>
                    {timeAgo(r.created_at)}
                  </span>
                </button>
                {expanded && (
                  <div className="border-t border-border/60 bg-background/60 px-4 py-3 text-xs">
                    {r.error && (
                      <p className="mb-2 text-red-700 dark:text-red-400">
                        Error (attempt {r.attempts ?? 0}): {r.error}
                      </p>
                    )}
                    <pre className="whitespace-pre-wrap break-words rounded-md border border-border bg-card p-3 font-mono text-[11px] leading-relaxed">
                      {r.body ?? "(empty body)"}
                    </pre>
                    <p className="mt-2 text-muted-foreground">
                      scheduled {new Date(r.scheduled_at).toLocaleString()}
                      {r.sent_at ? ` · sent ${new Date(r.sent_at).toLocaleString()}` : ""}
                      {r.read_at ? ` · read ${new Date(r.read_at).toLocaleString()}` : ""}
                    </p>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </PageContainer>
  );
}
