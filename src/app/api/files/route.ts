import { NextResponse } from "next/server";
import { requireUser } from "@/lib/supabase/server";
import { query, queryOne } from "@/lib/dsql";
import { extractText, chunkText } from "@/lib/chunk";
import { upsertChunks, deleteFile as deleteFromVector } from "@/lib/pinecone";

export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_BYTES = 15 * 1024 * 1024;

export async function GET() {
  let user;
  try {
    ({ user } = await requireUser());
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const files = await query(
    `SELECT id, name, mime, size_bytes, chunk_count, created_at
     FROM files
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [user.id]
  ).catch((err) => {
    console.error("[files] list failed:", err);
    return [];
  });

  return NextResponse.json({ files });
}

export async function POST(req: Request) {
  let supabase, user;
  try {
    ({ supabase, user } = await requireUser());
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "no file" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "file too large (max 15MB)" }, { status: 413 });
  }

  // 1. Extract & chunk before any DB write — fail fast on bad files.
  let text = "";
  try {
    text = await extractText(file);
  } catch (e) {
    return NextResponse.json(
      { error: `parse failed: ${(e as Error).message}` },
      { status: 400 }
    );
  }
  const chunks = chunkText(text);
  if (chunks.length === 0) {
    return NextResponse.json({ error: "file appears empty" }, { status: 400 });
  }

  // 2. Upload raw file to Supabase Storage (blob storage, not a database).
  const storagePath = `${user.id}/${Date.now()}-${file.name}`;
  const buf = Buffer.from(await file.arrayBuffer());
  const { error: upErr } = await supabase.storage
    .from("files")
    .upload(storagePath, buf, { contentType: file.type, upsert: false });
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

  // 3. Write file metadata to Aurora DSQL.
  const row = await queryOne<{ id: string }>(
    `INSERT INTO files (user_id, name, mime, size_bytes, storage_path, chunk_count)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [user.id, file.name, file.type || null, file.size, storagePath, chunks.length]
  );
  if (!row) return NextResponse.json({ error: "insert failed" }, { status: 500 });

  // 4. Upsert vectors into Pinecone.
  await upsertChunks(
    user.id,
    chunks.map((chunk_text, i) => ({
      id: `${row.id}:${i}`,
      chunk_text,
      file_id: row.id,
      file_name: file.name,
      user_id: user.id,
    }))
  );

  return NextResponse.json({ id: row.id, name: file.name, chunks: chunks.length });
}

export async function DELETE(req: Request) {
  let supabase, user;
  try {
    ({ supabase, user } = await requireUser());
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await req.json();
  const file = await queryOne<{ id: string; storage_path: string | null }>(
    "SELECT id, storage_path FROM files WHERE id = $1 AND user_id = $2",
    [id, user.id]
  );
  if (!file) return NextResponse.json({ error: "not found" }, { status: 404 });

  await deleteFromVector(user.id, file.id).catch(() => {});
  if (file.storage_path) {
    await supabase.storage.from("files").remove([file.storage_path]).catch(() => {});
  }
  await query("DELETE FROM files WHERE id = $1 AND user_id = $2", [id, user.id]);

  return NextResponse.json({ ok: true });
}
