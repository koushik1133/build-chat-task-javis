"use client";

import { memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, BookOpen, Bot, Inbox, Loader2, Lock, Mail, Plus, RefreshCw, Send, Settings2, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox, Input, Select, Textarea } from "@/components/ui/input";
import { Dialog, DialogFooter } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Banner, Empty, ErrorState, Loading } from "@/components/ui/feedback";
import { Pill, StatusPill } from "@/components/ui/pill";
import { SearchField } from "@/components/ui/search-field";
import { TabPanel, Tabs } from "@/components/ui/tabs";
import { isAbortError, useAbortable, useDebouncedValue } from "@/components/ui/hooks";
import { LoadMore } from "@/components/ui/load-more";
import { PageContainer } from "@/components/page-container";
import { PRIORITY_TONE, SlaBadge, TICKET_STATUS_TONE } from "@/components/helpdesk/sla-badge";
import { cn, timeAgo } from "@/lib/utils";
import { TICKET_PRIORITIES, TICKET_STATUSES, type TicketPriority, type TicketStatus } from "@/lib/helpdesk/sla";
import type { SlaPolicyRow, TicketDetail, TicketMessageRow, TicketRow } from "@/lib/helpdesk/tickets";

type StatusFilter = "active" | TicketStatus | "all";

const FILTERS: ReadonlyArray<{ id: StatusFilter; label: string }> = [
  { id: "active", label: "Active" },
  { id: "open", label: "Open" },
  { id: "pending", label: "Pending" },
  { id: "resolved", label: "Resolved" },
  { id: "closed", label: "Closed" },
  { id: "all", label: "All" },
];

const AUTHOR_LABEL: Record<TicketMessageRow["author_kind"], string> = { agent: "You", customer: "Customer", ai: "AI agent", system: "System" };

const num = (n: number) => `#${String(n).padStart(4, "0")}`;
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

type Notice = { tone: "success" | "error"; text: string };

function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

async function readError(res: Response, fallback: string): Promise<string> {
  const d = await res.json().catch(() => ({}));
  return d && (d.detail?.formErrors?.[0] || d.detail || d.error) ? String(d.detail?.formErrors?.[0] ?? d.error ?? fallback) : `${fallback} (${res.status})`;
}

export default function HelpdeskPage() {
  return (
    <Suspense
      fallback={
        <PageContainer wide title="Helpdesk">
          <Loading label="Loading tickets…" />
        </PageContainer>
      }
    >
      <HelpdeskInner />
    </Suspense>
  );
}

