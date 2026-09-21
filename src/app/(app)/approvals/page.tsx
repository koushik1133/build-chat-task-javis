"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, X, ChevronDown, ChevronRight, Loader2, Inbox, Bot, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageContainer } from "@/components/page-container";
import { cn, timeAgo } from "@/lib/utils";

type ApprovalStatus = "pending" | "approved" | "rejected";

type Approval = {
  id: string;
  run_id: string | null;
  agent_id: string | null;
  agent_name: string | null;
  tool_name: string;
  input: string | null;
  preview: string | null;
  status: ApprovalStatus | "expired";
  decided_at: string | null;
  created_at: string;
};

const TABS: { id: ApprovalStatus; label: string }[] = [
  { id: "pending", label: "Pending" },
  { id: "approved", label: "Approved" },
  { id: "rejected", label: "Rejected" },
];

const STATUS_STYLES: Record<string, string> = {
  pending: "bg-yellow-50 text-yellow-700 dark:bg-yellow-950 dark:text-yellow-400",
  approved: "bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-400",
  rejected: "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-400",
  expired: "bg-secondary text-muted-foreground",
};

function prettyInput(raw: string | null): string {
  if (!raw) return "";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

export default function ApprovalsPage() {
  const [tab, setTab] = useState<ApprovalStatus>("pending");
  const [items, setItems] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async (status: ApprovalStatus) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/approvals?status=${status}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const d = await res.json();
      setItems(d.approvals ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load approvals");
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(tab); }, [tab, load]);

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function decide(item: Approval, decision: "approved" | "rejected") {
    setBusy(item.id);
    setActionError(null);
    const snapshot = items;
    // Optimistic: drop from the pending list immediately.
    setItems((prev) => prev.filter((a) => a.id !== item.id));
    try {
      const res = await fetch(`/api/approvals/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `Could not ${decision === "approved" ? "approve" : "reject"} (${res.status})`);
      }
    } catch (err) {
      setItems(snapshot);
      setActionError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <PageContainer
      wide
      title="Approvals"
      description="Everything an agent or copilot wants to do that needs your OK. Approve to let it run, reject to stop it."
      tooltip="Agents pause here before sending, moving or writing anything. Production card gate decisions are mirrored here too."
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <div role="tablist" aria-label="Approval status" className="inline-flex rounded-lg border border-border bg-card p-1">
            {TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
                className={cn(
                  "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                  tab === t.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
          <Button variant="ghost" size="sm" onClick={() => load(tab)} disabled={loading} aria-label="Refresh">
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          </Button>
        </div>

        {actionError && (
          <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {actionError}
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center gap-2 rounded-xl border border-border bg-card p-12 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading approvals…
          </div>
        ) : error ? (
          <div role="alert" className="rounded-xl border border-destructive/40 bg-destructive/5 p-8 text-center">
            <p className="text-sm font-medium text-destructive">{error}</p>
            <Button size="sm" variant="outline" className="mt-3" onClick={() => load(tab)}>Try again</Button>
          </div>
        ) : items.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-12 text-center">
            <Inbox className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
            <p className="text-sm font-medium">
              {tab === "pending" ? "Nothing waiting on you" : `No ${tab} approvals yet`}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {tab === "pending"
                ? "When an agent needs a decision it will show up here."
                : "Decisions you make on the Pending tab are kept here for history."}
            </p>
          </div>
        ) : (
          <ul className="space-y-3">
            {items.map((item) => {
              const open = expanded.has(item.id);
              const input = prettyInput(item.input);
              return (
                <li key={item.id} className="rounded-xl border border-border bg-card p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <code className="rounded bg-secondary px-1.5 py-0.5 text-xs font-medium">{item.tool_name}</code>
                        <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium capitalize", STATUS_STYLES[item.status])}>
                          {item.status}
                        </span>
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                          <Bot className="h-3 w-3" />
                          {item.agent_name ?? (item.run_id ? "Agent" : "Copilot")}
                        </span>
                      </div>
                      {item.preview && (
                        <p className="mt-2 text-sm leading-relaxed text-foreground">{item.preview}</p>
                      )}
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        Requested {timeAgo(item.created_at)}
                        {item.decided_at ? ` · decided ${timeAgo(item.decided_at)}` : ""}
                      </p>
                      {input && (
                        <button
                          type="button"
                          onClick={() => toggleExpanded(item.id)}
                          aria-expanded={open}
                          className="mt-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                        >
                          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                          {open ? "Hide input" : "Show input"}
                        </button>
                      )}
                      {open && input && (
                        <pre className="mt-2 max-h-72 overflow-auto rounded-lg border border-border/60 bg-secondary/40 p-3 text-[11px] leading-relaxed">
                          {input}
                        </pre>
                      )}
                    </div>
                    {item.status === "pending" && (
                      <div className="flex shrink-0 gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-destructive"
                          disabled={busy === item.id}
                          onClick={() => decide(item, "rejected")}
                          aria-label={`Reject ${item.tool_name}`}
                        >
                          <X className="h-3.5 w-3.5" /> Reject
                        </Button>
                        <Button
                          size="sm"
                          disabled={busy === item.id}
                          onClick={() => decide(item, "approved")}
                          aria-label={`Approve ${item.tool_name}`}
                        >
                          {busy === item.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                          Approve
                        </Button>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </PageContainer>
  );
}
