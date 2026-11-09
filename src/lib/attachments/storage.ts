import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { createAdminClient } from "@/lib/supabase/server";

/**
 * Blob backend for attachments.
 *
 * Production: Supabase Storage, private bucket `attachments`, signed URLs
 * (10 minutes) minted with the admin client. Development without storage:
 * a local directory (ATTACHMENTS_LOCAL_DIR, default `.data/attachments`) —
 * never enabled in production, and only when Supabase is not configured or
 * the env var is set explicitly.
 */

export const ATTACHMENTS_BUCKET = "attachments";
export const SIGNED_URL_TTL_SECONDS = 10 * 60;

export type StorageMode = "supabase" | "local";

export function storageMode(env: NodeJS.ProcessEnv = process.env): StorageMode {
  if (env.NODE_ENV === "production") return "supabase";
  if (env.ATTACHMENTS_LOCAL_DIR) return "local";
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return "local";
  return "supabase";
}

function localRoot(): string {
  return resolve(process.cwd(), process.env.ATTACHMENTS_LOCAL_DIR || ".data/attachments");
}

/** Storage keys are built server-side from ids, but guard against traversal anyway. */
function localPath(storagePath: string): string {
  const root = localRoot();
  const full = resolve(root, storagePath);
  if (full !== root && !full.startsWith(root + sep)) throw new Error("invalid storage path");
  return full;
}

export interface StoredObject {
  bytes: Buffer;
  contentType: string;
}

let bucketChecked = false;
async function ensureBucket(): Promise<void> {
  if (bucketChecked) return;
  const supabase = createAdminClient();
  try {
    const { data: buckets } = await supabase.storage.listBuckets();
    if (!buckets?.some((b) => b.name === ATTACHMENTS_BUCKET)) await supabase.storage.createBucket(ATTACHMENTS_BUCKET, { public: false });
    bucketChecked = true;
  } catch (err) {
    console.warn("[attachments] bucket check failed:", err);
  }
}

export async function putObject(storagePath: string, bytes: Buffer, contentType: string): Promise<void> {
  if (storageMode() === "local") {
    const p = localPath(storagePath);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, bytes);
    return;
  }
  await ensureBucket();
  const supabase = createAdminClient();
  const { error } = await supabase.storage.from(ATTACHMENTS_BUCKET).upload(storagePath, bytes, { contentType, upsert: false });
  if (error) throw new Error(`storage upload failed: ${error.message}`);
}

export async function getObject(storagePath: string, contentType: string): Promise<StoredObject | null> {
  if (storageMode() === "local") {
    try {
      return { bytes: await readFile(localPath(storagePath)), contentType };
    } catch {
      return null;
    }
  }
  const supabase = createAdminClient();
  const { data, error } = await supabase.storage.from(ATTACHMENTS_BUCKET).download(storagePath);
  if (error || !data) return null;
  return { bytes: Buffer.from(await data.arrayBuffer()), contentType };
}

/** Signed URL for a private object, or null in local mode (caller streams the bytes instead). */
export async function signedUrl(storagePath: string, downloadName?: string): Promise<string | null> {
  if (storageMode() === "local") return null;
  const supabase = createAdminClient();
  const { data, error } = await supabase.storage.from(ATTACHMENTS_BUCKET).createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS, downloadName ? { download: downloadName } : undefined);
  if (error || !data?.signedUrl) throw new Error(`signed url failed: ${error?.message ?? "unknown"}`);
  return data.signedUrl;
}

export async function removeObject(storagePath: string): Promise<void> {
  if (storageMode() === "local") {
    await rm(localPath(storagePath), { force: true }).catch(() => undefined);
    return;
  }
  const supabase = createAdminClient();
  await supabase.storage.from(ATTACHMENTS_BUCKET).remove([storagePath]).catch(() => undefined);
}

/** `<dataId>/<entity_kind>/<entity_id>/<id>` — tenant-first so a prefix listing never crosses orgs. */
export function objectKey(dataId: string, entityKind: string, entityId: string, id: string): string {
  return join(dataId, entityKind, entityId, id).split(sep).join("/");
}