function HelpdeskInner() {
  const router = useRouter();
  const search = useSearchParams();
  const selectedId = search.get("ticket");
  const now = useNow();

  const [filter, setFilter] = useState<StatusFilter>("active");
  const [q, setQ] = useState("");
  const query = useDebouncedValue(q.trim(), 250);
  const [priority, setPriority] = useState<string>("");
  const [tickets, setTickets] = useState<TicketRow[]>([]);
  const [policies, setPolicies] = useState<SlaPolicyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const nextSignal = useAbortable();

  const notify = useCallback((tone: Notice["tone"], text: string) => {
    setNotice({ tone, text });
    window.setTimeout(() => setNotice((n) => (n?.text === text ? null : n)), 6000);
  }, []);

  const listParams = useCallback(() => {
    const params = new URLSearchParams({ status: filter, limit: "50" });
    if (query) params.set("q", query);
    if (priority) params.set("priority", priority);
    return params;
  }, [filter, query, priority]);

  const load = useCallback(async () => {
    const signal = nextSignal();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/helpdesk/tickets?${listParams()}`, { cache: "no-store", signal });
      if (!res.ok) throw new Error(await readError(res, "Could not load tickets"));
      const d = await res.json();
      setTickets(d.tickets ?? []);
      setPolicies(d.policies ?? []);
      setCursor(typeof d.next_cursor === "string" ? d.next_cursor : null);
    } catch (err) {
      if (isAbortError(err)) return;
      setError(err instanceof Error ? err.message : "Could not load tickets");
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [listParams, nextSignal]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const params = listParams();
      params.set("cursor", cursor);
      const res = await fetch(`/api/helpdesk/tickets?${params}`, { cache: "no-store" });
      if (!res.ok) throw new Error(await readError(res, "Could not load more tickets"));
      const d = await res.json();
      const next: TicketRow[] = d.tickets ?? [];
      setTickets((prev) => {
        const seen = new Set(prev.map((t) => t.id));
        return [...prev, ...next.filter((t) => !seen.has(t.id))];
      });
      setCursor(typeof d.next_cursor === "string" ? d.next_cursor : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load more tickets");
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, listParams]);

  useEffect(() => {
    void load();
  }, [load]);

  // Deep link from Home quick actions: /helpdesk?new=ticket opens the dialog once, then the param is stripped.
  useEffect(() => {
    if (search.get("new") !== "ticket") return;
    setShowNew(true);
    const params = new URLSearchParams(search.toString());
    params.delete("new");
    router.replace(`/helpdesk${params.size ? `?${params}` : ""}`, { scroll: false });
  }, [search, router]);

  const select = useCallback(
    (id: string | null) => {
      const params = new URLSearchParams(search.toString());
      if (id) params.set("ticket", id);
      else params.delete("ticket");
      router.replace(`/helpdesk${params.size ? `?${params}` : ""}`, { scroll: false });
    },
    [router, search]
  );

  const patchLocal = useCallback((t: TicketRow) => {
    setTickets((prev) => prev.map((x) => (x.id === t.id ? { ...x, ...t } : x)));
  }, []);

  const breached = useMemo(
    () => tickets.filter((t) => (t.breached_first_response && !t.first_responded_at) || (t.breached_resolution && !t.resolved_at)).length,
    [tickets]
  );
  const filtered = Boolean(q || priority);

  return (
    <PageContainer
      wide
      title="Helpdesk"
      description="Every support request in one queue, with response targets, replies and a path straight into your knowledge base."
      tooltip="Tickets arrive from the client portal, your website widget, email and chat channels, or you can log them by hand. Each one gets a first-reply and resolution deadline from your SLA policy."
      className="pb-24"
      actions={
        <>
          <Button asChild variant="outline" touch>
            <Link href="/helpdesk/sla">
              <Settings2 className="h-4 w-4" aria-hidden /> SLA policies
            </Link>
          </Button>
          <Button variant="outline" size="icon" touch onClick={() => void load()} disabled={loading} aria-label="Refresh tickets">
            {loading ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
          </Button>
          <Button touch onClick={() => setShowNew(true)}>
            <Plus className="h-4 w-4" aria-hidden /> New ticket
          </Button>
        </>
      }
    >
      {notice && (
        <Banner tone={notice.tone} onDismiss={() => setNotice(null)}>
          {notice.text}
        </Banner>
      )}

      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <Tabs id="ticket-status" label="Ticket status" tabs={FILTERS} value={filter} onChange={setFilter} />
        <div className="flex flex-col gap-2 sm:flex-row lg:min-w-[24rem]">
          <SearchField value={q} onChange={setQ} label="Search tickets" placeholder="Search subject, requester or #number" className="flex-1" />
          <div className="sm:w-44">
            <label htmlFor="ticket-priority" className="sr-only">
              Filter by priority
            </label>
            <Select id="ticket-priority" value={priority} onChange={(e) => setPriority(e.target.value)}>
              <option value="">All priorities</option>
              {TICKET_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {cap(p)}
                </option>
              ))}
            </Select>
          </div>
        </div>
      </div>

      {breached > 0 && (
        <Banner tone="error">
          {breached} ticket{breached === 1 ? " has" : "s have"} missed a response target. They are listed first.
        </Banner>
      )}

      <TabPanel id="ticket-status" value={filter} className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <section aria-label="Ticket list" className={cn("min-w-0", selectedId && "hidden lg:block")} aria-busy={loading || undefined}>
          {loading && tickets.length === 0 ? (
            <Loading label="Loading tickets…" className="rounded-xl border border-border bg-card py-12" />
          ) : error ? (
            <ErrorState message={error} onRetry={() => void load()} />
          ) : tickets.length === 0 ? (
            <Empty
              icon={<Inbox className="h-5 w-5" />}
              title={filtered ? "No tickets match" : "No tickets yet"}
              text={filtered ? "Try a different search or clear the filters." : "Log one by hand, or share your portal link and website widget so customers can reach you."}
              action={
                filtered ? (
                  <Button
                    variant="outline"
                    onClick={() => {
                      setQ("");
                      setPriority("");
                    }}
                  >
                    Clear filters
                  </Button>
                ) : (
                  <Button onClick={() => setShowNew(true)}>
                    <Plus className="h-4 w-4" aria-hidden /> New ticket
                  </Button>
                )
              }
            />
          ) : (
            <>
              <ul className="space-y-2">
                {tickets.map((t) => (
                  <TicketListItem key={t.id} ticket={t} active={t.id === selectedId} now={now} onSelect={select} />
                ))}
              </ul>
              <LoadMore hasMore={Boolean(cursor)} loading={loadingMore} count={tickets.length} onMore={loadMore} noun="tickets" />
            </>
          )}
        </section>

        <section aria-label="Ticket detail" className={cn("min-w-0", !selectedId && "hidden lg:block")}>
          {selectedId ? (
            <TicketPane key={selectedId} id={selectedId} policies={policies} now={now} onBack={() => select(null)} onChange={patchLocal} notify={notify} />
          ) : (
            <div className="hidden h-full min-h-[280px] items-center justify-center rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground lg:flex">
              Select a ticket to read the thread and reply.
            </div>
          )}
        </section>
      </TabPanel>

      {showNew && (
        <NewTicketDialog
          policies={policies}
          onClose={() => setShowNew(false)}
          onCreated={(t) => {
            setShowNew(false);
            setTickets((prev) => [t, ...prev]);
            select(t.id);
            notify("success", `Ticket ${num(t.number)} created.`);
          }}
        />
      )}
    </PageContainer>
  );
}

/* ───────────────────────── list row ───────────────────────── */

const TicketListItem = memo(function TicketListItem({ ticket: t, active, now, onSelect }: { ticket: TicketRow; active: boolean; now: Date; onSelect: (id: string) => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(t.id)}
        aria-current={active ? "true" : undefined}
        className={cn(
          "w-full rounded-xl border bg-card p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
          active ? "border-primary/60 bg-accent/40" : "border-border hover:border-primary/30"
        )}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">
              <span className="mr-1.5 text-xs tabular-nums text-muted-foreground">{num(t.number)}</span>
              {t.subject}
            </p>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {t.requester_name || t.requester_email || "No requester"} · {t.source} · {timeAgo(t.updated_at)}
            </p>
          </div>
          <StatusPill status={t.priority} map={PRIORITY_TONE} className="shrink-0" />
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <StatusPill status={t.status} map={TICKET_STATUS_TONE} />
          {(t.status === "open" || t.status === "pending") && (
            <>
              <SlaBadge label="Reply" dueAt={t.first_response_due_at} satisfiedAt={t.first_responded_at} breached={t.breached_first_response} now={now} />
              <SlaBadge label="Resolve" dueAt={t.resolution_due_at} satisfiedAt={t.resolved_at} breached={t.breached_resolution} now={now} />
            </>
          )}
        </div>
      </button>
    </li>
  );
});

/* ───────────────────────── detail pane ───────────────────────── */

function TicketPane({
  id,
  policies,
  now,
  onBack,
  onChange,
  notify,
}: {
  id: string;
  policies: SlaPolicyRow[];
  now: Date;
  onBack: () => void;
  onChange: (t: TicketRow) => void;
  notify: (tone: Notice["tone"], text: string) => void;
}) {
  const router = useRouter();
  const [ticket, setTicket] = useState<TicketDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [internal, setInternal] = useState(false);
  const [sending, setSending] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  const thread = useRef<HTMLOListElement>(null);
  const nextSignal = useAbortable();

  const load = useCallback(async () => {
    const signal = nextSignal();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/helpdesk/tickets/${id}`, { cache: "no-store", signal });
      if (res.status === 404) throw new Error("This ticket no longer exists.");
      if (!res.ok) throw new Error(await readError(res, "Could not load the ticket"));
      const d = await res.json();
      setTicket(d.ticket);
    } catch (err) {
      if (isAbortError(err)) return;
      setError(err instanceof Error ? err.message : "Could not load the ticket");
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [id, nextSignal]);

  useEffect(() => {
    void load();
  }, [load]);
  const messageCount = ticket?.messages.length ?? 0;
  useEffect(() => {
    const el = thread.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messageCount]);

  async function patch(body: Record<string, unknown>, label: string) {
    setSaving(label);
    try {
      const res = await fetch(`/api/helpdesk/tickets/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(await readError(res, "Could not update the ticket"));
      const d = await res.json();
      setTicket((t) => (t ? { ...t, ...d.ticket } : t));
      onChange(d.ticket);
      if (body.status) void load(); // pick up the system note
    } catch (err) {
      notify("error", err instanceof Error ? err.message : "Could not update the ticket");
    } finally {
      setSaving(null);
    }
  }

  async function send() {
    const body = reply.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      const res = await fetch(`/api/helpdesk/tickets/${id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body, is_internal: internal }),
      });
      if (!res.ok) throw new Error(await readError(res, "Could not send the reply"));
      const d = await res.json();
      setReply("");
      setTicket((t) => (t ? { ...t, ...d.ticket, messages: [...t.messages, d.message] } : t));
      onChange(d.ticket);
      notify("success", internal ? "Internal note added." : d.emailed ? "Reply sent and emailed to the requester." : "Reply added. The requester has no email on file, so nothing was sent.");
    } catch (err) {
      notify("error", err instanceof Error ? err.message : "Could not send the reply");
    } finally {
      setSending(false);
    }
  }

  async function draftArticle() {
    setDrafting(true);
    try {
      const res = await fetch("/api/kb/draft", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ticketIds: [id] }) });
      if (res.status === 503) throw new Error("AI drafting needs GROQ_API_KEY or GEMINI_API_KEY configured.");
      if (!res.ok) throw new Error(await readError(res, "Could not draft the article"));
      const { draft } = await res.json();
      const create = await fetch("/api/kb/articles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: draft.title, body_md: draft.body_md, excerpt: draft.excerpt, tags: draft.tags, source_ticket_ids: draft.source_ticket_ids, status: "draft" }),
      });
      if (!create.ok) throw new Error(await readError(create, "Could not save the draft"));
      const { article } = await create.json();
      notify("success", `Draft “${article.title}” saved to the knowledge base.`);
      router.push(`/knowledge?article=${encodeURIComponent(article.id)}`);
    } catch (err) {
      notify("error", err instanceof Error ? err.message : "Could not draft the article");
    } finally {
      setDrafting(false);
    }
  }

  if (loading && !ticket) return <Loading label="Loading ticket…" className="rounded-xl border border-border bg-card py-12" />;
  if (error || !ticket) {
    return (
      <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/5 p-8 text-center">
        <p className="text-sm font-medium text-red-700 dark:text-red-300">{error ?? "Ticket not found"}</p>
        <div className="mt-3 flex flex-wrap justify-center gap-2">
          <Button size="sm" variant="outline" onClick={onBack}>
            Back to list
          </Button>
          <Button size="sm" variant="outline" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  const active = ticket.status === "open" || ticket.status === "pending";
  const tags = safeTags(ticket.tags);

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 sm:p-5">
      <div className="flex items-start gap-2">
        <Button variant="ghost" size="icon" touch className="-ml-2 lg:hidden" onClick={onBack} aria-label="Back to ticket list">
          <ArrowLeft className="h-4 w-4" aria-hidden />
        </Button>
        <div className="min-w-0 flex-1">
          <h2 className="break-words text-base font-semibold leading-snug">
            <span className="mr-1.5 text-sm tabular-nums text-muted-foreground">{num(ticket.number)}</span>
            {ticket.subject}
          </h2>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <User className="h-3 w-3" aria-hidden />
              {ticket.requester_name || "Unknown"}
            </span>
            {ticket.requester_email && (
              <span className="inline-flex min-w-0 items-center gap-1">
                <Mail className="h-3 w-3 shrink-0" aria-hidden />
                <span className="truncate">{ticket.requester_email}</span>
              </span>
            )}
            <span>via {ticket.source}</span>
            <span>opened {timeAgo(ticket.created_at)}</span>
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <StatusPill status={ticket.status} map={TICKET_STATUS_TONE} />
            <StatusPill status={ticket.priority} map={PRIORITY_TONE} />
            {active && (
              <>
                <SlaBadge label="Reply" dueAt={ticket.first_response_due_at} satisfiedAt={ticket.first_responded_at} breached={ticket.breached_first_response} now={now} />
                <SlaBadge label="Resolve" dueAt={ticket.resolution_due_at} satisfiedAt={ticket.resolved_at} breached={ticket.breached_resolution} now={now} />
              </>
            )}
            {ticket.escalated_at && <Pill tone="danger">Escalated</Pill>}
            {tags.map((t) => (
              <Pill key={t}>{t}</Pill>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Status">
          <Select value={ticket.status} disabled={saving === "status"} onChange={(e) => void patch({ status: e.target.value }, "status")}>
            {TICKET_STATUSES.map((s) => (
              <option key={s} value={s}>
                {cap(s)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Priority">
          <Select value={ticket.priority} disabled={saving === "priority"} onChange={(e) => void patch({ priority: e.target.value }, "priority")}>
            {TICKET_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {cap(p)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="SLA policy">
          <Select value={ticket.sla_policy_id ?? ""} disabled={saving === "policy"} onChange={(e) => void patch({ sla_policy_id: e.target.value || null }, "policy")}>
            <option value="">No SLA</option>
            {policies.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <ol ref={thread} aria-label="Conversation" className="scrollbar-thin max-h-[50dvh] space-y-3 overflow-y-auto overscroll-contain pr-1">
        {ticket.messages.length === 0 && <li className="text-xs text-muted-foreground">No messages yet.</li>}
        {ticket.messages.map((m) => (
          <li
            key={m.id}
            className={cn(
              "rounded-lg border px-3 py-2 text-sm",
              m.author_kind === "customer"
                ? "border-border bg-secondary/40"
                : m.is_internal
                  ? "border-amber-500/40 bg-amber-500/10"
                  : m.author_kind === "system"
                    ? "border-dashed border-border bg-transparent text-xs text-muted-foreground"
                    : "border-primary/30 bg-accent/40"
            )}
          >
            <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
              {m.author_kind === "ai" ? <Bot className="h-3 w-3" aria-hidden /> : m.is_internal ? <Lock className="h-3 w-3" aria-hidden /> : null}
              <span className="font-medium text-foreground">{AUTHOR_LABEL[m.author_kind]}</span>
              {m.is_internal && m.author_kind !== "system" && <Pill tone="warning">Internal</Pill>}
              <span>
                · <time dateTime={m.created_at}>{timeAgo(m.created_at)}</time>
              </span>
            </div>
            <p className="whitespace-pre-wrap break-words">{m.body}</p>
          </li>
        ))}
      </ol>

      <form
        className="space-y-2 border-t border-border pt-4"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <Field label={internal ? "Internal note" : "Reply to customer"} hint="Press ⌘ Enter or Ctrl Enter to send.">
          <Textarea
            id="reply-body"
            rows={4}
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            placeholder={internal ? "Visible to your team only…" : ticket.requester_email ? `Emailed to ${ticket.requester_email}` : "The requester has no email on file, so the reply is stored on the ticket only."}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void send();
            }}
            className={cn(internal && "border-amber-500/60")}
          />
        </Field>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Checkbox
            checked={internal}
            onChange={(e) => setInternal(e.target.checked)}
            label={
              <span className="inline-flex items-center gap-1 text-xs">
                <Lock className="h-3 w-3" aria-hidden /> Internal note
              </span>
            }
          />
          <div className="flex flex-wrap items-center gap-2">
            {(ticket.status === "resolved" || ticket.status === "closed") && (
              <Button type="button" variant="outline" size="sm" touch onClick={() => void draftArticle()} disabled={drafting}>
                {drafting ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden /> : <BookOpen className="h-3.5 w-3.5" aria-hidden />} Draft help article
              </Button>
            )}
            <Button type="submit" size="sm" touch disabled={sending || !reply.trim()}>
              {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden /> : <Send className="h-3.5 w-3.5" aria-hidden />} {internal ? "Add note" : "Send reply"}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}

function safeTags(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw || "[]");
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

/* ───────────────────────── new ticket dialog ───────────────────────── */

function NewTicketDialog({ policies, onClose, onCreated }: { policies: SlaPolicyRow[]; onClose: () => void; onCreated: (t: TicketRow) => void }) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [priority, setPriority] = useState<TicketPriority>("normal");
  const [policyId, setPolicyId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/helpdesk/tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject,
          body: body || null,
          priority,
          source: "manual",
          requester_name: name || null,
          requester_email: email || null,
          sla_policy_id: policyId || null,
        }),
      });
      if (!res.ok) throw new Error(await readError(res, "Could not create the ticket"));
      const d = await res.json();
      onCreated(d.ticket);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Could not create the ticket");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="New ticket" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {err && (
          <Banner tone="error" onDismiss={() => setErr(null)}>
            {err}
          </Banner>
        )}
        <Field label="Subject" required>
          <Input data-autofocus required maxLength={300} value={subject} onChange={(e) => setSubject(e.target.value)} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Requester name">
            <Input maxLength={200} autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Requester email">
            <Input type="email" maxLength={200} autoComplete="off" spellCheck={false} value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Priority">
            <Select value={priority} onChange={(e) => setPriority(e.target.value as TicketPriority)}>
              {TICKET_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {cap(p)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="SLA policy">
            <Select value={policyId} onChange={(e) => setPolicyId(e.target.value)}>
              <option value="">{policies.length ? "Default policy" : "No policies yet"}</option>
              {policies.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.is_default ? " (default)" : ""}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Details">
          <Textarea rows={4} maxLength={20000} value={body} onChange={(e) => setBody(e.target.value)} placeholder="What did the customer report?" />
        </Field>
        <DialogFooter>
          <Button type="button" variant="outline" touch onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" touch disabled={busy || !subject.trim()}>
            {busy && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />} Create ticket
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
