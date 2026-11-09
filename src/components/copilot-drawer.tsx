"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Sparkles, X, Send, Loader2, Wrench, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { useModal } from "@/components/ui/hooks";
import { COPILOT_PACKS, describePage, moduleFromPath, pageContextFrom, type CopilotModule, type PageContext } from "@/lib/copilot/modules";

/**
 * Page-aware copilot drawer.
 *
 * Opens with Cmd/Ctrl+J, the floating button, or a `javis:open-copilot`
 * window event (fired by the command palette). The module is inferred from
 * the current route so the API can scope tools and context to the page.
 */

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

/** Any page may pin the record type for the copilot with `data-copilot-type` on an element. */
function recordTypeOverride(): string | null {
  if (typeof document === "undefined") return null;
  const v = document.querySelector<HTMLElement>("[data-copilot-type]")?.dataset.copilotType?.trim();
  return v && /^[a-z][a-z0-9-]{0,39}$/.test(v) ? v : null;
}

const MODULE_LABEL = Object.fromEntries(Object.entries(COPILOT_PACKS).map(([k, v]) => [k, v.label])) as Record<CopilotModule, string>;

let idCounter = 0;
function nextId() {
  idCounter += 1;
  return `m${Date.now()}-${idCounter}`;
}

export function CopilotDrawer() {
  const pathname = usePathname();
  const pageModule = useMemo(() => moduleFromPath(pathname), [pathname]);
  const [page, setPage] = useState<PageContext>(() => pageContextFrom(pathname, ""));
  // Page context (query-string entity ids, `data-copilot-type`) is read in the browser after
  // render and refreshed on navigation and whenever the drawer opens, so `?ticket=` changes
  // made with history.replaceState are picked up without a Suspense boundary.
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const refresh = () => setPage(pageContextFrom(pathname, window.location.search, { recordType: recordTypeOverride() }));
    refresh();
    window.addEventListener("popstate", refresh);
    return () => window.removeEventListener("popstate", refresh);
  }, [pathname, open]);
  const recordId = page.params?.id;
  const pageLabel = describePage(page);

  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const close = useCallback(() => setOpen(false), []);

  // Keyboard shortcut + external open event. Escape, the focus trap and focus
  // restore are handled by useModal on the panel itself.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setOpen((o) => !o);
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
  }, []);

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
        body: JSON.stringify({ module: pageModule, message: text, recordId, history, page }),
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
  }, [input, busy, messages, pageModule, recordId, page]);

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
          className="fixed bottom-[max(1.25rem,env(safe-area-inset-bottom))] right-5 z-40 inline-flex h-11 w-11 touch-manipulation items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform hover:scale-105 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background motion-reduce:transition-none"
        >
          <Sparkles className="h-5 w-5" aria-hidden />
        </button>
      )}

      {open && (
        <CopilotPanel
          label={`${MODULE_LABEL[pageModule]} copilot`}
          onClose={close}
        >
            <header className="flex min-h-12 shrink-0 items-center gap-2 border-b border-border px-4 py-1.5">
              <Sparkles className="h-4 w-4 text-primary" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">Copilot</p>
                <p className="truncate text-[11px] text-muted-foreground">
                  {MODULE_LABEL[pageModule]}
                  {pageLabel ? ` · ${pageLabel}` : ""}
                </p>
              </div>
              <button
                type="button"
                onClick={close}
                aria-label="Close copilot"
                data-dialog-close=""
                className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-8 sm:w-8"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </header>

            <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 py-3" aria-live="polite" aria-relevant="additions">
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
                            <Wrench className="h-3 w-3 shrink-0" aria-hidden />
                            <span className="truncate">{t.name}</span>
                          </li>
                        ))}
                      </ul>
                    )}

                    {m.approvals && m.approvals.length > 0 && (
                      <div className="mt-2 flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px]">
                        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden />
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
                <div className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
                  <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
                  Thinking…
                </div>
              )}
            </div>

            <form
              className="shrink-0 border-t border-border p-3 [padding-bottom:max(0.75rem,env(safe-area-inset-bottom))]"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <div className="flex items-end gap-2">
                <textarea
                  ref={textareaRef}
                  data-autofocus=""
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={onTextareaKey}
                  rows={2}
                  maxLength={4000}
                  placeholder={`Ask the ${MODULE_LABEL[pageModule]} copilot…`}
                  aria-label="Message the copilot"
                  className="min-h-[44px] flex-1 resize-none rounded-md border border-border bg-background px-3 py-2 text-base outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring sm:text-sm"
                />
                <button
                  type="submit"
                  disabled={busy || !input.trim()}
                  aria-label="Send message"
                  className="inline-flex h-11 w-11 shrink-0 touch-manipulation items-center justify-center rounded-md bg-primary text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:opacity-50 sm:h-10 sm:w-10"
                >
                  <Send className="h-4 w-4" aria-hidden />
                </button>
              </div>
              <p className="mt-1.5 text-[11px] text-muted-foreground">Enter to send · Shift+Enter for a new line · Esc to close</p>
            </form>
        </CopilotPanel>
      )}
    </>
  );
}

/** Modal side panel: focus trapped inside, Escape closes, focus returns to the launcher, page scroll locked. */
function CopilotPanel({ label, onClose, children }: { label: string; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  useModal(ref, onClose);
  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/30 backdrop-blur-[1px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <aside
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className="flex h-full w-full max-w-md flex-col border-l border-border bg-card shadow-2xl outline-none"
      >
        {children}
      </aside>
    </div>
  );
}
