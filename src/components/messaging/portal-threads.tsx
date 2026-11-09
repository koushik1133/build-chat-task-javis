"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, Globe, Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { Banner, SkeletonList } from "@/components/ui/feedback";
import { Pill } from "@/components/ui/pill";
import { PORTAL_MESSAGE_MAX } from "@/lib/portal-rules";
import { cn, timeAgo } from "@/lib/utils";

interface Thread {
  contact_id: string;
  contact_name: string;
  last_body: string;
  last_direction: "in" | "out";
  last_at: string;
  unread: number;
}
interface Msg {
  id: string;
  direction: "in" | "out";
  body: string;
  created_at: string;
}

/** Staff inbox section: conversations that customers start from their portal. Hidden when there are none. */
export function PortalThreads() {
  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/portal-messages");
      if (!r.ok) throw new Error("Could not load portal conversations.");
      setThreads(((await r.json()) as { threads: Thread[] }).threads);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load portal conversations.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <Banner tone="error">{error}</Banner>;
  if (!threads) return <SkeletonList count={1} itemClassName="h-14" label="Loading portal conversations…" className="mb-3" />;
  if (threads.length === 0) return null;
  const unread = threads.reduce((n, t) => n + t.unread, 0);

  return (
    <section aria-labelledby="portal-threads-h" className="mb-3 rounded-xl border border-border bg-card">
      <h2 id="portal-threads-h" className="flex items-center gap-2 border-b border-border px-4 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <Globe className="h-3.5 w-3.5" aria-hidden /> Portal conversations
        {unread > 0 && <Pill tone="accent">{unread} unread</Pill>}
      </h2>
      <ul className="divide-y divide-border/60">
        {threads.map((t) => (
          <li key={t.contact_id}>
            <button
              type="button"
              aria-expanded={open === t.contact_id}
              onClick={() => setOpen(open === t.contact_id ? null : t.contact_id)}
              className="flex min-h-11 w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <div className="min-w-0 flex-1">
                <div className={cn("truncate text-sm", t.unread > 0 ? "font-semibold" : "font-medium")}>{t.contact_name}</div>
                <div className="truncate text-xs text-muted-foreground">{t.last_direction === "out" ? "You: " : ""}{t.last_body}</div>
              </div>
              <span className="shrink-0 text-[11px] text-muted-foreground">{timeAgo(t.last_at)}</span>
              {t.unread > 0 && <span className="shrink-0 rounded-full bg-primary px-1.5 text-[11px] text-primary-foreground">{t.unread}</span>}
              <ChevronDown className={cn("h-4 w-4 shrink-0 transition-transform", open === t.contact_id && "rotate-180")} aria-hidden />
            </button>
            {open === t.contact_id && <ThreadPanel contactId={t.contact_id} onChanged={load} />}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ThreadPanel({ contactId, onChanged }: { contactId: string; onChanged: () => void }) {
  const [msgs, setMsgs] = useState<Msg[] | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch(`/api/portal-messages?contact_id=${encodeURIComponent(contactId)}`);
    if (r.ok) setMsgs(((await r.json()) as { messages: Msg[] }).messages);
    await fetch("/api/portal-messages", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contact_id: contactId }) });
    onChanged();
  }, [contactId, onChanged]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/portal-messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contact_id: contactId, body: text }) });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Could not send.");
      setText("");
      await load();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Could not send.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 border-t border-border/60 bg-secondary/20 px-4 py-3">
      {!msgs ? (
        <SkeletonList count={2} itemClassName="h-10" label="Loading conversation…" />
      ) : (
        <ul role="log" tabIndex={0} className="max-h-64 space-y-2 overflow-y-auto rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-live="polite" aria-label="Conversation">
          {msgs.map((m) => (
            <li key={m.id} className={cn("max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm [overflow-wrap:anywhere]", m.direction === "out" ? "ml-auto bg-primary text-primary-foreground" : "border border-border bg-card")}>
              {m.body}
            </li>
          ))}
        </ul>
      )}
      {err && <Banner tone="error">{err}</Banner>}
      <form onSubmit={send} className="flex gap-2">
        <label className="sr-only" htmlFor={`pt-${contactId}`}>Reply to customer</label>
        <Textarea id={`pt-${contactId}`} value={text} onChange={(e) => setText(e.target.value)} maxLength={PORTAL_MESSAGE_MAX} rows={2} placeholder="Reply — the customer gets an email with their portal link" className="min-h-0" />
        <Button type="submit" touch disabled={busy || !text.trim()} aria-label="Send reply">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Send className="h-4 w-4" aria-hidden />}
        </Button>
      </form>
    </div>
  );
}
