"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { PageContainer } from "@/components/page-container";
import { Button } from "@/components/ui/button";
import {
  MessageSquare,
  Bot,
  User,
  MessageCircle,
  Phone,
  Send,
  Loader2,
  FlaskConical,
  X,
  Clock,
  ArrowLeft,
} from "lucide-react";
import { cn, timeAgo } from "@/lib/utils";

type Channel = "whatsapp" | "sms" | "voice";

type Message = {
  role: "user" | "assistant";
  content: string;
  ts: string;
  pending?: boolean;
  simulated?: boolean;
  intent?: string;
};

type Conversation = {
  id: string;
  channel: Channel;
  from_number: string;
  messages: string; // JSON string
  updated_at: string;
};

function parseMessages(raw: unknown): Message[] {
  if (Array.isArray(raw)) return raw as Message[];
  if (typeof raw !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Message[]) : [];
  } catch {
    return [];
  }
}

function formatTime(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const CHANNEL_STYLES: Record<Channel, string> = {
  whatsapp: "bg-emerald-500/10 text-emerald-500",
  sms: "bg-blue-500/10 text-blue-500",
  voice: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
};

function ChannelChip({ channel, className }: { channel: Channel; className?: string }) {
  const style = CHANNEL_STYLES[channel] ?? CHANNEL_STYLES.sms;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded-full font-medium shrink-0 tracking-wide uppercase",
        style,
        className
      )}
    >
      {channel === "voice" && <Phone className="h-2.5 w-2.5" aria-hidden />}
      {channel}
    </span>
  );
}

