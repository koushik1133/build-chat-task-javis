import { NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { query } from "@/lib/dsql";

export async function GET() {
  let scope;
  try {
    scope = await requireScope({ area: "knowledge", edit: false });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const chats = await query(
    `SELECT id, title, updated_at
     FROM chats
     WHERE user_id = $1
     ORDER BY updated_at DESC
     LIMIT 50`,
    [scope.dataId]
  ).catch((err) => {
    console.error("[chats] list failed:", err);
    return [];
  });

  return NextResponse.json({ chats });
}
