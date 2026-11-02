"use client";

import { memo, useCallback, useEffect, useId, useMemo, useState } from "react";
import { Bot, Check, ChevronDown, ChevronRight, Inbox, Loader2, Pencil, RefreshCw, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { Banner, Empty, ErrorState, Loading } from "@/components/ui/feedback";
import { Pill, StatusPill, type Tone } from "@/components/ui/pill";
import { TabPanel, Tabs } from "@/components/ui/tabs";
import { isAbortError, useAbortable } from "@/components/ui/hooks";
import { PageContainer } from "@/components/page-container";
import { timeAgo } from "@/lib/utils";

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

const TABS: ReadonlyArray<{ id: ApprovalStatus; label: string }> = [
  { id: "pending", label: "Pending" },
  { id: "approved", label: "Approved" },
  { id: "rejected", label: "Rejected" },
];

const STATUS_TONE: Record<string, Tone> = { pending: "warning", approved: "success", rejected: "danger", expired: "neutral" };

function prettyInput(raw: string | null): string {
  if (!raw) return "";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/** Parse the editor text into the object shape `PATCH /api/approvals/[id]` accepts for `edited_input`. */
function parseEdited(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (!text.trim()) return { ok: false, error: "Payload cannot be empty. Use {} for no input." };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `Not valid JSON: ${err instanceof Error ? err.message.replace(/^JSON\.parse: /, "") : "syntax error"}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'Payload must be a JSON object, like { "field": "value" }.' };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

/** Canonical form so "edited but identical" is detected regardless of whitespace or key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

type Notice = { tone: "success" | "error"; text: string };
type Decide = (item: Approval, decision: "approved" | "rejected", editedInput?: Record<string, unknown>) => Promise<string | null>;

export default function ApprovalsPage() {
  const [tab, setTab] = useState<ApprovalStatus>("pending");
  const [items, setItems] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const nextSignal = useAbortable();

  const load = useCallback(async () => {
    const signal = nextSignal();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/approvals?status=${tab}`, { cache: "no-store", signal });
      if (!res.ok) throw new Error(`Could not load approvals (${res.status})`);
      const d = await res.json();
      setItems(d.approvals ?? []);
    } catch (err) {
      if (isAbortError(err)) return;
      setError(err instanceof Error ? err.message : "Could not load approvals");
      setItems([]);
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [tab, nextSignal]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Resolves with an error string on failure so the row can keep its editor open and show it. */
  const decide = useCallback<Decide>(async (item, decision, editedInput) => {
    setBusy(item.id);
    setNotice(null);
    try {
      const res = await fetch(`/api/approvals/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editedInput ? { decision, edited_input: editedInput } : { decision }),
      });
      if (!res.ok) {
        const d: unknown = await res.json().catch(() => ({}));
        const apiError = d && typeof d === "object" && "error" in d && typeof d.error === "string" ? d.error : null;
        throw new Error(apiError ?? `Could not ${decision === "approved" ? "approve" : "reject"} (${res.status})`);
      }
      setItems((prev) => prev.filter((a) => a.id !== item.id));
      setNotice({
        tone: "success",
        text: `${item.tool_name} ${decision === "approved" ? (editedInput ? "approved with your edits" : "approved") : "rejected"}.`,
      });
      return null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Action failed";
      setNotice({ tone: "error", text: msg });
      return msg;
    } finally {
      setBusy(null);
    }
  }, []);

  const emptyTitle = tab === "pending" ? "Nothing waiting on you" : `No ${tab} approvals yet`;
  const emptyText = tab === "pending" ? "When an agent needs a decision it will show up here." : "Decisions you make on the Pending tab are kept here for history.";

  return (
    <PageContainer
      wide
      title="Approvals"
      description="Everything an agent or copilot wants to do that needs your OK. Approve to let it run, edit the payload first if needed, or reject to stop it."
      tooltip="Agents pause here before sending, moving or writing anything. If you change the proposed payload before approving, the agent runs your version and remembers the correction."
      className="pb-24"
      actions={
        <Button variant="outline" size="icon" touch onClick={() => void load()} disabled={loading} aria-label="Refresh approvals">
          {loading ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
        </Button>
      }
    >
      {notice && (
        <Banner tone={notice.tone} onDismiss={() => setNotice(null)}>
          {notice.text}
        </Banner>
      )}

      <Tabs id="approval-status" label="Approval status" tabs={TABS} value={tab} onChange={setTab} className="mb-4 w-fit" />

      <TabPanel id="approval-status" value={tab}>
        <section aria-label={`${tab} approvals`} aria-busy={loading || undefined}>
          {loading && items.length === 0 ? (
            <Loading label="Loading approvals…" className="rounded-xl border border-border bg-card py-12" />
          ) : error ? (
            <ErrorState message={error} onRetry={() => void load()} />
          ) : items.length === 0 ? (
            <Empty icon={<Inbox className="h-5 w-5" />} title={emptyTitle} text={emptyText} />
          ) : (
            <ul className="space-y-3">
              {items.map((item) => (
                <ApprovalRow key={item.id} item={item} busy={busy === item.id} onDecide={decide} />
              ))}
            </ul>
          )}
        </section>
      </TabPanel>
    </PageContainer>
  );
}

/* ───────────────────────── row ───────────────────────── */

const ApprovalRow = memo(function ApprovalRow({ item, busy, onDecide }: { item: Approval; busy: boolean; onDecide: Decide }) {
  const original = useMemo(() => prettyInput(item.input), [item.input]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(original);
  const [serverError, setServerError] = useState<string | null>(null);
  const inputId = useId();
  const pending = item.status === "pending";

  const parsed = useMemo(() => parseEdited(text), [text]);
  const originalCanonical = useMemo(() => {
    try {
      return canonical(JSON.parse(item.input ?? "{}"));
    } catch {
      return null;
    }
  }, [item.input]);
  const changed = parsed.ok && (originalCanonical === null || canonical(parsed.value) !== originalCanonical);
  const fieldError = parsed.ok ? serverError : parsed.error;
  const errorId = `${inputId}-error`;
  const hintId = `${inputId}-hint`;

  function startEdit() {
    setText(original);
    setServerError(null);
    setEditing(true);
    setOpen(true);
  }

  function cancelEdit() {
    setEditing(false);
    setServerError(null);
    setText(original);
  }

  async function approve() {
    if (!editing) {
      await onDecide(item, "approved");
      return;
    }
    if (!parsed.ok) return;
    const err = await onDecide(item, "approved", changed ? parsed.value : undefined);
    if (err) setServerError(err);
  }

  return (
    <li className="rounded-xl border border-border bg-card p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <code className="rounded bg-secondary px-1.5 py-0.5 text-xs font-medium [overflow-wrap:anywhere]">{item.tool_name}</code>
            <StatusPill status={item.status} map={STATUS_TONE} />
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Bot className="h-3 w-3" aria-hidden />
              {item.agent_name ?? (item.run_id ? "Agent" : "Copilot")}
            </span>
          </div>
          {item.preview && <p className="mt-2 text-sm leading-relaxed text-foreground [overflow-wrap:anywhere]">{item.preview}</p>}
          <p className="mt-1 text-xs text-muted-foreground">
            Requested <time dateTime={item.created_at}>{timeAgo(item.created_at)}</time>
            {item.decided_at ? (
              <>
                {" · decided "}
                <time dateTime={item.decided_at}>{timeAgo(item.decided_at)}</time>
              </>
            ) : null}
          </p>

          {(original || pending) && (
            <div className="mt-2 flex flex-wrap items-center gap-1">
              <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                aria-expanded={open}
                aria-controls={inputId}
                className="inline-flex min-h-11 items-center gap-1 rounded-md px-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8"
              >
                {open ? <ChevronDown className="h-3.5 w-3.5" aria-hidden /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden />}
                {open ? "Hide payload" : "Show payload"}
              </button>
              {pending && !editing && (
                <button
                  type="button"
                  onClick={startEdit}
                  disabled={busy}
                  className="inline-flex min-h-11 items-center gap-1 rounded-md px-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 sm:min-h-8"
                >
                  <Pencil className="h-3.5 w-3.5" aria-hidden /> Edit payload
                </button>
              )}
              {editing && changed && (
                <Pill tone="warning" className="ml-1">
                  Edited
                </Pill>
              )}
            </div>
          )}

          {open && !editing && (
            <pre
              id={inputId}
              tabIndex={0}
              aria-label={`Proposed input for ${item.tool_name}`}
              className="mt-2 max-h-72 overflow-auto rounded-lg border border-border/60 bg-secondary/40 p-3 text-xs leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {original || "{}"}
            </pre>
          )}

          {editing && (
            <div className="mt-2">
              <label htmlFor={inputId} className="mb-1 block text-xs font-medium">
                Payload for {item.tool_name}
              </label>
              <Textarea
                id={inputId}
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  setServerError(null);
                }}
                rows={Math.min(18, Math.max(6, text.split("\n").length + 1))}
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                aria-invalid={fieldError ? true : undefined}
                aria-describedby={[hintId, fieldError ? errorId : null].filter(Boolean).join(" ")}
                data-autofocus=""
                className="font-mono text-xs leading-relaxed sm:text-xs"
              />
              <p id={hintId} className="mt-1 text-xs text-muted-foreground">
                Must be a JSON object. It is checked against the tool&apos;s schema when you approve, and the agent learns from your change.
              </p>
              <div className="min-h-5" aria-live="polite">
                {fieldError && (
                  <p id={errorId} role="alert" className="mt-1 text-xs text-destructive [overflow-wrap:anywhere]">
                    {fieldError}
                  </p>
                )}
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button type="button" size="sm" variant="ghost" touch onClick={() => setText(original)} disabled={busy || text === original}>
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Reset
                </Button>
                <Button type="button" size="sm" variant="ghost" touch onClick={cancelEdit} disabled={busy}>
                  Cancel edit
                </Button>
              </div>
            </div>
          )}
        </div>

        {pending && (
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button size="sm" variant="outline" touch className="text-destructive" disabled={busy} onClick={() => void onDecide(item, "rejected")} aria-label={`Reject ${item.tool_name}`}>
              <X className="h-3.5 w-3.5" aria-hidden /> Reject
            </Button>
            <Button
              size="sm"
              touch
              disabled={busy || (editing && !parsed.ok)}
              onClick={() => void approve()}
              aria-label={`${editing && changed ? "Approve with edits" : "Approve"} ${item.tool_name}`}
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden /> : <Check className="h-3.5 w-3.5" aria-hidden />}
              {editing && changed ? "Approve with edits" : "Approve"}
            </Button>
          </div>
        )}
      </div>
    </li>
  );
});
