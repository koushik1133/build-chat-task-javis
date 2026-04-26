import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/supabase/server";
import { searchChunks } from "@/lib/pinecone";
import { streamChat, completeJson, type ChatMessage } from "@/lib/llm";
import { SYSTEM_BASE, buildContextBlock, TASK_EXTRACTOR_SYS } from "@/lib/prompts";

export const runtime = "nodejs";
export const maxDuration = 60;

const Body = z.object({
  chatId: z.string().uuid().nullable().optional(),
  message: z.string().min(1).max(8000),
});

export async function POST(req: Request) {
  let supabase, user;
  try {
    ({ supabase, user } = await requireUser());
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const { message } = parsed.data;
  let chatId = parsed.data.chatId ?? null;

  // 1. Ensure a chat row, derive a title from the first user message.
  if (!chatId) {
    const title = message.slice(0, 60).replace(/\s+/g, " ").trim() || "New chat";
    const { data, error } = await supabase
      .from("chats")
      .insert({ user_id: user.id, title })
      .select("id")
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    chatId = data.id;
  }

  // 2. Persist the user turn before the model call so it survives a stream abort.
  await supabase.from("messages").insert({
    chat_id: chatId,
    user_id: user.id,
    role: "user",
    content: message,
  });

  // 3. Pull last 10 turns + RAG hits in parallel.
  const [{ data: history }, chunks] = await Promise.all([
    supabase
      .from("messages")
      .select("role,content")
      .eq("chat_id", chatId)
      .order("created_at", { ascending: false })
      .limit(10),
    searchChunks(user.id, message, 5).catch(() => []),
  ]);

  const past = (history ?? []).reverse() as { role: "user" | "assistant"; content: string }[];
  const context = buildContextBlock(chunks);

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_BASE + (context ? `\n\n${context}` : "") },
    ...past,
  ];

  const stream = await streamChat(messages);

  // 4. Stream raw text chunks. Persist the full assistant turn at end-of-stream.
  const encoder = new TextEncoder();
  const finalChatId = chatId as string;
  const readable = new ReadableStream({
    async start(controller) {
      let full = "";
      try {
        for await (const chunk of stream) {
          const delta = chunk.choices?.[0]?.delta?.content ?? "";
          if (delta) {
            full += delta;
            controller.enqueue(encoder.encode(delta));
          }
        }
      } catch (e) {
        controller.enqueue(encoder.encode(`\n\n[stream error: ${(e as Error).message}]`));
      } finally {
        if (full) {
          await supabase.from("messages").insert({
            chat_id: finalChatId,
            user_id: user.id,
            role: "assistant",
            content: full,
          });
          await supabase
            .from("chats")
            .update({ updated_at: new Date().toISOString() })
            .eq("id", finalChatId);
        }
        controller.close();

        // Fire-and-forget task extraction. Errors here must never fail the chat.
        completeJson<{ tasks: string[] }>(
          [
            { role: "system", content: TASK_EXTRACTOR_SYS },
            { role: "user", content: message },
          ],
          `{"tasks": string[] }`
        )
          .then(async (parsed) => {
            const tasks = (parsed?.tasks ?? []).filter((t) => t && t.length < 120);
            if (tasks.length === 0) return;
            await supabase.from("tasks").insert(
              tasks.map((title) => ({ user_id: user.id, chat_id: finalChatId, title }))
            );
          })
          .catch(() => {});
      }
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Chat-Id": finalChatId,
    },
  });
}