export default function MessagingPage() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedConvId, setSelectedConvId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showSimulate, setShowSimulate] = useState(false);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);

  const fetchConversations = useCallback(async () => {
    try {
      const res = await fetch("/api/messaging").then((r) => r.json());
      if (Array.isArray(res.conversations)) {
        const list: Conversation[] = res.conversations;
        setConversations(list);
        if (list.length > 0) {
          setSelectedConvId((c) => c ?? list[0].id);
        }
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchConversations();
  }, [fetchConversations]);

  const selectedConv = conversations.find((c) => c.id === selectedConvId);
  const parsedMessages: Message[] = selectedConv ? parseMessages(selectedConv.messages) : [];
  const pendingCount = parsedMessages.filter((m) => m.pending).length;

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [selectedConvId, parsedMessages.length]);

  /** Merge an updated conversation into the list (and select it). */
  const upsertConversation = useCallback((conv: Conversation) => {
    setConversations((prev) => {
      const rest = prev.filter((c) => c.id !== conv.id);
      return [conv, ...rest];
    });
    setSelectedConvId(conv.id);
  }, []);

  async function sendReply(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedConv || !reply.trim()) return;
    setSending(true);
    setNotice(null);
    try {
      const res = await fetch("/api/messaging", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: selectedConv.id, text: reply.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? "Could not send that reply.");
      if (data.conversation) upsertConversation(data.conversation as Conversation);
      setReply("");
      if (data.simulated) {
        setNotice(
          data.error
            ? `Twilio send failed (${data.error}) — saved to the thread only.`
            : "No Twilio credentials on file — reply saved to the thread but not delivered."
        );
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not send that reply.");
    } finally {
      setSending(false);
    }
  }

  return (
    <PageContainer
      title="Messages"
      tooltip="View all incoming SMS, WhatsApp and voice conversations. The AI receptionist drafts replies; you approve or send."
      description="Omnichannel customer inbox with an AI receptionist that drafts replies."
      wide
    >
      <div className="mb-3 flex flex-wrap items-center justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => setShowSimulate(true)}>
          <FlaskConical className="mr-1.5 h-3.5 w-3.5" aria-hidden />
          Simulate inbound message
        </Button>
      </div>

      <div className="flex h-[calc(100vh-14rem)] min-h-[450px] overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        {/* Left List Pane */}
        <div
          className={cn(
            "w-full sm:w-80 sm:shrink-0 border-r border-border bg-card/50 flex-col min-h-0",
            selectedConv ? "hidden sm:flex" : "flex"
          )}
        >
          <div className="p-4 border-b border-border bg-muted/10 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Conversations</span>
            <span className="text-[10px] bg-secondary text-secondary-foreground rounded-full px-2 py-0.5 font-medium">
              {conversations.length} active
            </span>
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-border/60 scrollbar-thin">
            {conversations.map((conv) => {
              const messages = parseMessages(conv.messages);
              const lastMsg = messages[messages.length - 1];
              const hasPending = messages.some((m) => m.pending);
              const active = conv.id === selectedConvId;

              return (
                <button
                  key={conv.id}
                  onClick={() => setSelectedConvId(conv.id)}
                  className={cn(
                    "w-full text-left p-4 flex flex-col gap-1.5 transition-colors hover:bg-secondary/40",
                    active && "bg-secondary/70 hover:bg-secondary/70"
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-xs text-foreground tracking-tight truncate">
                      {conv.from_number}
                    </span>
                    <span className="text-[9px] text-muted-foreground whitespace-nowrap">
                      {timeAgo(conv.updated_at)}
                    </span>
                  </div>

                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs text-muted-foreground truncate flex-1">
                      {lastMsg?.content || "No messages yet"}
                    </p>
                    {hasPending && (
                      <span
                        className="text-[9px] px-1.5 py-0.5 rounded-full font-medium shrink-0 bg-amber-500/10 text-amber-600 dark:text-amber-400"
                        title="A drafted reply is waiting for approval"
                      >
                        Pending
                      </span>
                    )}
                    <ChannelChip channel={conv.channel} />
                  </div>
                </button>
              );
            })}

            {conversations.length === 0 && !loading && (
              <div className="text-center py-12 px-4 text-xs text-muted-foreground">
                <MessageSquare className="h-6 w-6 text-muted-foreground/40 mx-auto mb-3" />
                <p className="font-medium text-muted-foreground/80 mb-1">No messages yet</p>
                <p className="text-[10px] text-muted-foreground/60 leading-relaxed">
                  When customers text or call your Twilio number, conversations appear here. Try
                  &ldquo;Simulate inbound message&rdquo; to see the receptionist in action.
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Right Detail Pane */}
        <div className={cn("flex-1 flex-col bg-muted/5 min-w-0 h-full", selectedConv ? "flex" : "hidden sm:flex")}>
          {selectedConv ? (
            <>
              {/* Header */}
              <div className="p-3 sm:p-4 border-b border-border bg-card flex items-center justify-between gap-3 shrink-0">
                <div className="flex items-center gap-2 min-w-0">
                  <button
                    type="button"
                    onClick={() => setSelectedConvId(null)}
                    aria-label="Back to conversations"
                    className="sm:hidden rounded-md p-1 hover:bg-secondary"
                  >
                    <ArrowLeft className="h-4 w-4" aria-hidden />
                  </button>
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-foreground flex items-center gap-2 flex-wrap">
                      <span className="truncate">{selectedConv.from_number}</span>
                      <ChannelChip channel={selectedConv.channel} />
                    </h3>
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      Last active: {new Date(selectedConv.updated_at).toLocaleString()}
                    </p>
                  </div>
                </div>

                {pendingCount > 0 ? (
                  <Link
                    href="/approvals"
                    className="flex items-center gap-1.5 bg-amber-500/10 text-amber-600 dark:text-amber-400 text-xs px-2.5 py-1 rounded-full font-medium hover:bg-amber-500/20 shrink-0"
                  >
                    <Clock className="h-3.5 w-3.5" aria-hidden />
                    <span className="hidden sm:inline">{pendingCount} awaiting approval</span>
                    <span className="sm:hidden">{pendingCount}</span>
                  </Link>
                ) : (
                  <div className="hidden sm:flex items-center gap-1.5 bg-violet-500/10 text-violet-500 dark:bg-violet-500/20 text-xs px-2.5 py-1 rounded-full font-medium shrink-0">
                    <Bot className="h-3.5 w-3.5" aria-hidden />
                    <span>AI Receptionist</span>
                  </div>
                )}
              </div>

              {/* Chat Window */}
              <div ref={threadRef} className="flex-1 overflow-y-auto p-4 space-y-4 scrollbar-thin bg-zinc-50/50 dark:bg-zinc-950/20">
                {parsedMessages.map((msg, i) => {
                  const isAssistant = msg.role === "assistant";
                  return (
                    <div
                      key={i}
                      className={cn(
                        "flex items-start gap-2.5 max-w-[85%] sm:max-w-[80%]",
                        isAssistant ? "ml-auto flex-row-reverse" : "mr-auto"
                      )}
                    >
                      <div
                        className={cn(
                          "h-7 w-7 rounded-full flex items-center justify-center shrink-0 border border-border/80 text-xs",
                          isAssistant
                            ? "bg-violet-500/10 text-violet-500 border-violet-500/25"
                            : "bg-secondary text-muted-foreground"
                        )}
                      >
                        {isAssistant ? <Bot className="h-3.5 w-3.5" /> : <User className="h-3.5 w-3.5" />}
                      </div>

                      <div className="min-w-0">
                        <div
                          className={cn(
                            "rounded-2xl px-3.5 py-2 text-sm shadow-sm whitespace-pre-wrap leading-relaxed break-words",
                            isAssistant
                              ? msg.pending
                                ? "bg-card text-foreground border border-dashed border-amber-500/50 rounded-tr-none"
                                : "bg-primary text-primary-foreground rounded-tr-none"
                              : "bg-card text-foreground border border-border rounded-tl-none"
                          )}
                        >
                          {msg.content}
                          <div
                            className={cn(
                              "text-[8px] mt-1 text-right opacity-60",
                              isAssistant && !msg.pending ? "text-primary-foreground/90" : "text-muted-foreground"
                            )}
                          >
                            {formatTime(msg.ts)}
                          </div>
                        </div>
                        {msg.pending && (
                          <div className="mt-1 flex items-center justify-end gap-2 text-[10px]">
                            <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 font-medium text-amber-600 dark:text-amber-400">
                              <Clock className="h-3 w-3" aria-hidden />
                              Draft — not sent
                            </span>
                            <Link href="/approvals" className="text-primary underline-offset-2 hover:underline">
                              Approve in inbox
                            </Link>
                          </div>
                        )}
                        {msg.simulated && !msg.pending && (
                          <div className="mt-1 text-right text-[10px] text-muted-foreground">Saved only (no Twilio)</div>
                        )}
                      </div>
                    </div>
                  );
                })}
                {parsedMessages.length === 0 && (
                  <p className="text-center text-xs text-muted-foreground py-8">No messages in this thread yet.</p>
                )}
              </div>

              {/* Composer */}
              <form onSubmit={sendReply} className="p-3 bg-card border-t border-border shrink-0">
                {notice && (
                  <p role="status" className="mb-2 text-[11px] text-amber-600 dark:text-amber-400">{notice}</p>
                )}
                <div className="flex items-end gap-2">
                  <label htmlFor="reply-composer" className="sr-only">Reply</label>
                  <textarea
                    id="reply-composer"
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        e.currentTarget.form?.requestSubmit();
                      }
                    }}
                    rows={2}
                    maxLength={1600}
                    placeholder={
                      selectedConv.channel === "voice"
                        ? "Add a note to this call thread…"
                        : `Reply via ${selectedConv.channel.toUpperCase()}…`
                    }
                    className="flex-1 resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                  <Button type="submit" size="sm" disabled={sending || !reply.trim()} aria-label="Send reply">
                    {sending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Send className="h-4 w-4" aria-hidden />}
                  </Button>
                </div>
                <p className="mt-1.5 text-[10px] text-muted-foreground">
                  Enter to send, Shift+Enter for a new line. Replies go out through your Twilio number when it is connected.
                </p>
              </form>
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
              <MessageCircle className="h-8 w-8 text-muted-foreground/30 mb-3" />
              <p className="text-sm font-semibold text-muted-foreground/80 mb-1">Select a conversation</p>
              <p className="text-xs text-muted-foreground/50 max-w-xs leading-relaxed">
                Click a contact in the list on the left to see conversation history and replies.
              </p>
            </div>
          )}
        </div>
      </div>

      {showSimulate && (
        <SimulateDialog
          onClose={() => setShowSimulate(false)}
          onDone={(conv) => {
            upsertConversation(conv);
            setShowSimulate(false);
          }}
        />
      )}
    </PageContainer>
  );
}

