import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ChatWindow } from "@/components/chat-window";

export default async function ChatByIdPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: chat } = await supabase
    .from("chats")
    .select("id")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();
  if (!chat) notFound();

  const { data: messages } = await supabase
    .from("messages")
    .select("id,role,content,created_at")
    .eq("chat_id", id)
    .order("created_at", { ascending: true });

  return (
    <ChatWindow
      chatId={id}
      initialMessages={(messages ?? []).map((m) => ({
        id: m.id,
        role: m.role as "user" | "assistant",
        content: m.content,
      }))}
    />
  );
}
