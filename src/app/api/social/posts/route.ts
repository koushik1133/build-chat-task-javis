import { NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { query } from "@/lib/dsql";
import { randomUUID } from "crypto";

export async function GET(req: Request) {
  let scope;
  try { scope = await requireScope({ area: "social", edit: false }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const userId = scope.dataId;

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status");
  const platform = searchParams.get("platform");

  let sql = "SELECT * FROM social_posts WHERE user_id = $1";
  const params: unknown[] = [userId];
  let idx = 2;

  if (status) {
    sql += ` AND status = $${idx++}`;
    params.push(status);
  }
  if (platform) {
    sql += ` AND platform = $${idx++}`;
    params.push(platform);
  }

  sql += " ORDER BY COALESCE(scheduled_at, created_at) ASC";

  const posts = await query(sql, params);
  return NextResponse.json({ posts });
}

export async function POST(req: Request) {
  let scope;
  try { scope = await requireScope({ area: "social", edit: true }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const userId = scope.dataId;

  const rawBody = await req.json().catch(() => null);
  if (!rawBody || typeof rawBody !== "object") return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  const body = rawBody;
  const { brand_id, platform, content_type = "post", caption, image_url, hashtags, scheduled_at } = body;

  if (!platform || !caption) {
    return NextResponse.json({ error: "platform and caption required" }, { status: 400 });
  }

  const id = randomUUID();
  const [post] = await query(
    `INSERT INTO social_posts (id, user_id, brand_id, platform, content_type, caption, image_url, hashtags, scheduled_at, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft') RETURNING *`,
    [id, userId, brand_id ?? null, platform, content_type, caption, image_url ?? null, hashtags ?? null, scheduled_at ?? null]
  );

  return NextResponse.json({ post });
}
