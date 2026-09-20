import { NextResponse } from "next/server";
import { requireUser } from "@/lib/supabase/server";
import { query } from "@/lib/dsql";
import { randomUUID } from "crypto";
import { z } from "zod";
import { toChannelId } from "@/lib/channels/registry";

export async function GET(req: Request) {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  // Explicit column list: SELECT * previously returned access_token/refresh_token.
  const platform = toChannelId(new URL(req.url).searchParams.get("platform"));
  const base = `SELECT id, brand_id, platform, handle, display_name, avatar_url,
                       connected, created_at, (access_token IS NOT NULL) AS has_token
                FROM social_accounts WHERE user_id = $1`;

  const accounts = platform
    ? await query(`${base} AND platform = $2 ORDER BY created_at DESC`, [user.id, platform])
    : await query(`${base} ORDER BY created_at DESC`, [user.id]);

  return NextResponse.json({ accounts });
}

export async function POST(req: Request) {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  const rawBody = await req.json().catch(() => null);
  if (!rawBody || typeof rawBody !== "object") {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const Body = z.object({
    platform: z.string().trim().min(1),
    handle: z.string().trim().min(1).max(120),
    display_name: z.string().trim().max(120).optional().nullable(),
    brand_id: z.string().trim().max(64).optional().nullable(),
  });

  const parsed = Body.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: "platform and handle required" }, { status: 400 });
  }

  // Only registry-known platforms may be stored: an unrenderable channel must
  // never be able to enter the sidebar.
  const platform = toChannelId(parsed.data.platform);
  if (!platform) {
    return NextResponse.json({ error: "Unsupported platform" }, { status: 400 });
  }
  const { handle, display_name, brand_id } = parsed.data;

  const id = randomUUID();
  const [account] = await query(
    `INSERT INTO social_accounts (id, user_id, brand_id, platform, handle, display_name, connected)
     VALUES ($1,$2,$3,$4,$5,$6,TRUE)
     RETURNING id, brand_id, platform, handle, display_name, avatar_url, connected, created_at`,
    [id, user.id, brand_id ?? null, platform, handle, display_name ?? handle]
  );
  return NextResponse.json({ account });
}

export async function DELETE(req: Request) {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  await query(
    "DELETE FROM social_accounts WHERE id = $1 AND user_id = $2",
    [id, user.id]
  );
  return NextResponse.json({ success: true });
}
