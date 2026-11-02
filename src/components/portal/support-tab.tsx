"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, LifeBuoy, Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { Banner, Loading } from "@/components/ui/feedback";
import { Pill, type Tone } from "@/components/ui/pill";
import { cn, timeAgo } from "@/lib/utils";

/** Client-portal "Support" tab: list the contact's tickets and open new ones via /api/p/tickets/[token]. */

type PortalTicket = {
  id: string;
  number: string;
  subject: string;
  status: "open" | "pending" | "resolved" | "closed";
  priority: string;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
};

type PortalMessage = { id: string; author_kind: "you" | "support" | "system"; body: string; created_at: string };

const STATUS_LABEL: Record<PortalTicket["status"], string> = { open: "Open", pending: "Awaiting your reply", resolved: "Resolved", closed: "Closed" };
const STATUS_TONE: Record<PortalTicket["status"], Tone> = { open: "success", pending: "warning", resolved: "neutral", closed: "neutral" };

export function SupportTab({ token }: { token: string }) {
  const [tickets, setTickets] = useState<PortalTicket[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/p/tickets/${token}`, { cache: "no-store" });
      if (res.status === 404) throw new Error("This link has expired or is not valid.");
      if (!res.ok) throw new Error("Could not load your requests.");
      setTickets((await res.json()).tickets ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load your requests.");
      setTickets([]);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFormError(null);
    try {
      const res = await fetch(`/api/p/tickets/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject: subject.trim(), body: body.trim() }),
      });
      if (!res.ok) throw new Error(res.status === 429 ? "Too many requests. Please wait a minute and try again." : "Could not send your request. Please try again.");
      const { ticket } = await res.json();
      setTickets((prev) => [ticket, ...(prev ?? [])]);
      setSubject("");
      setBody("");
      setShowForm(false);
      setNotice(`Request ${ticket.number} received. We will reply by email.`);
      window.setTimeout(() => setNotice(null), 8000);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Could not send your request.");
    } finally {
      setBusy(false);
    }
  }

  if (openId) return <TicketThread token={token} id={openId} onBack={() => setOpenId(null)} />;

  return (
    <section className="rounded-xl border border-border bg-card p-5" aria-labelledby="support-heading">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 id="support-heading" className="flex items-center gap-2 text-sm font-semibold">
          <LifeBuoy className="h-4 w-4 text-primary" aria-hidden /> Support requests
        </h2>
        {!showForm && (
          <Button size="sm" touch onClick={() => setShowForm(true)}>
            <Plus className="h-3.5 w-3.5" aria-hidden /> New request
          </Button>
        )}
      </div>

      {notice && (
        <Banner tone="success" onDismiss={() => setNotice(null)}>
          {notice}
        </Banner>
      )}

      {showForm && (
        <form onSubmit={submit} className="mb-4 space-y-3 rounded-lg border border-primary/40 p-4" aria-label="New support request">
          <Field label="What do you need help with?" required>
            <Input data-autofocus required maxLength={300} value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Short summary" />
          </Field>
          <Field label="Details" required>
            <Textarea required rows={4} maxLength={20000} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Tell us what happened and what you expected." />
          </Field>
          {formError && (
            <Banner tone="error" onDismiss={() => setFormError(null)} className="mb-0">
              {formError}
            </Banner>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" size="sm" touch onClick={() => setShowForm(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" size="sm" touch disabled={busy || !subject.trim() || !body.trim()}>
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />} Send request
            </Button>
          </div>
        </form>
      )}

      {tickets === null ? (
        <Loading label="Loading your requests…" className="py-6" />
      ) : error ? (
        <div role="alert" className="text-sm text-destructive">
          {error}{" "}
          <button type="button" onClick={() => void load()} className="rounded underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            Retry
          </button>
        </div>
      ) : tickets.length === 0 ? (
        <p className="text-sm text-muted-foreground">No support requests yet. Need something? Open a new request above.</p>
      ) : (
        <ul className="divide-y divide-border/60">
          {tickets.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => setOpenId(t.id)}
                className="flex min-h-12 w-full items-center justify-between gap-3 rounded-md px-1 py-2 text-left text-sm hover:bg-secondary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium">
                    <span className="mr-1.5 text-xs tabular-nums text-muted-foreground">{t.number}</span>
                    {t.subject}
                  </div>
                  <div className="text-xs text-muted-foreground">Updated {timeAgo(t.updated_at)}</div>
                </div>
                <Pill tone={STATUS_TONE[t.status]} className="shrink-0">
                  {STATUS_LABEL[t.status]}
                </Pill>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function TicketThread({ token, id, onBack }: { token: string; id: string; onBack: () => void }) {
  const [data, setData] = useState<{ ticket: PortalTicket; messages: PortalMessage[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`/api/p/tickets/${token}?id=${encodeURIComponent(id)}`, { cache: "no-store", signal: ctrl.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error("Could not load this request.");
        return res.json();
      })
      .then((d) => setData(d))
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        setError(err instanceof Error ? err.message : "Could not load this request.");
      });
    return () => ctrl.abort();
  }, [token, id]);

  return (
    <section className="rounded-xl border border-border bg-card p-5" aria-labelledby="thread-heading">
      <button
        type="button"
        onClick={onBack}
        className="mb-3 inline-flex min-h-11 items-center gap-1 rounded text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> All requests
      </button>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : !data ? (
        <Loading label="Loading this request…" className="py-6" />
      ) : (
        <>
          <h2 id="thread-heading" className="text-sm font-semibold">
            <span className="mr-1.5 text-xs tabular-nums text-muted-foreground">{data.ticket.number}</span>
            {data.ticket.subject}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {STATUS_LABEL[data.ticket.status]} · opened {timeAgo(data.ticket.created_at)}
          </p>
          <ol className="mt-4 space-y-2" aria-label="Messages">
            {data.messages.length === 0 && <li className="text-xs text-muted-foreground">No messages yet.</li>}
            {data.messages.map((m) => (
              <li
                key={m.id}
                className={cn(
                  "rounded-lg border px-3 py-2 text-sm",
                  m.author_kind === "you" ? "border-border bg-secondary/40" : m.author_kind === "system" ? "border-dashed border-border text-xs text-muted-foreground" : "border-primary/30 bg-accent/40"
                )}
              >
                <div className="mb-1 text-[11px] text-muted-foreground">
                  <span className="font-medium text-foreground">{m.author_kind === "you" ? "You" : m.author_kind === "system" ? "Update" : "Support"}</span> ·{" "}
                  <time dateTime={m.created_at}>{timeAgo(m.created_at)}</time>
                </div>
                <p className="whitespace-pre-wrap break-words">{m.body}</p>
              </li>
            ))}
          </ol>
          <p className="mt-4 text-xs text-muted-foreground">To add to this request, reply to the email you received.</p>
        </>
      )}
    </section>
  );
}
