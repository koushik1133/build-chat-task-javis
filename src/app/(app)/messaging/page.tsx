"use client";

import { useCallback, useEffect, useState } from "react";
import { PageContainer } from "@/components/page-container";
import { MessageSquare, Bot, User, MessageCircle } from "lucide-react";
import { cn, timeAgo } from "@/lib/utils";

type Message = {
  role: "user" | "assistant";
  content: string;
  ts: string;
};

type Conversation = {
  id: string;
  channel: "whatsapp" | "sms";
  from_number: string;
  messages: string; // JSON string
  updated_at: string;
};

function parseMessages(raw: string): Message[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Message[]) : [];
  } catch {
    return [];
  }
}

export default function MessagingPage() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedConvId, setSelectedConvId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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

  return (
    <PageContainer
      title="Messages"
      tooltip="View all incoming SMS and WhatsApp messages from customers. AI can auto-reply on your behalf."
      description="Omnichannel customer inbox with optional AI auto-response assistant."
      wide
    >
      <div className="flex h-[calc(100vh-12rem)] min-h-[450px] overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        {/* Left List Pane */}
        <div className="w-full sm:w-80 sm:shrink-0 border-r border-border bg-card/50 flex flex-col min-h-0">
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
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-xs text-foreground tracking-tight">
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
                    <span
                      className={cn(
                        "text-[9px] px-1.5 py-0.5 rounded-full font-medium shrink-0 tracking-wide uppercase",
                        conv.channel === "whatsapp"
                          ? "bg-emerald-500/10 text-emerald-500"
                          : "bg-blue-500/10 text-blue-500"
                      )}
                    >
                      {conv.channel}
                    </span>
                  </div>
                </button>
              );
            })}

            {conversations.length === 0 && !loading && (
              <div className="text-center py-12 px-4 text-xs text-muted-foreground">
                <MessageSquare className="h-6 w-6 text-muted-foreground/40 mx-auto mb-3" />
                <p className="font-medium text-muted-foreground/80 mb-1">No messages yet</p>
                <p className="text-[10px] text-muted-foreground/60 leading-relaxed">
                  When customers text your Twilio number, conversations will appear here.
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Right Detail Pane */}
        <div className="flex-1 flex flex-col bg-muted/5 min-w-0 h-full">
          {selectedConv ? (
            <>
              {/* Header */}
              <div className="p-4 border-b border-border bg-card flex items-center justify-between shrink-0">
                <div>
                  <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                    {selectedConv.from_number}
                    <span
                      className={cn(
                        "text-[9px] px-1.5 py-0.5 rounded-full font-medium tracking-wide uppercase",
                        selectedConv.channel === "whatsapp"
                          ? "bg-emerald-500/10 text-emerald-500"
                          : "bg-blue-500/10 text-blue-500"
                      )}
                    >
                      {selectedConv.channel}
                    </span>
                  </h3>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    Last active: {new Date(selectedConv.updated_at).toLocaleString()}
                  </p>
                </div>

                <div className="flex items-center gap-1.5 bg-violet-500/10 text-violet-500 dark:bg-violet-500/20 text-xs px-2.5 py-1 rounded-full font-medium">
                  <Bot className="h-3.5 w-3.5" />
                  <span>AI Auto-Reply Active</span>
                </div>
              </div>

              {/* Chat Window */}
              <div className="flex-1 overflow-y-auto p-4 space-y-4 scrollbar-thin bg-zinc-50/50 dark:bg-zinc-950/20">
                {parsedMessages.map((msg, i) => {
                  const isAssistant = msg.role === "assistant";
                  return (
                    <div
                      key={i}
                      className={cn(
                        "flex items-start gap-2.5 max-w-[80%]",
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

                      <div
                        className={cn(
                          "rounded-2xl px-3.5 py-2 text-sm shadow-sm whitespace-pre-wrap leading-relaxed",
                          isAssistant
                            ? "bg-primary text-primary-foreground rounded-tr-none"
                            : "bg-card text-foreground border border-border rounded-tl-none"
                        )}
                      >
                        {msg.content}
                        <div
                          className={cn(
                            "text-[8px] mt-1 text-right opacity-60",
                            isAssistant ? "text-primary-foreground/90" : "text-muted-foreground"
                          )}
                        >
                          {new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Footer Note */}
              <div className="p-3 bg-card border-t border-border text-center text-[10px] text-muted-foreground shrink-0 leading-relaxed">
                This chat is managed automatically by your AI Agent Assistant.
              </div>
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
    </PageContainer>
  );
}
