import { notFound } from "next/navigation";
import { requireUser } from "@/lib/supabase/server";
import { queryOne } from "@/lib/dsql";
import { getMessages } from "@/lib/dynamodb";
import { ChatWindow } from "@/components/chat-window";

export default async function ChatByIdPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let user;
  try {
    ({ user } = await requireUser());
  } catch {
    return null;
  }

  // Verify chat ownership via Aurora DSQL
  const chat = await queryOne(
    "SELECT id FROM chats WHERE id = $1 AND user_id = $2",
    [id, user.id]
  );
  if (!chat) notFound();

  // Load message bodies from DynamoDB
  const ddbMessages = await getMessages(id, 100).catch(() => []);

  return (
    <ChatWindow
      chatId={id}
      initialMessages={ddbMessages.map((m) => ({
        id: m.msgId,
        role: m.role as "user" | "assistant",
        content: m.content,
      }))}
    />
  );
}
