import { NextResponse } from "next/server";
import { requireUser } from "@/lib/supabase/server";
import { queryOne, query } from "@/lib/dsql";
import { getMessages, deleteMessages } from "@/lib/dynamodb";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  let user;
  try {
    ({ user } = await requireUser());
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;

  // Verify ownership in Aurora DSQL
  const chat = await queryOne(
    "SELECT id, title FROM chats WHERE id = $1 AND user_id = $2",
    [id, user.id]
  );
  if (!chat) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Message bodies from DynamoDB
  const ddbMessages = await getMessages(id, 100).catch(() => []);
  const messages = ddbMessages.map((m) => ({
    id: m.msgId,
    role: m.role,
    content: m.content,
    created_at: m.createdAt,
  }));

  return NextResponse.json({ chat, messages });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  let user;
  try {
    ({ user } = await requireUser());
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;

  await Promise.all([
    query("DELETE FROM chats WHERE id = $1 AND user_id = $2", [id, user.id]),
    deleteMessages(id).catch(() => {}),
  ]);

  return NextResponse.json({ ok: true });
}
