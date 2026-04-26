import { NextResponse } from "next/server";
import { requireUser } from "@/lib/supabase/server";
import { extractText, chunkText } from "@/lib/chunk";
import { upsertChunks, deleteFile as deleteFromVector } from "@/lib/pinecone";

export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_BYTES = 15 * 1024 * 1024;

export async function GET() {
  let supabase, user;
  try {
    ({ supabase, user } = await requireUser());
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { data } = await supabase
    .from("files")
    .select("id,name,mime,size_bytes,chunk_count,created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });
  return NextResponse.json({ files: data ?? [] });
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

  // 2. Upload raw file to Storage (user-scoped folder for RLS).
  const storagePath = `${user.id}/${Date.now()}-${file.name}`;
  const buf = Buffer.from(await file.arrayBuffer());
  const { error: upErr } = await supabase.storage
    .from("files")
    .upload(storagePath, buf, { contentType: file.type, upsert: false });
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

  // 3. Row in `files` first so we have an id to reference in vector records.
  const { data: row, error: insErr } = await supabase
    .from("files")
    .insert({
      user_id: user.id,
      name: file.name,
      mime: file.type || null,
      size_bytes: file.size,
      storage_path: storagePath,
      chunk_count: chunks.length,
    })
    .select("id")
    .single();
  if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });

  // 4. Upsert vectors. Pinecone embeds via integrated inference.
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
  const { data: file } = await supabase
    .from("files")
    .select("id,storage_path")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();
  if (!file) return NextResponse.json({ error: "not found" }, { status: 404 });

  await deleteFromVector(user.id, file.id).catch(() => {});
  if (file.storage_path) {
    await supabase.storage.from("files").remove([file.storage_path]).catch(() => {});
  }
  await supabase.from("files").delete().eq("id", id).eq("user_id", user.id);

  return NextResponse.json({ ok: true });
}