function SimulateDialog({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (conv: Conversation) => void;
}) {
  const [fromNumber, setFromNumber] = useState("+15550100200");
  const [channel, setChannel] = useState<Channel>("sms");
  const [text, setText] = useState("Hi, I'd like to book an appointment for next week. What do you have available?");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/messaging/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromNumber: fromNumber.trim(), channel, text: text.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? "Simulation failed.");
      onDone(data.conversation as Conversation);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Simulation failed.");
    } finally {
      setBusy(false);
    }
  }

  const inputClass =
    "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="simulate-title"
      onClick={onClose}
    >
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[90vh] w-full max-w-md space-y-4 overflow-y-auto rounded-xl border border-border bg-card p-6"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="simulate-title" className="text-lg font-semibold">Simulate an inbound message</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Runs the AI receptionist exactly as a real Twilio webhook would — no phone number required.
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="opacity-70 hover:opacity-100">
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        {err && (
          <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
            {err}
          </p>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="sim-from" className="mb-1 block text-sm font-medium">From number</label>
            <input id="sim-from" required value={fromNumber} onChange={(e) => setFromNumber(e.target.value)} className={inputClass} />
          </div>
          <div>
            <label htmlFor="sim-channel" className="mb-1 block text-sm font-medium">Channel</label>
            <select id="sim-channel" value={channel} onChange={(e) => setChannel(e.target.value as Channel)} className={inputClass}>
              <option value="sms">SMS</option>
              <option value="whatsapp">WhatsApp</option>
              <option value="voice">Voice (transcript)</option>
            </select>
          </div>
        </div>

        <div>
          <label htmlFor="sim-text" className="mb-1 block text-sm font-medium">Message</label>
          <textarea id="sim-text" required rows={4} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} className={cn(inputClass, "resize-none")} />
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy || !text.trim() || !fromNumber.trim()}>
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
            {busy ? "Running…" : "Send to receptionist"}
          </Button>
        </div>
      </form>
    </div>
  );
}
