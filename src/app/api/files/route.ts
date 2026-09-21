import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { query, queryOne } from "@/lib/dsql";
import { extractText, chunkText } from "@/lib/chunk";
import { upsertChunks, deleteFile as deleteFromVector } from "@/lib/pinecone";

export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_BYTES = 15 * 1024 * 1024;

export async function GET() {
  let scope;
  try {
    scope = await requireScope({ area: "knowledge", edit: false });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const files = await query(
    `SELECT id, name, mime, size_bytes, chunk_count, created_at
     FROM files
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [scope.dataId]
  ).catch((err) => {
    console.error("[files] list failed:", err);
    return [];
  });

  return NextResponse.json({ files });
}

export async function POST(req: Request) {
  let scope;
  try {
    scope = await requireScope({ area: "knowledge", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const supabase = createAdminClient();

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
    console.error("[files] extract failed:", e);
    return NextResponse.json(
      { error: "Could not parse that file" },
      { status: 400 }
    );
  }
  const chunks = chunkText(text);
  if (chunks.length === 0) {
    return NextResponse.json({ error: "file appears empty" }, { status: 400 });
  }

  // 2. Upload raw file to Supabase Storage (blob storage, not a database).
  const storagePath = `${scope.dataId}/${Date.now()}-${file.name}`;
  const buf = Buffer.from(await file.arrayBuffer());

  // Ensure files bucket exists
  try {
    const adminSupabase = createAdminClient();
    const { data: buckets } = await adminSupabase.storage.listBuckets();
    if (!buckets?.some((b) => b.name === "files")) {
      await adminSupabase.storage.createBucket("files", { public: false });
    }
  } catch (bucketErr) {
    console.warn("[files] Failed to list/create files bucket with admin client:", bucketErr);
  }

  const { error: upErr } = await supabase.storage
    .from("files")
    .upload(storagePath, buf, { contentType: file.type, upsert: false });
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

  // 3. Write file metadata to Aurora DSQL.
  const row = await queryOne<{ id: string }>(
    `INSERT INTO files (user_id, name, mime, size_bytes, storage_path, chunk_count)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [scope.dataId, file.name, file.type || null, file.size, storagePath, chunks.length]
  );
  if (!row) return NextResponse.json({ error: "insert failed" }, { status: 500 });

  // 4. Upsert vectors into Pinecone.
  await upsertChunks(
    scope.dataId,
    chunks.map((chunk_text, i) => ({
      id: `${row.id}:${i}`,
      chunk_text,
      file_id: row.id,
      file_name: file.name,
      user_id: scope.dataId,
    }))
  );

  return NextResponse.json({ id: row.id, name: file.name, chunks: chunks.length });
}

export async function DELETE(req: Request) {
  let scope;
  try {
    scope = await requireScope({ area: "knowledge", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const supabase = createAdminClient();

  const rawBody = await req.json().catch(() => null);
  if (!rawBody || typeof rawBody !== "object") return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  const { id } = rawBody;
  const file = await queryOne<{ id: string; storage_path: string | null }>(
    "SELECT id, storage_path FROM files WHERE id = $1 AND user_id = $2",
    [id, scope.dataId]
  );
  if (!file) return NextResponse.json({ error: "not found" }, { status: 404 });

  await deleteFromVector(scope.dataId, file.id).catch(() => {});
  if (file.storage_path) {
    await supabase.storage.from("files").remove([file.storage_path]).catch(() => {});
  }
  await query("DELETE FROM files WHERE id = $1 AND user_id = $2", [id, scope.dataId]);

  return NextResponse.json({ ok: true });
}
