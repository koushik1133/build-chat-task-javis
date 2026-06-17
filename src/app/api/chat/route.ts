import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/supabase/server";
import { searchChunks } from "@/lib/pinecone";
import { streamChat, completeJson, type ChatMessage } from "@/lib/llm";
import { SYSTEM_BASE, buildContextBlock, TASK_EXTRACTOR_SYS } from "@/lib/prompts";
import { putMessage, getMessages } from "@/lib/dynamodb";
import { queryOne, query } from "@/lib/dsql";

export const runtime = "nodejs";
export const maxDuration = 60;

const Body = z.object({
  chatId: z.string().uuid().nullable().optional(),
  message: z.string().min(1).max(8000),
});

export async function POST(req: Request) {
  let user;
  try {
    ({ user } = await requireUser());
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const { message } = parsed.data;
  let chatId = parsed.data.chatId ?? null;

  // 1. Ensure a chat metadata row in Aurora DSQL.
  if (!chatId) {
    const title = message.slice(0, 60).replace(/\s+/g, " ").trim() || "New chat";
    const row = await queryOne<{ id: string }>(
      "INSERT INTO chats (user_id, title) VALUES ($1, $2) RETURNING id",
      [user.id, title]
    );
    if (!row) return NextResponse.json({ error: "failed to create chat" }, { status: 500 });
    chatId = row.id;
  }

  const now = new Date().toISOString();
  const userMsgId = crypto.randomUUID();
  const resolvedChatId = chatId as string;

  // 2. Persist the user turn in DynamoDB (high-throughput message store).
  //    Supabase retains the chat metadata row; DynamoDB owns the message bodies.
  await putMessage({
    msgId: userMsgId,
    chatId: resolvedChatId,
    userId: user.id,
    role: "user",
    content: message,
    createdAt: now,
  });

  // 3. Pull last 10 turns from DynamoDB + RAG hits from Pinecone in parallel.
  const [history, chunks] = await Promise.all([
    getMessages(resolvedChatId, 10).catch(() => []),
    searchChunks(user.id, message, 5).catch(() => []),
  ]);

  const context = buildContextBlock(chunks);

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_BASE + (context ? `\n\n${context}` : "") },
    ...history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
  ];

  // 4. Call Groq — return a clean JSON error instead of a raw 500 if it fails.
  let stream: Awaited<ReturnType<typeof streamChat>>;
  try {
    stream = await streamChat(messages);
  } catch (e) {
    const msg = (e as Error).message ?? "LLM call failed";
    console.error("[chat] streamChat error:", msg);
    return NextResponse.json({ error: msg }, { status: 502 });
  }

  // 5. Stream raw text chunks. Persist the full assistant turn at end-of-stream.
  const encoder = new TextEncoder();
  const finalChatId = resolvedChatId;
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
          const assistantMsgId = crypto.randomUUID();
          const assistantAt = new Date().toISOString();
          // Persist assistant reply to DynamoDB
          await putMessage({
            msgId: assistantMsgId,
            chatId: finalChatId,
            userId: user.id,
            role: "assistant",
            content: full,
            createdAt: assistantAt,
          });
          // Update chat updated_at in Aurora DSQL
          await query("UPDATE chats SET updated_at = $1 WHERE id = $2", [assistantAt, finalChatId]);
        }
        controller.close();

        // Fire-and-forget task extraction from the user's message.
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
            // Insert extracted tasks into Aurora DSQL
            for (const title of tasks) {
              await query(
                "INSERT INTO tasks (user_id, chat_id, title) VALUES ($1, $2, $3)",
                [user.id, finalChatId, title]
              );
            }
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
