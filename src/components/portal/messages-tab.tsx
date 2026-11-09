"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, MessageSquare, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { Banner, SkeletonList } from "@/components/ui/feedback";
import { PORTAL_MESSAGE_MAX } from "@/lib/portal-rules";
import { cn } from "@/lib/utils";
import { Section } from "./portal-ui";


interface Msg {
  id: string;
  direction: "in" | "out";
  body: string;
  created_at: string;
}

const POLL_MS = 15_000;

/** Message thread with the team. Polls every 15s while the page is visible; staff replies are marked read on open. */
export function MessagesTab({ token, onRead }: { token: string; onRead: () => void }) {
  const [msgs, setMsgs] = useState<Msg[] | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cursor = useRef<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const merge = useCallback((incoming: Msg[]) => {
    if (incoming.length === 0) return;
    setMsgs((prev) => {
      const seen = new Set((prev ?? []).map((m) => m.id));
      const next = [...(prev ?? []), ...incoming.filter((m) => !seen.has(m.id))];
      cursor.current = next[next.length - 1]?.created_at ?? cursor.current;
      return next;
    });
  }, []);

  const poll = useCallback(
    async (initial = false) => {
      try {
        const qs = new URLSearchParams({ markRead: "1" });
        if (cursor.current) qs.set("since", cursor.current);
        const r = await fetch(`/api/p/portal/${token}/messages?${qs}`);
        if (!r.ok) throw new Error("Could not load messages.");
        const d = (await r.json()) as { messages: Msg[] };
        if (initial) {
          setMsgs(d.messages);
          cursor.current = d.messages[d.messages.length - 1]?.created_at ?? null;
          onRead();
        } else merge(d.messages);
        setError(null);
      } catch (e) {
        if (initial) setMsgs([]);
        setError(e instanceof Error ? e.message : "Could not load messages.");
      }
    },
    [token, merge, onRead]
  );

  useEffect(() => {
    void poll(true);
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void poll();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [poll]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [msgs?.length]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/p/portal/${token}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: text }) });
      if (r.status === 429) throw new Error("You're sending messages too quickly. Please wait a moment.");
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { message?: string }).message ?? "Could not send your message.");
      merge([((await r.json()) as { message: Msg }).message]);
      setText("");
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : "Could not send your message.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section icon={MessageSquare} title="Messages" id="msg-h">
      {error && <Banner tone="error">{error}</Banner>}
      {!msgs ? (
        <SkeletonList count={3} itemClassName="h-12" label="Loading messages…" />
      ) : (
        <div className="max-h-[50vh] min-h-24 space-y-2 overflow-y-auto pr-1" role="log" aria-live="polite" aria-label="Conversation with the team">
          {msgs.length === 0 && <p className="text-sm text-muted-foreground">No messages yet. Send us a note below and we will reply here.</p>}
          {msgs.map((m) => (
            <div key={m.id} className={cn("max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm [overflow-wrap:anywhere]", m.direction === "in" ? "ml-auto bg-primary text-primary-foreground" : "border border-border bg-secondary/40")}>
              {m.body}
              <div className="mt-1 text-[10px] opacity-70">{new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(m.created_at))}</div>
            </div>
          ))}
          <div ref={endRef} />
        </div>
      )}
      <form onSubmit={send} className="mt-3 flex items-end gap-2">
        <div className="flex-1">
          <label htmlFor="portal-msg" className="sr-only">Your message</label>
          <Textarea id="portal-msg" rows={2} value={text} maxLength={PORTAL_MESSAGE_MAX} onChange={(e) => setText(e.target.value)} placeholder="Write a message…" />
          <p className="mt-1 text-right text-[11px] text-muted-foreground">{text.length}/{PORTAL_MESSAGE_MAX}</p>
        </div>
        <Button type="submit" touch disabled={busy || !text.trim()} aria-label="Send message" className="mb-5">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Send className="h-4 w-4" aria-hidden />}
        </Button>
      </form>
    </Section>
  );
}
