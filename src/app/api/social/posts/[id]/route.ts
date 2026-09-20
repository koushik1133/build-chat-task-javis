import { NextResponse } from "next/server";
import { requireUser } from "@/lib/supabase/server";
import { query } from "@/lib/dsql";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, { params }: Params) {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const userId = user.id;
  const { id } = await params;

  const rawBody = await req.json().catch(() => null);
  if (!rawBody || typeof rawBody !== "object") return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  const body = rawBody;
  const allowed = ["status", "caption", "image_url", "hashtags", "scheduled_at", "notes"];
  const fields = Object.keys(body).filter(k => allowed.includes(k));
  if (fields.length === 0) return NextResponse.json({ error: "No valid fields" }, { status: 400 });

  // When status=published, also set published_at via SQL NOW()
  const extraFields: string[] = [];
  if (body.status === "published" && !body.published_at) {
    extraFields.push("published_at = NOW()");
  }

  const setClauses = [
    ...fields.map((f, i) => `${f} = $${i + 3}`),
    "updated_at = NOW()",
    ...extraFields,
  ].join(", ");

  const values = [userId, id, ...fields.map((f: string) => (body as Record<string, unknown>)[f])];

  const [post] = await query(
    `UPDATE social_posts SET ${setClauses} WHERE user_id = $1 AND id = $2 RETURNING *`,
    values
  );

  return NextResponse.json({ post: post ?? null });
}

export async function DELETE(_req: Request, { params }: Params) {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const userId = user.id;
  const { id } = await params;

  await query("DELETE FROM social_posts WHERE id = $1 AND user_id = $2", [id, userId]);
  return NextResponse.json({ success: true });
}
