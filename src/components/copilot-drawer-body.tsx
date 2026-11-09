"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Sparkles, X, Send, Loader2, Wrench, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Page-aware copilot drawer.
 *
 * Opens with Cmd/Ctrl+J, the floating button, or a `javis:open-copilot`
 * window event (fired by the command palette). The module is inferred from
 * the current route so the API can scope tools and context to the page.
 */

type CopilotModule = "crm" | "leads" | "production" | "social" | "strategy" | "tasks" | "ads" | "agents" | "general";

interface ToolCallChip {
  name: string;
  summary: string;
  ok: boolean;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: ToolCallChip[];
  approvals?: string[];
  error?: boolean;
}

export const OPEN_COPILOT_EVENT = "javis:open-copilot";

function moduleFromPath(pathname: string | null): CopilotModule {
  const p = pathname ?? "";
  if (p.startsWith("/crm")) return "crm";
  if (p.startsWith("/leads")) return "leads";
  if (p.startsWith("/production")) return "production";
  if (p.startsWith("/social") || p.startsWith("/channels")) return "social";
  if (p.startsWith("/strategy")) return "strategy";
  if (p.startsWith("/tasks")) return "tasks";
  if (p.startsWith("/ads")) return "ads";
  if (p.startsWith("/agents")) return "agents";
  return "general";
}

/** Second path segment when it looks like a record id (uuid-ish or long token). */
function recordIdFromPath(pathname: string | null): string | undefined {
  const parts = (pathname ?? "").split("/").filter(Boolean);
  const candidate = parts[1];
  if (!candidate) return undefined;
  return /^[0-9a-f-]{20,}$/i.test(candidate) ? candidate : undefined;
}

const MODULE_LABEL: Record<CopilotModule, string> = {
  crm: "CRM",
  leads: "Leads",
  production: "Production",
  social: "Social",
  strategy: "Strategy",
  tasks: "Tasks",
  ads: "Ads",
  agents: "Agents",
  general: "Workspace",
};

let idCounter = 0;
function nextId() {
  idCounter += 1;
  return `m${Date.now()}-${idCounter}`;
}

