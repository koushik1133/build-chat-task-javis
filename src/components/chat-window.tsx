"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Send, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { Markdown } from "@/components/markdown";
import { KERNELHUB_TAGLINE } from "@/lib/brand";
import {
  buildChatSuggestions,
  chatEmptySubtitle,
  chatPlaceholder,
  type BusinessDna,
} from "@/lib/chat-suggestions";

type Msg = { id?: string; role: "user" | "assistant"; content: string };

export function ChatWindow({
  chatId,
  initialMessages = [],
}: {
  chatId: string | null;
  initialMessages?: Msg[];
}) {
  const router = useRouter();
  const [messages, setMessages] = useState<Msg[]>(initialMessages);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [profile, setProfile] = useState<BusinessDna | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);

  const suggestions = useMemo(() => buildChatSuggestions(profile), [profile]);
  const placeholder = useMemo(() => chatPlaceholder(profile), [profile]);

  useEffect(() => {
    fetch("/api/onboarding")
      .then((r) => r.json())
      .then((d) => {
        if (d.profile) setProfile(d.profile);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    setMessages(initialMessages);
    // initialMessages is a new array each render; key on chatId only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);

  useEffect(() => {
    scrollerRef.current?.scrollTo({
      top: scrollerRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  async function send() {
    const text = input.trim();
    if (!text || streaming) return;
    setInput("");
    setStreaming(true);
    setMessages((m) => [
      ...m,
      { role: "user", content: text },
      { role: "assistant", content: "" },
    ]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chatId, message: text }),
      });
      if (!res.ok || !res.body) {
        const err = await res.text().catch(() => "");
        throw new Error(err || `HTTP ${res.status}`);
      }
      const newId = res.headers.get("X-Chat-Id");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const piece = decoder.decode(value, { stream: true });
        setMessages((m) => {
          const copy = [...m];
          copy[copy.length - 1] = {
            role: "assistant",
            content: copy[copy.length - 1].content + piece,
          };
          return copy;
        });
      }
      // First-message case: server created the chat — slot us into its URL
      // so reloads show history and the sidebar highlights correctly.
      if (!chatId && newId) router.replace(`/chat/${newId}`);
    } catch (e) {
      setMessages((m) => {
        const copy = [...m];
        copy[copy.length - 1] = {
          role: "assistant",
          content: `_Error: ${(e as Error).message}_`,
        };
        return copy;
      });
    } finally {
      setStreaming(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollerRef} className="scrollbar-thin flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-6">
        {messages.length === 0 ? (
          <EmptyState profile={profile} suggestions={suggestions} onPick={(p) => setInput(p)} />
        ) : (
          <div className="mx-auto max-w-3xl space-y-6">
            {messages.map((m, i) => (
              <Bubble key={i} role={m.role} content={m.content} streaming={streaming && i === messages.length - 1 && m.role === "assistant"} />
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-border bg-background/80 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={placeholder}
            rows={2}
            className="resize-none"
          />
          <Button onClick={send} disabled={streaming || !input.trim()} size="icon">
            {streaming ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
        <p className="mx-auto mt-2 max-w-3xl text-center text-[11px] text-muted-foreground">
          Business AI grounded in your Business DNA and uploaded files. Shift+Enter for newline.
        </p>
      </div>
    </div>
  );
}

function Bubble({
  role,
  content,
  streaming,
}: {
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
}) {
  const mine = role === "user";
  return (
    <div className={mine ? "flex justify-end" : "flex justify-start"}>
      <div
        className={
          mine
            ? "max-w-[85%] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm text-primary-foreground shadow-sm"
            : "max-w-[95%] rounded-2xl rounded-bl-md border border-border bg-card px-4 py-3 text-sm shadow-sm"
        }
      >
        {mine ? (
          <p className="whitespace-pre-wrap">{content}</p>
        ) : content ? (
          <Markdown>{content}</Markdown>
        ) : (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        )}
        {streaming && content && (
          <span className="ml-1 inline-block h-3 w-1.5 animate-pulse bg-foreground/70 align-baseline" />
        )}
      </div>
    </div>
  );
}

function EmptyState({
  profile,
  suggestions,
  onPick,
}: {
  profile: BusinessDna | null;
  suggestions: string[];
  onPick: (p: string) => void;
}) {
  return (
    <div className="mx-auto flex max-w-2xl flex-col items-center px-4 pt-8 text-center sm:px-6 sm:pt-12 lg:pt-16">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 ring-1 ring-primary/30">
        <Sparkles className="h-6 w-6 text-primary" />
      </div>
      <h1 className="text-2xl font-semibold tracking-tight">
        <span className="gradient-text">KernelHub</span>
      </h1>
      <p className="mt-2 max-w-md text-sm text-muted-foreground">{KERNELHUB_TAGLINE}</p>
      <p className="mt-3 text-xs text-muted-foreground/80">
        {chatEmptySubtitle(profile)}
      </p>
      <div className="mt-6 grid w-full grid-cols-1 gap-2 sm:grid-cols-2">
        {suggestions.map((s) => (
          <button
            key={s}
            onClick={() => onPick(s)}
            className="rounded-lg border border-border bg-card/40 p-3 text-left text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}