export function CopilotDrawer() {
  const pathname = usePathname();
  const pageModule = useMemo(() => moduleFromPath(pathname), [pathname]);
  const recordId = useMemo(() => recordIdFromPath(pathname), [pathname]);

  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const close = useCallback(() => setOpen(false), []);

  // Keyboard shortcut + external open event.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape" && open) {
        e.preventDefault();
        close();
      }
    }
    function onOpen() {
      setOpen(true);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_COPILOT_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_COPILOT_EVENT, onOpen);
    };
  }, [open, close]);

  // Focus the textarea when opening.
  useEffect(() => {
    if (open) {
      const t = window.setTimeout(() => textareaRef.current?.focus(), 30);
      return () => window.clearTimeout(t);
    }
  }, [open]);

  // Keep the newest message in view.
  useEffect(() => {
    if (open && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, busy, open]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    const userMsg: Message = { id: nextId(), role: "user", content: text };
    const history = messages
      .filter((m) => !m.error)
      .slice(-10)
      .map((m) => ({ role: m.role, content: m.content }));
    setMessages((prev) => [...prev, userMsg]);
    setBusy(true);

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch("/api/copilot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ module: pageModule, message: text, recordId, history }),
        signal: controller.signal,
      });
      const body = (await res.json().catch(() => null)) as
        | { text?: string; toolCalls?: ToolCallChip[]; approvals?: string[]; error?: string }
        | null;

      if (!res.ok) {
        const msg =
          (res.status === 402 || res.status === 503) && body?.error
            ? body.error
            : body?.error ?? `Request failed (${res.status}).`;
        setMessages((prev) => [...prev, { id: nextId(), role: "assistant", content: msg, error: true }]);
        return;
      }

      setMessages((prev) => [
        ...prev,
        {
          id: nextId(),
          role: "assistant",
          content: body?.text ?? "",
          toolCalls: body?.toolCalls ?? [],
          approvals: body?.approvals ?? [],
        },
      ]);
    } catch (err) {
      if ((err as Error)?.name === "AbortError") return;
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: "assistant", content: "Network error — the copilot could not be reached.", error: true },
      ]);
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  }, [input, busy, messages, pageModule, recordId]);

  function onTextareaKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <>
      {/* Floating launcher */}
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open copilot (Cmd/Ctrl+J)"
          title="Ask copilot (⌘J)"
          className="fixed bottom-5 right-5 z-40 inline-flex h-11 w-11 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform hover:scale-105 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Sparkles className="h-5 w-5" />
        </button>
      )}

      {open && (
        <>
          <button
            type="button"
            aria-label="Close copilot"
            className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[1px]"
            onClick={close}
          />
          <aside
            role="dialog"
            aria-modal="true"
            aria-label={`${MODULE_LABEL[pageModule]} copilot`}
            className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-border bg-card shadow-2xl"
          >
            <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
              <Sparkles className="h-4 w-4 text-primary" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">Copilot</p>
                <p className="truncate text-[11px] text-muted-foreground">
                  {MODULE_LABEL[pageModule]}
                  {recordId ? " · this record" : ""}
                </p>
              </div>
              <button
                type="button"
                onClick={close}
                aria-label="Close"
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </header>

            <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
              {messages.length === 0 && (
                <div className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
                  Ask about what is on this page, or tell me what to do — for example &ldquo;summarise my new leads&rdquo;
                  or &ldquo;create a card for the landing-page redesign&rdquo;. Actions that send anything externally are
                  queued for your approval.
                </div>
              )}

              {messages.map((m) => (
                <div key={m.id} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
                  <div
                    className={cn(
                      "max-w-[90%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words",
                      m.role === "user"
                        ? "bg-primary text-primary-foreground"
                        : m.error
                          ? "border border-destructive/40 bg-destructive/10 text-foreground"
                          : "bg-secondary text-foreground"
                    )}
                  >
                    {m.content}

                    {m.toolCalls && m.toolCalls.length > 0 && (
                      <ul className="mt-2 flex flex-wrap gap-1">
                        {m.toolCalls.map((t, i) => (
                          <li
                            key={`${m.id}-t${i}`}
                            title={t.summary}
                            className={cn(
                              "inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[10px]",
                              t.ok ? "border-border bg-card text-muted-foreground" : "border-destructive/40 text-destructive"
                            )}
                          >
                            <Wrench className="h-3 w-3 shrink-0" />
                            <span className="truncate">{t.name}</span>
                          </li>
                        ))}
                      </ul>
                    )}

                    {m.approvals && m.approvals.length > 0 && (
                      <div className="mt-2 flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px]">
                        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
                        <span>
                          {m.approvals.length} action{m.approvals.length === 1 ? "" : "s"} waiting for your approval.{" "}
                          <Link href="/approvals" onClick={close} className="font-medium underline underline-offset-2">
                            Review in Approvals
                          </Link>
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              ))}

              {busy && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Thinking…
                </div>
              )}
            </div>

            <form
              className="shrink-0 border-t border-border p-3"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <div className="flex items-end gap-2">
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={onTextareaKey}
                  rows={2}
                  maxLength={4000}
                  placeholder={`Ask the ${MODULE_LABEL[pageModule]} copilot…`}
                  aria-label="Message the copilot"
                  className="min-h-[44px] flex-1 resize-none rounded-md border border-border bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
                />
                <button
                  type="submit"
                  disabled={busy || !input.trim()}
                  aria-label="Send"
                  className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground disabled:opacity-50"
                >
                  <Send className="h-4 w-4" />
                </button>
              </div>
              <p className="mt-1.5 text-[10px] text-muted-foreground">Enter to send · Shift+Enter for a new line · Esc to close</p>
            </form>
          </aside>
        </>
      )}
    </>
  );
}
